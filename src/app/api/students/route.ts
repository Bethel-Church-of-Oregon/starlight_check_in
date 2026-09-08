import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { hasAdminSession } from '@/lib/admin'

export const dynamic = 'force-dynamic'

/** Full roster — Settings screen only. */
export async function GET(request: NextRequest) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const grade = (params.get('grade') ?? '').trim()
  const includeInactive = params.get('includeInactive') === '1'

  const sql = getSql()
  const students = await sql`
    select *
    from students
    where (${includeInactive}::boolean or active)
      and (${q === ''}::boolean or search_text like ${'%' + q + '%'})
      and (${grade === ''}::boolean or grade = ${grade})
    order by grade, coalesce(nullif(btrim(korean_name), ''), english_name)
    limit 1000
  `
  return Response.json({ students })
}

/** New student registration. Reachable without an admin session on purpose —
 *  it is the "Add person" flow volunteers use at the door. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const koreanName = text(body.koreanName)
  const englishName = text(body.englishName)
  const grade = text(body.grade)

  if (!koreanName && !englishName) {
    return Response.json({ error: '한글 이름 또는 영어 이름 중 하나는 필요합니다.' }, { status: 400 })
  }
  if (!grade) {
    return Response.json({ error: '학년을 선택해 주세요.' }, { status: 400 })
  }

  try {
    const sql = getSql()
    const rows = await sql`
      insert into students (
        korean_name, english_name, grade, gender, birthdate, school,
        guardian_name, guardian_phone, guardian_phone_alt,
        allergies, medical_notes, notes, code
      ) values (
        ${koreanName}, ${englishName}, ${grade}, ${text(body.gender)},
        ${text(body.birthdate)}, ${text(body.school)},
        ${text(body.guardianName)}, ${text(body.guardianPhone)}, ${text(body.guardianPhoneAlt)},
        ${text(body.allergies)}, ${text(body.medicalNotes)}, ${text(body.notes)}, ${text(body.code)}
      )
      returning *
    `
    return Response.json({ student: rows[0] }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    if (message.includes('students_code_key')) {
      return Response.json({ error: '이미 등록된 바코드/ID 입니다.' }, { status: 409 })
    }
    console.error('student create failed', error)
    return Response.json({ error: '등록에 실패했습니다. 다시 시도해 주세요.' }, { status: 500 })
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
