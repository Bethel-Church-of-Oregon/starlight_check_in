import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { loadSettings, sessionDateIn } from '@/lib/settings'
import { hasAdminSession } from '@/lib/admin'

export const dynamic = 'force-dynamic'

/**
 * Today's roll — Settings screen only. It carries every child's pickup code,
 * so it must never be reachable from the kiosk without the admin code.
 *
 * The session check comes before any query on purpose: it only verifies the
 * cookie's signature, so a refused request (say, a laptop left on this tab
 * after the 30-minute session ran out) never wakes the database.
 */
export async function GET(request: NextRequest) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }

  const settings = await loadSettings()
  const date =
    request.nextUrl.searchParams.get('date')?.trim() ||
    sessionDateIn(settings.general.timezone)

  const sql = getSql()
  const checkIns = await sql`
    select c.id, c.security_code, c.grade,
           c.checked_in_at, c.reprints,
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
    byGrade,
    checkIns,
  })
}
