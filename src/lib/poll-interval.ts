/**
 * How fast the LAN print agent should poll.
 *
 * A fixed one-second poll is 86,400 requests a day. Both free hosting tiers
 * this app targets are cheaper than that:
 *
 *   Cloudflare Workers free   100,000 requests / day
 *   Vercel Hobby free       1,000,000 requests / month  (≈ 33,000 / day)
 *
 * ...for a building that is in use roughly three hours a week. So the server
 * tells the agent what cadence to use, based on two signals:
 *
 *   1. Are we near a configured service time? Being fast *before* the first
 *      family arrives is what makes the first label of the morning instant.
 *   2. Has anything happened in the last ten minutes? This covers the midweek
 *      event nobody put in the service list — the first label waits up to
 *      FAST_MS + IDLE_MS, and every one after it is instant.
 *
 * Worked example, two Sunday services at 9:30 and 11:00:
 *   fast window 09:10-12:30 → 12,000 requests
 *   the other 20h40m idle   →  7,440 requests
 *   ≈ 19,400 / day, i.e. under a fifth of the Cloudflare free allowance.
 */

/** Poll cadence while the building is (or is about to be) busy. */
export const FAST_MS = 1000
/** Poll cadence when nothing has happened for a while. */
export const IDLE_MS = 10000

/** How early before a service starts the agent speeds up. */
const WINDOW_LEAD_MINUTES = 20
/** How long after a service starts the agent stays fast. */
const WINDOW_TRAIL_MINUTES = 90

export function agentPollMs(options: {
  timezone: string
  /** Service start times as "HH:MM" in the church's timezone. */
  serviceTimes: string[]
  /** A job was just handed out, or something happened in the last few minutes. */
  busy: boolean
  now?: Date
}): number {
  if (options.busy) return FAST_MS
  return inServiceWindow(options.serviceTimes, options.timezone, options.now)
    ? FAST_MS
    : IDLE_MS
}

export function inServiceWindow(
  serviceTimes: string[],
  timezone: string,
  now: Date = new Date()
): boolean {
  if (serviceTimes.length === 0) return false
  const minutes = minutesOfDay(timezone, now)

  return serviceTimes.some((time) => {
    const start = parseHhMm(time)
    if (start === null) return false
    // Wrap across midnight so a late-evening service still opens its window.
    const from = start - WINDOW_LEAD_MINUTES
    const to = start + WINDOW_TRAIL_MINUTES
    if (from < 0) return minutes >= from + 1440 || minutes <= to
    if (to >= 1440) return minutes >= from || minutes <= to - 1440
    return minutes >= from && minutes <= to
  })
}

/** Minutes since midnight in the given timezone. */
export function minutesOfDay(timezone: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  // Intl renders midnight as 24 in some locales/engines.
  return (hour % 24) * 60 + minute
}

function parseHhMm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}
