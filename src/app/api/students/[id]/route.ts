import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { hasAdminSession } from '@/lib/admin'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params
  const sql = getSql()
  const rows = await sql`
    select * from students where id = ${id}::uuid
  `
  if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 })

  // Recent visits are handy on the check-in screen ("checked in already today?").
  // No pickup codes: this endpoint is public, and the kiosk is too.
  const history = await sql`
    select id, session_date, checked_in_at
    from check_ins
    where student_id = ${id}::uuid
    order by checked_in_at desc
    limit 5
  `
  return Response.json({ student: rows[0], history })
}

const EDITABLE: Record<string, string> = {
  koreanName: 'korean_name',
  englishName: 'english_name',
  grade: 'grade',
  gender: 'gender',
  birthdate: 'birthdate',
  school: 'school',
  guardianName: 'guardian_name',
  guardianPhone: 'guardian_phone',
  guardianPhoneAlt: 'guardian_phone_alt',
  allergies: 'allergies',
  medicalNotes: 'medical_notes',
  notes: 'notes',
  code: 'code',
  active: 'active',
}

export async function PATCH(request: NextRequest, { params }: Params) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }

  const { id } = await params
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sql = getSql()
  const current = await sql`select * from students where id = ${id}::uuid`
  if (current.length === 0) return Response.json({ error: 'Not found' }, { status: 404 })

  const merged = { ...(current[0] as Record<string, unknown>) }
  for (const [key, column] of Object.entries(EDITABLE)) {
    if (key in body) merged[column] = normalise(column, body[key])
  }

  if (!merged.korean_name && !merged.english_name) {
    return Response.json({ error: '한글 이름 또는 영어 이름 중 하나는 필요합니다.' }, { status: 400 })
  }
  if (!merged.grade) {
    return Response.json({ error: '학년은 비워둘 수 없습니다.' }, { status: 400 })
  }

  try {
    const rows = await sql`
      update students set
        korean_name = ${merged.korean_name as string | null},
        english_name = ${merged.english_name as string | null},
        grade = ${merged.grade as string},
        gender = ${merged.gender as string | null},
        birthdate = ${merged.birthdate as string | null},
        school = ${merged.school as string | null},
        guardian_name = ${merged.guardian_name as string | null},
        guardian_phone = ${merged.guardian_phone as string | null},
        guardian_phone_alt = ${merged.guardian_phone_alt as string | null},
        allergies = ${merged.allergies as string | null},
        medical_notes = ${merged.medical_notes as string | null},
        notes = ${merged.notes as string | null},
        code = ${merged.code as string | null},
        active = ${merged.active as boolean}::boolean,
        updated_at = now()
      where id = ${id}::uuid
      returning *
    `
    return Response.json({ student: rows[0] })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    if (message.includes('students_code_key')) {
      return Response.json({ error: '이미 등록된 바코드/ID 입니다.' }, { status: 409 })
    }
    console.error('student update failed', error)
    return Response.json({ error: '수정에 실패했습니다.' }, { status: 500 })
  }
}

/**
 * `?hard=1` really deletes the row (and its check-in history, by cascade).
 * The default is a soft delete, which keeps attendance history intact — that
 * is almost always what you want for a child who simply moved away.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }

  const { id } = await params
  const hard = request.nextUrl.searchParams.get('hard') === '1'
  const sql = getSql()

  if (hard) {
    await sql`delete from students where id = ${id}::uuid`
    return Response.json({ ok: true, mode: 'hard' })
  }

  const rows = await sql`
    update students set active = false, updated_at = now()
    where id = ${id}::uuid
    returning id
  `
  if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json({ ok: true, mode: 'soft' })
}

function normalise(column: string, value: unknown) {
  if (column === 'active') return value !== false
  if (typeof value !== 'string') return value == null ? null : value
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
