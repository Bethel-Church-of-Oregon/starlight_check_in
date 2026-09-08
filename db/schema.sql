-- ===========================================================================
-- Bethel Starlight Check-in System — schema
-- Safe to run repeatedly (idempotent).
-- ===========================================================================

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- students
-- Korean-American church: some kids only have an English name, a few only a
-- Korean one. Both columns always exist; the CHECK just makes sure at least
-- one of them is filled in. `grade` is required.
-- --------------------------------------------------------------------------
create table if not exists students (
  id                 uuid primary key default gen_random_uuid(),
  korean_name        text,
  english_name       text,
  grade              text not null,
  gender             text,
  birthdate          date,
  school             text,
  guardian_name      text,
  guardian_phone     text,
  guardian_phone_alt text,
  allergies          text,
  medical_notes      text,
  notes              text,
  code               text,              -- optional barcode / member id
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint students_name_present check (
    coalesce(nullif(btrim(korean_name), ''), nullif(btrim(english_name), '')) is not null
  )
);

create unique index if not exists students_code_key
  on students (code) where code is not null and btrim(code) <> '';

-- One lowercased haystack so the live search is a single LIKE.
alter table students
  add column if not exists search_text text
  generated always as (
    lower(
      coalesce(korean_name, '') || ' ' ||
      coalesce(english_name, '') || ' ' ||
      coalesce(code, '') || ' ' ||
      coalesce(guardian_name, '') || ' ' ||
      coalesce(guardian_phone, '') || ' ' ||
      coalesce(guardian_phone_alt, '') || ' ' ||
      regexp_replace(coalesce(guardian_phone, '') || coalesce(guardian_phone_alt, ''), '[^0-9]', '', 'g')
    )
  ) stored;

do $$
begin
  create extension if not exists pg_trgm;
  create index if not exists students_search_trgm
    on students using gin (search_text gin_trgm_ops);
exception when others then
  -- pg_trgm unavailable: a plain scan is fine at this scale.
  null;
end $$;

create index if not exists students_active_grade on students (active, grade);

-- --------------------------------------------------------------------------
-- services (회차) — e.g. "1부 9:30", "2부 11:00"
-- --------------------------------------------------------------------------
create table if not exists services (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  start_time time,
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- check_ins
-- service_name / grade are denormalised on purpose so historical attendance
-- reports stay correct after a service is renamed or a child moves up a grade.
-- --------------------------------------------------------------------------
create table if not exists check_ins (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references students (id) on delete cascade,
  service_id     uuid references services (id) on delete set null,
  service_name   text,
  session_date   date not null,
  security_code  text not null,
  grade          text,
  checked_in_at  timestamptz not null default now(),
  checked_in_by  text,
  checked_out_at timestamptz,
  checked_out_by text,
  reprints       int not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists check_ins_session on check_ins (session_date desc, checked_in_at desc);
create index if not exists check_ins_student on check_ins (student_id, session_date desc);
create index if not exists check_ins_code on check_ins (session_date, security_code);

-- --------------------------------------------------------------------------
-- app_settings — single-row-per-key jsonb bag
-- --------------------------------------------------------------------------
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- print_jobs — `data` is a base64 Brother raster command stream, ready to be
-- written straight to the printer's port 9100. The LAN agent never has to
-- understand the protocol.
-- --------------------------------------------------------------------------
create table if not exists print_jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null default 'label',   -- label | test | reprint
  check_in_id  uuid references check_ins (id) on delete set null,
  label        text,                            -- human-readable description
  data         text not null,
  byte_length  int not null default 0,
  status       text not null default 'queued',  -- queued | claimed | done | error | canceled
  attempts     int not null default 0,
  agent_id     text,
  error        text,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  completed_at timestamptz
);

-- Set when a job fails, so a paper-out condition does not burn all three
-- attempts in the same second — the volunteer needs time to load a new roll.
alter table print_jobs add column if not exists retry_after timestamptz;

create index if not exists print_jobs_queue on print_jobs (status, retry_after, created_at);
create index if not exists print_jobs_recent on print_jobs (created_at desc);

-- --------------------------------------------------------------------------
-- print_agents — heartbeat so the footer printer icon can show online/offline
-- --------------------------------------------------------------------------
create table if not exists print_agents (
  id           text primary key,
  name         text,
  printer_host text,
  version      text,
  last_seen_at timestamptz not null default now(),
  last_error   text
);
