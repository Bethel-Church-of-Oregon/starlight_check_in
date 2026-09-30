/**
 * Database integration checks.
 *
 * Mirrors the exact SQL the route handlers issue and runs it against a real
 * Postgres, because several of these are the kind of query that type-checks
 * fine and then fails at runtime: a generated search column, a LATERAL join,
 * cascades, and jsonb upserts.
 *
 *   docker run -d --name starlight-pg -e POSTGRES_PASSWORD=dev \
 *     -e POSTGRES_DB=starlight -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL="postgresql://postgres:dev@localhost:55432/starlight?sslmode=disable" \
 *     node scripts/migrate.mjs && node tests/sql.test.mjs
 */
import assert from 'node:assert'
import pg from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
})

let pass = 0
const results = []
async function t(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
    pass++
  } catch (error) {
    console.error(`  FAIL  ${name}\n        ${error.message}`)
    results.push(name)
  }
}

const q = (text, params) => client.query(text, params)

await client.connect()

// A clean slate for the tables this file writes to.
await q(`delete from check_ins`)
await q(`delete from students where english_name like 'ZZTest%'`)

const TODAY = '2026-09-06'

// --------------------------------------------------------------------------
await t('students insert accepts an English-only child', async () => {
  const { rows } = await q(
    `insert into students (korean_name, english_name, grade, guardian_phone)
     values ($1, $2, $3, $4) returning id, search_text`,
    [null, 'ZZTest Ashley Howard', '2nd', '(360) 555-0142']
  )
  assert.ok(rows[0].id)
  assert.ok(rows[0].search_text.includes('zztest ashley howard'), 'name is searchable')
  assert.ok(rows[0].search_text.includes('3605550142'), 'digits-only phone is searchable')
})

await t('students insert accepts a Korean-only child', async () => {
  const { rows } = await q(
    `insert into students (korean_name, english_name, grade) values ($1, $2, $3) returning id`,
    ['정하윤', null, '6th']
  )
  assert.ok(rows[0].id)
})

// --- /api/students/search -------------------------------------------------
const searchSql = `
  select s.id, s.korean_name, s.english_name, s.grade, s.gender, s.code,
         s.guardian_name, s.guardian_phone, s.allergies, s.medical_notes,
         t.security_code as today_code,
         t.service_name  as today_service,
         t.checked_in_at as today_checked_in_at
  from students s
  left join lateral (
    select security_code, service_name, checked_in_at
    from check_ins c
    where c.student_id = s.id and c.session_date = $3::date
    order by c.checked_in_at desc
    limit 1
  ) t on true
  where s.active
    and s.search_text like $1
  order by
    case when s.search_text like $2 then 0 else 1 end,
    coalesce(nullif(btrim(s.korean_name), ''), nullif(btrim(s.english_name), '')),
    s.english_name
  limit 25`

await t('search matches a Hangul prefix', async () => {
  const { rows } = await q(searchSql, ['%김%', '김%', TODAY])
  assert.ok(rows.some((r) => r.korean_name === '김민준'), 'finds 김민준 by surname')
})

await t('search matches an English substring, case-insensitively', async () => {
  const { rows } = await q(searchSql, ['%ashley%', 'ashley%', TODAY])
  assert.ok(rows.some((r) => r.english_name?.includes('Ashley')))
})

await t('search matches a phone number typed without punctuation', async () => {
  const { rows } = await q(searchSql, ['%3605550142%', '3605550142%', TODAY])
  assert.strictEqual(rows.length, 1)
  assert.ok(rows[0].english_name.includes('Ashley'))
})

await t('search ranks prefix matches ahead of substring matches', async () => {
  const { rows } = await q(searchSql, ['%kim%', 'kim%', TODAY])
  assert.ok(rows.length >= 1, 'at least the seeded Minjun Kim')
})

// --- /api/checkins --------------------------------------------------------
const { rows: pick } = await q(
  `select id, grade from students where korean_name = '김민준' limit 1`
)
const studentId = pick[0].id
const { rows: svc } = await q(`select id, name from services order by sort_order limit 1`)
const serviceId = svc[0].id

await t('check-in insert stores a denormalised grade and service name', async () => {
  const { rows } = await q(
    `insert into check_ins (student_id, service_id, service_name, session_date,
                            security_code, grade, checked_in_by)
     values ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7)
     returning *`,
    [studentId, serviceId, svc[0].name, TODAY, 'H7KM', pick[0].grade, null]
  )
  assert.strictEqual(rows[0].security_code, 'H7KM')
  assert.strictEqual(rows[0].service_name, svc[0].name)
  assert.strictEqual(rows[0].grade, '3rd')
  assert.strictEqual(rows[0].reprints, 0)
})

await t('the duplicate lookup finds the same-service check-in for today', async () => {
  const { rows } = await q(
    `select * from check_ins
     where student_id = $1::uuid
       and session_date = $2::date
       and coalesce(service_id::text, '') = $3
     order by checked_in_at desc limit 1`,
    [studentId, TODAY, serviceId]
  )
  assert.strictEqual(rows.length, 1, 'found the existing check-in')
})

await t('the duplicate lookup treats a null service as its own slot', async () => {
  const { rows } = await q(
    `select * from check_ins
     where student_id = $1::uuid
       and session_date = $2::date
       and coalesce(service_id::text, '') = $3
     order by checked_in_at desc limit 1`,
    [studentId, TODAY, '']
  )
  assert.strictEqual(rows.length, 0, 'a null-service check-in is separate from a service one')
})

await t('reprint bumps the counter instead of inserting a second row', async () => {
  const { rows } = await q(
    `update check_ins set reprints = reprints + 1
     where student_id = $1::uuid and session_date = $2::date
     returning reprints`,
    [studentId, TODAY]
  )
  assert.strictEqual(rows[0].reprints, 1)
  const { rows: count } = await q(
    `select count(*)::int as n from check_ins where student_id = $1::uuid and session_date = $2::date`,
    [studentId, TODAY]
  )
  assert.strictEqual(count[0].n, 1)
})

await t('security codes in use today can be collected for collision checks', async () => {
  const { rows } = await q(`select security_code from check_ins where session_date = $1::date`, [
    TODAY,
  ])
  assert.deepStrictEqual(rows.map((r) => r.security_code), ['H7KM'])
})

// --- /api/checkins/today --------------------------------------------------
await t('today view joins students and aggregates by grade', async () => {
  const { rows } = await q(
    `select c.id, c.security_code, c.service_name, c.grade,
            c.checked_in_at, c.checked_out_at, c.checked_out_by, c.reprints,
            s.id as student_id, s.korean_name, s.english_name
     from check_ins c
     join students s on s.id = c.student_id
     where c.session_date = $1::date
     order by c.checked_in_at desc`,
    [TODAY]
  )
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].korean_name, '김민준')

  const { rows: byGrade } = await q(
    `select coalesce(nullif(btrim(grade), ''), '(none)') as grade, count(*)::int as count
     from check_ins where session_date = $1::date group by 1 order by 1`,
    [TODAY]
  )
  assert.deepStrictEqual(byGrade, [{ grade: '3rd', count: 1 }])
})

await t('check-out and undo both work', async () => {
  const { rows: ci } = await q(`select id from check_ins where session_date = $1::date`, [TODAY])
  const id = ci[0].id
  const out = await q(
    `update check_ins set checked_out_at = now(), checked_out_by = $2 where id = $1::uuid returning checked_out_at`,
    [id, 'Mom']
  )
  assert.ok(out.rows[0].checked_out_at)
  const undo = await q(
    `update check_ins set checked_out_at = null, checked_out_by = null where id = $1::uuid returning checked_out_at`,
    [id]
  )
  assert.strictEqual(undo.rows[0].checked_out_at, null)
})

// --- retired tables ------------------------------------------------------
await t('the retired print queue tables are gone', async () => {
  const { rows } = await q(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name in ('print_jobs', 'print_agents')`
  )
  assert.deepStrictEqual(rows, [])
})

// --- /api/settings --------------------------------------------------------
await t('jsonb settings upsert replaces the value', async () => {
  const upsert = `
    insert into app_settings (key, value, updated_at)
    values ($1, $2::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`
  await q(upsert, ['printer', JSON.stringify({ bridgeUrl: 'https://192.168.1.60:9443' })])
  await q(upsert, ['printer', JSON.stringify({ bridgeUrl: 'https://10.0.0.7:9443' })])
  const { rows } = await q(`select value from app_settings where key = 'printer'`)
  assert.strictEqual(rows[0].value.bridgeUrl, 'https://10.0.0.7:9443')
})

await t('settings load reads the four keys in one query', async () => {
  const { rows } = await q(
    `select key, value from app_settings where key in ('general', 'printer', 'label', 'grades')`
  )
  const keys = rows.map((r) => r.key).sort()
  assert.deepStrictEqual(keys, ['general', 'grades', 'label', 'printer'])
  assert.ok(Array.isArray(rows.find((r) => r.key === 'grades').value))
})

// --- /api/services --------------------------------------------------------
await t('replacing the service list deactivates rather than deletes', async () => {
  await q(`update services set active = false`)
  await q(
    `update services set name = $1, start_time = $2::time, sort_order = $3, active = true
     where id = $4::uuid`,
    ['1부 예배', '09:30', 1, serviceId]
  )
  await q(
    `insert into services (name, start_time, sort_order, active) values ($1, $2::time, $3, true)`,
    ['3부 예배', '13:00', 3]
  )
  const { rows } = await q(
    `select name, start_time from services where active order by sort_order, name`
  )
  assert.deepStrictEqual(rows.map((r) => r.name), ['1부 예배', '3부 예배'])
  // The historical check-in still resolves its FK even though 2부 is inactive.
  const { rows: ci } = await q(
    `select service_name from check_ins where session_date = $1::date`,
    [TODAY]
  )
  assert.strictEqual(ci[0].service_name, svc[0].name, 'history kept its own copy of the name')
})

// --- /api/stats -----------------------------------------------------------
await t('stats aggregates run over a date range', async () => {
  const from = '2026-08-01'
  const to = '2026-09-30'

  const daily = await q(
    `select session_date, count(*)::int as total, count(distinct student_id)::int as students
     from check_ins where session_date between $1::date and $2::date
     group by session_date order by session_date`,
    [from, to]
  )
  assert.strictEqual(daily.rows.length, 1)
  assert.strictEqual(daily.rows[0].total, 1)

  const byService = await q(
    `select coalesce(nullif(btrim(service_name), ''), '(none)') as service, count(*)::int as total
     from check_ins where session_date between $1::date and $2::date
     group by 1 order by total desc`,
    [from, to]
  )
  assert.strictEqual(byService.rows[0].total, 1)

  const perStudent = await q(
    `select s.id, s.korean_name, s.english_name, s.grade,
            count(c.id)::int as visits, max(c.session_date) as last_visit
     from students s
     left join check_ins c
       on c.student_id = s.id and c.session_date between $1::date and $2::date
     where s.active
     group by s.id, s.korean_name, s.english_name, s.grade
     order by visits desc, s.grade,
              coalesce(nullif(btrim(s.korean_name), ''), s.english_name)
     limit 500`,
    [from, to]
  )
  assert.ok(perStudent.rows.length > 1, 'includes students with zero visits')
  assert.strictEqual(perStudent.rows[0].visits, 1, 'attendee sorts first')
  assert.ok(
    perStudent.rows.some((r) => r.visits === 0),
    'non-attendees are present with a zero count'
  )

  const roster = await q(
    `select count(*)::int as active_students,
            count(*) filter (where created_at > now() - interval '30 days')::int as new_last_30_days
     from students where active`
  )
  assert.ok(roster.rows[0].active_students > 0)
})

// --- soft delete ----------------------------------------------------------
await t('a soft-deleted student leaves check-in history intact', async () => {
  await q(`update students set active = false where id = $1::uuid`, [studentId])
  const { rows: search } = await q(searchSql, ['%김%', '김%', TODAY])
  assert.ok(!search.some((r) => r.id === studentId), 'gone from the kiosk search')
  const { rows: history } = await q(
    `select count(*)::int as n from check_ins where student_id = $1::uuid`,
    [studentId]
  )
  assert.strictEqual(history[0].n, 1, 'attendance record survives')
  await q(`update students set active = true where id = $1::uuid`, [studentId])
})

await t('a hard delete cascades to check-ins', async () => {
  const { rows } = await q(
    `insert into students (english_name, grade) values ('ZZTest Cascade', '1st') returning id`
  )
  await q(
    `insert into check_ins (student_id, session_date, security_code) values ($1::uuid, $2::date, 'ABCD')`,
    [rows[0].id, TODAY]
  )
  await q(`delete from students where id = $1::uuid`, [rows[0].id])
  const { rows: left } = await q(
    `select count(*)::int as n from check_ins where student_id = $1::uuid`,
    [rows[0].id]
  )
  assert.strictEqual(left[0].n, 0)
})

await client.end()

console.log(`\n${pass} checks passed${results.length ? `, ${results.length} FAILED` : ''}`)
process.exit(results.length ? 1 : 0)
