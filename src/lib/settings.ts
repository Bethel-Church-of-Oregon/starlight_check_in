import { getSql } from './db'
import type { AppSettings, GeneralSettings, LabelSettings, PrinterSettings } from './types'

export const DEFAULT_GENERAL: GeneralSettings = {
  churchName: 'Bethel Starlight Check-in System',
  locationName: 'Elementary',
  timezone: 'America/Los_Angeles',
  autoReturnSeconds: 5,
}

export const DEFAULT_PRINTER: PrinterSettings = {
  bridgeUrl: '',
  bridgeKey: '',
  mediaWidthMm: 62,
  labelLengthMm: 90,
  copies: 1,
  autocut: true,
  cutAtEnd: true,
  rotate180: false,
  feedDots: 35,
  threshold: 160,
  enabled: true,
}

export const DEFAULT_LABEL: LabelSettings = {
  showKorean: true,
  showEnglish: true,
  showGrade: true,
  showCode: true,
  showDateTime: true,
  showService: true,
  nameScale: 1,
}

export const DEFAULT_GRADES = ['K', '1st', '2nd', '3rd', '4th', '5th', '6th']

export async function loadSettings(): Promise<AppSettings> {
  const sql = getSql()
  const rows = (await sql`
    select key, value from app_settings
    where key in ('general', 'printer', 'label', 'grades')
  `) as { key: string; value: unknown }[]

  const bag = new Map(rows.map((r) => [r.key, r.value]))

  return {
    general: known(DEFAULT_GENERAL, bag.get('general')),
    printer: known(DEFAULT_PRINTER, bag.get('printer')),
    label: known(DEFAULT_LABEL, bag.get('label')),
    grades: (bag.get('grades') as string[] | undefined) ?? DEFAULT_GRADES,
  }
}

/**
 * Defaults overlaid with the stored values — but only for keys the app still
 * knows about. Settings rows outlive code: a database seeded before the Pi
 * bridge still has the old `host`/`port` printer keys, and those must not
 * leak back out through the API.
 */
function known<T extends object>(defaults: T, stored: unknown): T {
  const result = { ...defaults }
  if (stored && typeof stored === 'object') {
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      if (key in stored) result[key] = (stored as T)[key]
    }
  }
  return result
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  const sql = getSql()
  await sql`
    insert into app_settings (key, value, updated_at)
    values (${key}, ${JSON.stringify(value)}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `
}

/** Today's date in the church's timezone, as YYYY-MM-DD. */
export function sessionDateIn(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}
