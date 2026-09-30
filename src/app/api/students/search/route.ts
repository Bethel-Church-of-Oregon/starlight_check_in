import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { loadSettings, sessionDateIn } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/**
 * Live search behind the big box on the default screen. Matches Korean name,
 * English name, barcode/member id, guardian name and guardian phone (with or
 * without punctuation).
 *
 * Each row also carries whether the child is already checked in today, so a
 * volunteer cannot accidentally hand out two name tags to the same kid — but
 * never the pickup code itself. This endpoint answers anyone at the kiosk,
 * and a code anyone can look up by typing a child's name protects nothing.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (raw.length === 0) return Response.json({ students: [] })

  const q = raw.toLowerCase()
  const digits = raw.replace(/[^0-9]/g, '')
  const looksLikePhone = digits.length >= 3 && /^[\d\s()+-]+$/.test(raw)
  const needle = looksLikePhone ? digits : q

  try {
    const sql = getSql()
    const settings = await loadSettings()
    const today = sessionDateIn(settings.general.timezone)

    const students = await sql`
      select s.id, s.korean_name, s.english_name, s.grade, s.gender, s.code,
             s.guardian_name, s.guardian_phone, s.allergies, s.medical_notes,
             t.service_name  as today_service,
             t.checked_in_at as today_checked_in_at
      from students s
      left join lateral (
        select service_name, checked_in_at
        from check_ins c
        where c.student_id = s.id and c.session_date = ${today}::date
        order by c.checked_in_at desc
        limit 1
      ) t on true
      where s.active
        and s.search_text like ${'%' + needle + '%'}
      order by
        case when s.search_text like ${needle + '%'} then 0 else 1 end,
        coalesce(nullif(btrim(s.korean_name), ''), nullif(btrim(s.english_name), '')),
        s.english_name
      limit 25
    `
    return Response.json({ students, sessionDate: today })
  } catch (error) {
    console.error('student search failed', error)
    return Response.json({ error: 'Search failed', students: [] }, { status: 500 })
  }
}
