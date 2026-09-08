import { timingSafeEqual } from 'node:crypto'

/** Constant-time check of the shared secret the LAN print agent presents. */
export function agentTokenValid(provided: string | null | undefined): boolean {
  const expected = process.env.PRINT_AGENT_TOKEN
  if (!expected || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
