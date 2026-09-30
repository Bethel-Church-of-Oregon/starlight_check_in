import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { loadSettings, sessionDateIn } from '@/lib/settings'
import { uniqueSecurityCode } from '@/lib/codes'
import type { LabelPayload } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Records a check-in and hands the iPad everything it needs to draw the label.
 *
 * One check-in per child per day. Checking the same child in again that day
 * reuses the original row and its security code, so a reprint always matches
 * the tag the parent is holding.
 *
 * `checked_in_at` is the database's `now()` — an absolute instant (timestamptz),
 * independent of whatever timezone the server runs in. `session_date` is the
 * church's local calendar date (Settings → 일반 → 시간대), computed here, so a
 * 5 pm Sunday check-in in Oregon — already Monday in UTC — still counts as
 * Sunday's attendance.
 */
export async function POST(request: NextRequest) {
  let body: { studentId?: string; checkedInBy?: string | null }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const studentId = body.studentId
  if (typeof studentId !== 'string' || studentId === '') {
    return Response.json({ error: 'studentId is required' }, { status: 400 })
  }

  const sql = getSql()
  const settings = await loadSettings()
  const sessionDate = sessionDateIn(settings.general.timezone)

  const studentRows = await sql`
    select id, korean_name, english_name, grade, allergies, medical_notes
    from students where id = ${studentId}::uuid
  `
  if (studentRows.length === 0) {
    return Response.json({ error: 'Student not found' }, { status: 404 })
  }
  const student = studentRows[0] as {
    id: string
    korean_name: string | null
    english_name: string | null
    grade: string
  }

  const existing = await sql`
    select * from check_ins
    where student_id = ${studentId}::uuid
      and session_date = ${sessionDate}::date
    order by checked_in_at desc
    limit 1
  `

  let checkIn: Record<string, unknown>
  let alreadyCheckedIn = false

  if (existing.length > 0) {
    alreadyCheckedIn = true
    const rows = await sql`
      update check_ins set reprints = reprints + 1
      where id = ${(existing[0] as { id: string }).id}::uuid
      returning *
    `
    checkIn = rows[0] as Record<string, unknown>
  } else {
    const takenRows = await sql`
      select security_code from check_ins where session_date = ${sessionDate}::date
    `
    const taken = new Set((takenRows as { security_code: string }[]).map((r) => r.security_code))
    const securityCode = uniqueSecurityCode(taken)

    const rows = await sql`
      insert into check_ins (
        student_id, session_date, security_code, grade, checked_in_by
      ) values (
        ${studentId}::uuid, ${sessionDate}::date, ${securityCode}, ${student.grade},
        ${body.checkedInBy ?? null}
      )
      returning *
    `
    checkIn = rows[0] as Record<string, unknown>
  }

  const labelPayload: LabelPayload = {
    koreanName: student.korean_name,
    englishName: student.english_name,
    grade: (checkIn.grade as string | null) ?? student.grade,
    securityCode: checkIn.security_code as string,
    checkedInAt: new Date(checkIn.checked_in_at as string).toISOString(),
  }

  return Response.json({
    checkIn,
    student: studentRows[0],
    alreadyCheckedIn,
    labelPayload,
    label: settings.label,
    // Everything the iPad needs to assemble the Brother job and reach the bridge.
    printer: settings.printer,
    timezone: settings.general.timezone,
    autoReturnSeconds: settings.general.autoReturnSeconds,
  })
}
