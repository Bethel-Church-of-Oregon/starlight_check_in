import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { hasAdminSession } from '@/lib/admin'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** Undo a check-in entirely — admin only, because it removes attendance data. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }
  const { id } = await params
  const sql = getSql()
  const rows = await sql`delete from check_ins where id = ${id}::uuid returning id`
  if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json({ ok: true })
}
