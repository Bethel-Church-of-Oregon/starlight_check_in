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
-- check_ins
-- grade is denormalised on purpose so historical attendance reports stay
-- correct after a child moves up a grade.
--
-- Time: checked_in_at is timestamptz — an absolute instant, stored as UTC and
-- independent of any server's timezone. session_date is the church's local
-- calendar date (app setting general.timezone, default America/Los_Angeles),
-- so attendance is grouped by the Sunday it happened on locally even when the
-- UTC timestamp has already rolled over to Monday.
-- --------------------------------------------------------------------------
create table if not exists check_ins (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references students (id) on delete cascade,
  session_date   date not null,
  security_code  text not null,
  grade          text,
  checked_in_at  timestamptz not null default now(),
  checked_in_by  text,
  reprints       int not null default 0,
  created_at     timestamptz not null default now()
);

-- Removed features, dropped from databases created before they went:
--  * check-out — the app records check-in only; pickup is checked by
--    volunteers against the code on the name tag
--  * services (회차) — one check-in per child per day, no service choice.
--    service_id references services, so it must go before the table does.
alter table check_ins drop column if exists checked_out_at;
alter table check_ins drop column if exists checked_out_by;
alter table check_ins drop column if exists service_id;
alter table check_ins drop column if exists service_name;
drop table if exists services;

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
-- Retired: the cloud print queue.
-- Printing now goes iPad → Raspberry Pi bridge on the LAN directly. These two
-- tables only ever held in-flight label bytes and agent heartbeats, and the
-- polling that used them kept Neon's compute awake around the clock.
-- --------------------------------------------------------------------------
drop table if exists print_jobs;
drop table if exists print_agents;
