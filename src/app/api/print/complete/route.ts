import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { agentTokenValid } from '@/lib/agent-auth'

export const dynamic = 'force-dynamic'

const MAX_ATTEMPTS = 3
const RETRY_DELAY_SECONDS = 20

/** The agent reports the outcome of a job it claimed. */
export async function POST(request: NextRequest) {
  let body: { token?: string; jobId?: string; ok?: boolean; error?: string; agent?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const token = body.token ?? request.headers.get('x-agent-token')
  if (!agentTokenValid(token)) {
    return Response.json({ error: 'Invalid agent token' }, { status: 401 })
  }
  if (typeof body.jobId !== 'string' || body.jobId === '') {
    return Response.json({ error: 'jobId is required' }, { status: 400 })
  }

  const sql = getSql()
  const succeeded = body.ok !== false
  const errorText = succeeded ? null : (body.error ?? 'unknown printer error').slice(0, 500)

  // A failed job goes back in the queue until it has burned its attempts.
  const rows = await sql`
    update print_jobs
    set status = case
          when ${succeeded}::boolean then 'done'
          when attempts >= ${MAX_ATTEMPTS} then 'error'
          else 'queued'
        end,
        completed_at = case when ${succeeded}::boolean then now() else null end,
        -- Space out retries: out-of-paper is the common failure and somebody
        -- has to physically walk over and fix it.
        retry_after = case
          when ${succeeded}::boolean then null
          else now() + make_interval(secs => ${RETRY_DELAY_SECONDS})
        end,
        error = ${errorText}
    where id = ${body.jobId}::uuid
    returning id, status, attempts, retry_after
  `

  if (body.agent) {
    await sql`
      update print_agents
      set last_seen_at = now(), last_error = ${errorText}
      where id = ${body.agent}
    `
  }

  if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json({ job: rows[0] })
}
