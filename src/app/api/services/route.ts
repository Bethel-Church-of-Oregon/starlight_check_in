import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { hasAdminSession } from '@/lib/admin'

export const dynamic = 'force-dynamic'

export async function GET() {
  const sql = getSql()
  const services = await sql`
    select id, name, start_time, sort_order, active
    from services
    where active
    order by sort_order, start_time nulls last, name
  `
  return Response.json({ services })
}

/** Replace the whole service list — Settings screen. */
export async function PUT(request: NextRequest) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }

  let body: { services?: { id?: string; name?: string; startTime?: string | null }[] }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const incoming = (body.services ?? [])
    .map((s, index) => ({
      id: typeof s.id === 'string' && s.id ? s.id : null,
      name: (s.name ?? '').trim(),
      startTime: (s.startTime ?? '').trim() || null,
      sortOrder: index + 1,
    }))
    .filter((s) => s.name !== '')

  const sql = getSql()

  // Deactivate rather than delete, so historical check_ins keep their FK.
  await sql`update services set active = false`

  for (const s of incoming) {
    if (s.id) {
      await sql`
        update services
        set name = ${s.name}, start_time = ${s.startTime}::time,
            sort_order = ${s.sortOrder}, active = true
        where id = ${s.id}::uuid
      `
    } else {
      await sql`
        insert into services (name, start_time, sort_order, active)
        values (${s.name}, ${s.startTime}::time, ${s.sortOrder}, true)
      `
    }
  }

  const services = await sql`
    select id, name, start_time, sort_order, active
    from services where active
    order by sort_order, name
  `
  return Response.json({ services })
}
