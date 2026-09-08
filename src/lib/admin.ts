import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { getSql } from './db'

export const ADMIN_COOKIE = 'starlight_admin'
const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes at the settings screen is plenty

function sessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set')
  return secret
}

// --- admin code (the number volunteers type into the gear-icon dialog) -----

export function hashAdminCode(code: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(code, salt, 32).toString('hex')
  return `scrypt$${salt}$${hash}`
}

function codeMatches(code: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const candidate = scryptSync(code, salt, 32)
  const expected = Buffer.from(hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

export async function verifyAdminCode(code: string): Promise<boolean> {
  const sql = getSql()
  const rows = (await sql`
    select value from app_settings where key = 'admin_code'
  `) as { value: { hash?: string } }[]

  const stored = rows[0]?.value?.hash
  // No code configured yet (fresh database that skipped the migration seed):
  // fall back to 1234 rather than locking everyone out on a Sunday morning.
  if (!stored) return code === '1234'
  return codeMatches(code, stored)
}

export async function setAdminCode(code: string): Promise<void> {
  const sql = getSql()
  const value = JSON.stringify({ hash: hashAdminCode(code) })
  await sql`
    insert into app_settings (key, value, updated_at)
    values ('admin_code', ${value}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `
}

// --- short-lived signed session -------------------------------------------

export function issueAdminSession(): { token: string; maxAge: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const payload = String(expiresAt)
  const signature = createHmac('sha256', sessionSecret()).update(payload).digest('hex')
  return { token: `${payload}.${signature}`, maxAge: Math.floor(SESSION_TTL_MS / 1000) }
}

export function isValidAdminSession(token: string | undefined): boolean {
  if (!token) return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false

  const expected = createHmac('sha256', sessionSecret()).update(payload).digest('hex')
  const a = Buffer.from(signature, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  const expiresAt = Number(payload)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

/** For server components / route handlers: is the caller inside the admin session? */
export async function hasAdminSession(): Promise<boolean> {
  try {
    const store = await cookies()
    return isValidAdminSession(store.get(ADMIN_COOKIE)?.value)
  } catch {
    return false
  }
}

/** Guard for admin-only API routes. */
export async function requireAdmin(): Promise<Response | null> {
  if (await hasAdminSession()) return null
  return Response.json({ error: 'Admin session required' }, { status: 401 })
}
