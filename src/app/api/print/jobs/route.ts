import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { loadSettings } from '@/lib/settings'
import { assembleJob } from '@/lib/brother'
import { base64FromBytes, bytesFromBase64 } from '@/lib/raster'
import { hasAdminSession } from '@/lib/admin'

export const dynamic = 'force-dynamic'

const MAX_STREAM_BYTES = 4 * 1024 * 1024

/**
 * Lets the confirmation screen show "printing…" → "printed" instead of just
 * hoping. `data` is never returned — it is up to 100 KB of raster.
 */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 })

  const sql = getSql()
  const rows = await sql`
    select id, kind, label, status, attempts, error, byte_length, created_at, completed_at
    from print_jobs where id = ${id}::uuid
  `
  if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json({ job: rows[0] })
}

/**
 * The iPad posts the PackBits raster stream it rendered; this route wraps it in
 * the full Brother command sequence and parks it in the queue for the LAN agent.
 *
 * Doing the protocol here rather than in the agent means the agent is a socket
 * pipe that never needs updating when a print setting changes.
 */
export async function POST(request: NextRequest) {
  let body: {
    stream?: string
    rasterCount?: number
    checkInId?: string | null
    kind?: string
    label?: string
    copies?: number
  }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body.stream !== 'string' || body.stream.length === 0) {
    return Response.json({ error: 'stream is required' }, { status: 400 })
  }

  let raster: Uint8Array
  try {
    raster = bytesFromBase64(body.stream)
  } catch {
    return Response.json({ error: 'stream is not valid base64' }, { status: 400 })
  }
  if (raster.length > MAX_STREAM_BYTES) {
    return Response.json({ error: 'stream too large' }, { status: 413 })
  }

  const settings = await loadSettings()
  if (!settings.printer.enabled) {
    return Response.json({ error: 'Printing is turned off in Settings', disabled: true }, { status: 409 })
  }

  let assembled: Uint8Array
  try {
    assembled = assembleJob(raster, {
      mediaWidthMm: settings.printer.mediaWidthMm,
      mediaType: 'continuous',
      autocut: settings.printer.autocut,
      cutAtEnd: settings.printer.cutAtEnd,
      feedDots: settings.printer.feedDots,
      copies: body.copies ?? settings.printer.copies,
      rotate180: settings.printer.rotate180,
    })
  } catch (error) {
    console.error('raster assembly failed', error)
    return Response.json({ error: 'Could not build the print job' }, { status: 400 })
  }

  const sql = getSql()
  const rows = await sql`
    insert into print_jobs (kind, check_in_id, label, data, byte_length)
    values (
      ${body.kind ?? 'label'},
      ${body.checkInId ?? null}::uuid,
      ${body.label ?? null},
      ${base64FromBytes(assembled)},
      ${assembled.length}
    )
    returning id, created_at
  `

  return Response.json({
    job: rows[0],
    bytes: assembled.length,
    rasterCount: body.rasterCount ?? null,
  })
}

/**
 * Requeue a failed job, or cancel one that is stuck. Admin only — this is the
 * "the printer was unplugged, try again" button on the Settings screen.
 */
export async function PATCH(request: NextRequest) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const action = params.get('action') ?? 'requeue'
  const id = params.get('id')
  const sql = getSql()

  if (action === 'clear') {
    // Drop everything still waiting — the usual fix after a paper jam has
    // queued up a dozen labels nobody wants any more.
    const rows = await sql`
      update print_jobs set status = 'canceled', completed_at = now()
      where status in ('queued', 'claimed')
      returning id
    `
    return Response.json({ ok: true, canceled: rows.length })
  }

  if (action === 'requeue') {
    const rows = id
      ? await sql`
          update print_jobs
          set status = 'queued', attempts = 0, error = null,
              claimed_at = null, completed_at = null, retry_after = null
          where id = ${id}::uuid
          returning id
        `
      : await sql`
          update print_jobs
          set status = 'queued', attempts = 0, error = null,
              claimed_at = null, completed_at = null, retry_after = null
          where status = 'error' and created_at > now() - interval '1 day'
          returning id
        `
    return Response.json({ ok: true, requeued: rows.length })
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 })
}
