import { NextRequest } from 'next/server'
import { getSql } from '@/lib/db'
import { hasAdminSession, setAdminCode } from '@/lib/admin'
import {
  DEFAULT_GENERAL,
  DEFAULT_GRADES,
  DEFAULT_LABEL,
  DEFAULT_PRINTER,
  loadSettings,
  saveSetting,
} from '@/lib/settings'

export const dynamic = 'force-dynamic'

/**
 * GET is public because every screen needs the church name, grade list,
 * services, label geometry — and, now that the iPad prints straight to the
 * LAN bridge, the full print settings including the bridge address and key.
 * Neither is a secret: the key only stops other devices on the church Wi-Fi
 * from printing, and the printer's own IP lives on the bridge, not here.
 */
export async function GET() {
  const admin = await hasAdminSession().catch(() => false)

  let settings: Awaited<ReturnType<typeof loadSettings>>
  let services: unknown[]
  try {
    const sql = getSql()
    settings = await loadSettings()
    services = await sql`
      select id, name, start_time, sort_order, active
      from services where active
      order by sort_order, start_time nulls last, name
    `
  } catch (error) {
    // Every screen calls this on mount. If the database is unreachable the
    // kiosk must still paint — a volunteer seeing the search box and an error
    // on their next action beats a blank purple screen on a Sunday morning.
    console.error('settings unavailable, serving defaults', error)
    return Response.json({
      degraded: true,
      general: DEFAULT_GENERAL,
      label: DEFAULT_LABEL,
      grades: DEFAULT_GRADES,
      services: [],
      admin: false,
      printer: DEFAULT_PRINTER,
    })
  }

  return Response.json({
    degraded: false,
    general: settings.general,
    label: settings.label,
    grades: settings.grades,
    services,
    admin,
    printer: settings.printer,
  })
}

export async function PATCH(request: NextRequest) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const current = await loadSettings()

  if (body.general) {
    const incoming = body.general as Record<string, unknown>
    await saveSetting('general', {
      ...current.general,
      churchName: str(incoming.churchName, current.general.churchName),
      locationName: str(incoming.locationName, current.general.locationName),
      timezone: str(incoming.timezone, current.general.timezone),
      autoReturnSeconds: num(incoming.autoReturnSeconds, current.general.autoReturnSeconds, 2, 30),
    })
  }

  if (body.printer) {
    const incoming = body.printer as Record<string, unknown>
    if (typeof incoming.bridgeUrl === 'string' && incoming.bridgeUrl.trim() !== '') {
      let parsed: URL | null = null
      try {
        parsed = new URL(incoming.bridgeUrl.trim())
      } catch {
        parsed = null
      }
      if (!parsed || !['https:', 'http:'].includes(parsed.protocol)) {
        return Response.json(
          { error: '브릿지 주소는 https://192.168.1.60:9443 같은 형식이어야 합니다.' },
          { status: 400 }
        )
      }
    }
    await saveSetting('printer', {
      ...current.printer,
      bridgeUrl: str(incoming.bridgeUrl, current.printer.bridgeUrl).trim().replace(/\/+$/, ''),
      bridgeKey: str(incoming.bridgeKey, current.printer.bridgeKey).trim(),
      mediaWidthMm: num(incoming.mediaWidthMm, current.printer.mediaWidthMm, 12, 62),
      labelLengthMm: num(incoming.labelLengthMm, current.printer.labelLengthMm, 20, 300),
      copies: num(incoming.copies, current.printer.copies, 1, 5),
      feedDots: num(incoming.feedDots, current.printer.feedDots, 0, 500),
      threshold: num(incoming.threshold, current.printer.threshold, 40, 240),
      autocut: bool(incoming.autocut, current.printer.autocut),
      cutAtEnd: bool(incoming.cutAtEnd, current.printer.cutAtEnd),
      rotate180: bool(incoming.rotate180, current.printer.rotate180),
      enabled: bool(incoming.enabled, current.printer.enabled),
    })
  }

  if (body.label) {
    const incoming = body.label as Record<string, unknown>
    await saveSetting('label', {
      ...current.label,
      showKorean: bool(incoming.showKorean, current.label.showKorean),
      showEnglish: bool(incoming.showEnglish, current.label.showEnglish),
      showGrade: bool(incoming.showGrade, current.label.showGrade),
      showCode: bool(incoming.showCode, current.label.showCode),
      showDateTime: bool(incoming.showDateTime, current.label.showDateTime),
      showService: bool(incoming.showService, current.label.showService),
      nameScale: num(incoming.nameScale, current.label.nameScale, 0.6, 1.6),
    })
  }

  if (Array.isArray(body.grades)) {
    const grades = (body.grades as unknown[])
      .filter((g): g is string => typeof g === 'string')
      .map((g) => g.trim())
      .filter((g) => g !== '')
      .slice(0, 40)
    if (grades.length > 0) await saveSetting('grades', grades)
  }

  if (typeof body.adminCode === 'string' && body.adminCode.trim() !== '') {
    const code = body.adminCode.trim()
    if (code.length < 4 || code.length > 24) {
      return Response.json({ error: '관리자 코드는 4~24자여야 합니다.' }, { status: 400 })
    }
    await setAdminCode(code)
  }

  return Response.json({ ok: true, settings: await loadSettings() })
}

/** Restore factory defaults for a single section. */
export async function DELETE(request: NextRequest) {
  if (!(await hasAdminSession())) {
    return Response.json({ error: 'Admin session required' }, { status: 401 })
  }
  const section = request.nextUrl.searchParams.get('section')
  const defaults: Record<string, unknown> = {
    general: DEFAULT_GENERAL,
    printer: DEFAULT_PRINTER,
    label: DEFAULT_LABEL,
  }
  if (!section || !(section in defaults)) {
    return Response.json({ error: 'Unknown section' }, { status: 400 })
  }
  await saveSetting(section, defaults[section])
  return Response.json({ ok: true, settings: await loadSettings() })
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
