import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { hasAdminSession } from '@/lib/admin'
import { loadSettings, sessionDateIn } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/** Attendance roll-ups for the Settings screen. */
export async function GET(request: NextRequest) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }

  const settings = await loadSettings()
  const today = sessionDateIn(settings.general.timezone)
  const params = request.nextUrl.searchParams
  const to = params.get('to')?.trim() || today
  const from = params.get('from')?.trim() || shiftDays(to, -83) // ~12 weeks

  const sql = getSql()

  const daily = await sql`
    select session_date,
           count(*)::int as total,
           count(distinct student_id)::int as students
    from check_ins
    where session_date between ${from}::date and ${to}::date
    group by session_date
    order by session_date
  `

  const byGrade = await sql`
    select coalesce(nullif(btrim(grade), ''), '(none)') as grade,
           count(*)::int as total,
           count(distinct student_id)::int as students
    from check_ins
    where session_date between ${from}::date and ${to}::date
    group by 1
    order by 1
  `

  const byService = await sql`
    select coalesce(nullif(btrim(service_name), ''), '(none)') as service,
           count(*)::int as total
    from check_ins
    where session_date between ${from}::date and ${to}::date
    group by 1
    order by total desc
  `

  const perStudent = await sql`
    select s.id, s.korean_name, s.english_name, s.grade,
           count(c.id)::int as visits,
           max(c.session_date) as last_visit
    from students s
    left join check_ins c
      on c.student_id = s.id
     and c.session_date between ${from}::date and ${to}::date
    where s.active
    group by s.id, s.korean_name, s.english_name, s.grade
    order by visits desc, s.grade,
             coalesce(nullif(btrim(s.korean_name), ''), s.english_name)
    limit 500
  `

  const roster = await sql`
    select count(*)::int as active_students,
           count(*) filter (where created_at > now() - interval '30 days')::int as new_last_30_days
    from students
    where active
  `

  return Response.json({
    range: { from, to },
    today,
    timezone: settings.general.timezone,
    daily,
    byGrade,
    byService,
    perStudent,
    roster: roster[0] ?? { active_students: 0, new_last_30_days: 0 },
  })
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
