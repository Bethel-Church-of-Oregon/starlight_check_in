import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { hasAdminSession } from '@/lib/admin'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** Check a child out (or clear a check-out if it was a mistake). Settings screen only. */
export async function PATCH(request: NextRequest, { params }: Params) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }
  const { id } = await params
  let body: { checkedOut?: boolean; checkedOutBy?: string | null }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sql = getSql()
  const rows =
    body.checkedOut === false
      ? await sql`
          update check_ins set checked_out_at = null, checked_out_by = null
          where id = ${id}::uuid returning *
        `
      : await sql`
          update check_ins
          set checked_out_at = now(), checked_out_by = ${body.checkedOutBy ?? null}
          where id = ${id}::uuid returning *
        `

  if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json({ checkIn: rows[0] })
}

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
