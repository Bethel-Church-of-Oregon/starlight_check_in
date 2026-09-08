import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { agentTokenValid } from '@/lib/agent-auth'
import { DEFAULT_PRINTER, DEFAULT_GENERAL } from '@/lib/settings'
import { agentPollMs } from '@/lib/poll-interval'

export const dynamic = 'force-dynamic'

/** Requeue jobs a crashed agent claimed but never finished. */
const STALE_CLAIM_SECONDS = 45
const MAX_ATTEMPTS = 3
/** How long a failed job waits before an agent may pick it up again. */
const RETRY_DELAY_SECONDS = 20

/**
 * The LAN print agent polls this. It is three things at once:
 *
 *  - the job queue ("here is the next thing to print, or nothing")
 *  - the agent's heartbeat, which turns the printer icon in the footer green
 *  - the place the agent learns the printer IP configured in Settings, so
 *    changing the printer's address never means touching the agent machine
 *
 * It also tells the agent **how fast to poll next**. That matters more than it
 * sounds: a fixed one-second poll is 86,400 requests a day, which overruns both
 * Cloudflare Workers' free 100k/day and Vercel Hobby's free 1M/month — for a
 * building that is busy about three hours a week. See lib/poll-interval.ts.
 *
 * Always 200. `job` is null when the queue is empty.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const token = params.get('token') ?? request.headers.get('x-agent-token')

  if (!agentTokenValid(token)) {
    return Response.json({ error: 'Invalid agent token' }, { status: 401 })
  }

  const agentId = (params.get('agent') ?? 'default').slice(0, 64)

  try {
    return await claim(agentId, params)
  } catch (error) {
    // The agent prints whatever comes back here, so make it readable rather
    // than letting Next return an opaque 500.
    console.error('print claim failed', error)
    return Response.json(
      { error: `서버 오류: ${error instanceof Error ? error.message : 'unknown'}` },
      { status: 503 }
    )
  }
}

async function claim(agentId: string, params: URLSearchParams) {
  const sql = getSql()

  // One HTTP round trip to Neon for the whole poll. Ordering matters — the
  // stale-claim sweep has to run before the claim so a job an agent abandoned
  // is available again on this very poll.
  const [, , claimed, config, activity] = await sql.transaction([
    sql`
      insert into print_agents (id, name, printer_host, version, last_seen_at)
      values (
        ${agentId},
        ${params.get('name')?.slice(0, 120) ?? null},
        ${params.get('host')?.slice(0, 120) ?? null},
        ${params.get('version')?.slice(0, 40) ?? null},
        now()
      )
      on conflict (id) do update set
        last_seen_at = now(),
        name = coalesce(excluded.name, print_agents.name),
        printer_host = coalesce(excluded.printer_host, print_agents.printer_host),
        version = coalesce(excluded.version, print_agents.version)
    `,

    sql`
      update print_jobs
      set status = case when attempts >= ${MAX_ATTEMPTS} then 'error' else 'queued' end,
          retry_after = now() + make_interval(secs => ${RETRY_DELAY_SECONDS}),
          error = case when attempts >= ${MAX_ATTEMPTS}
                       then 'Agent claimed the job but never reported back'
                       else error end
      where status = 'claimed'
        and claimed_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
    `,

    // The "is printing switched on" test lives inside the statement so the
    // whole poll can be one ordered batch instead of read-then-decide.
    sql`
      update print_jobs
      set status = 'claimed', claimed_at = now(), agent_id = ${agentId}, attempts = attempts + 1
      where id = (
        select j.id from print_jobs j
        where j.status = 'queued'
          and (j.retry_after is null or j.retry_after <= now())
          and coalesce(
                (select (value ->> 'enabled')::boolean from app_settings where key = 'printer'),
                true
              )
        order by j.created_at
        limit 1
        for update skip locked
      )
      returning id, kind, label, data, byte_length, attempts
    `,

    sql`
      select
        (select value from app_settings where key = 'printer') as printer,
        (select value from app_settings where key = 'general') as general,
        (
          select coalesce(
            json_agg(json_build_object('startTime', to_char(start_time, 'HH24:MI')))
              filter (where start_time is not null),
            '[]'::json
          )
          from services where active
        ) as services
    `,

    // Evidence that the building is actually in use right now, which is what
    // lets the agent poll fast during a midweek event nobody scheduled.
    sql`
      select
        exists (
          select 1 from print_jobs where created_at > now() - interval '10 minutes'
        ) as recent_print,
        exists (
          select 1 from check_ins where checked_in_at > now() - interval '10 minutes'
        ) as recent_checkin
    `,
  ])

  const configRow = (config as Record<string, unknown>[])[0] ?? {}
  const printer = { ...DEFAULT_PRINTER, ...((configRow.printer as object) ?? {}) }
  const general = { ...DEFAULT_GENERAL, ...((configRow.general as object) ?? {}) }
  const serviceTimes = ((configRow.services as { startTime: string }[]) ?? [])
    .map((s) => s.startTime)
    .filter(Boolean)

  const activityRow = (activity as { recent_print: boolean; recent_checkin: boolean }[])[0]
  const job = (claimed as Record<string, unknown>[])[0] ?? null

  return Response.json({
    job,
    printer: {
      host: printer.host || null,
      port: printer.port || 9100,
      enabled: printer.enabled,
    },
    pollMs: agentPollMs({
      timezone: general.timezone,
      serviceTimes,
      busy: Boolean(job) || Boolean(activityRow?.recent_print) || Boolean(activityRow?.recent_checkin),
    }),
  })
}
