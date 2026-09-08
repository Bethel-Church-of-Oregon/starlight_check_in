import { getSql } from '@/lib/db'
import { loadSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/** Feeds the printer icon in the footer and the Settings screen dashboard. */
export async function GET() {
  try {
    const sql = getSql()
    const settings = await loadSettings()

    const agents = await sql`
      select id, name, printer_host, version, last_seen_at, last_error,
             (now() - last_seen_at) < interval '20 seconds' as online
      from print_agents
      order by last_seen_at desc
      limit 5
    `

    const counts = await sql`
      select
        count(*) filter (where status = 'queued')::int  as queued,
        count(*) filter (where status = 'claimed')::int as claimed,
        count(*) filter (where status = 'error')::int   as failed
      from print_jobs
      where created_at > now() - interval '1 day'
    `

    const recent = await sql`
      select id, kind, label, status, attempts, error, created_at, completed_at
      from print_jobs
      order by created_at desc
      limit 15
    `

    const online = (agents as { online: boolean }[]).some((a) => a.online)

    return Response.json({
      online,
      enabled: settings.printer.enabled,
      configured: Boolean(settings.printer.host),
      agents,
      counts: counts[0] ?? { queued: 0, claimed: 0, failed: 0 },
      recent,
    })
  } catch (error) {
    console.error('print status failed', error)
    return Response.json(
      { online: false, enabled: false, configured: false, error: 'unavailable' },
      { status: 200 }
    )
  }
}
