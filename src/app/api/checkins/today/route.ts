import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { loadSettings, sessionDateIn } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const settings = await loadSettings()
  const date =
    request.nextUrl.searchParams.get('date')?.trim() ||
    sessionDateIn(settings.general.timezone)

  const sql = getSql()
  const checkIns = await sql`
    select c.id, c.security_code, c.service_name, c.grade,
           c.checked_in_at, c.checked_out_at, c.checked_out_by, c.reprints,
           s.id as student_id, s.korean_name, s.english_name
    from check_ins c
    join students s on s.id = c.student_id
    where c.session_date = ${date}::date
    order by c.checked_in_at desc
  `

  const byGrade = await sql`
    select coalesce(nullif(btrim(grade), ''), '(none)') as grade, count(*)::int as count
    from check_ins
    where session_date = ${date}::date
    group by 1
    order by 1
  `

  return Response.json({
    date,
    timezone: settings.general.timezone,
    total: checkIns.length,
    checkedOut: (checkIns as { checked_out_at: string | null }[]).filter((c) => c.checked_out_at)
      .length,
    byGrade,
    checkIns,
  })
}
