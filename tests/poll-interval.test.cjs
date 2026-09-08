/**
 * Agent poll-cadence checks.
 *
 * This is the logic that keeps the app inside a free hosting tier, so the
 * arithmetic is asserted rather than assumed: a fixed 1 s poll is 86,400
 * requests a day, which overruns both Cloudflare Workers free (100k/day) and
 * Vercel Hobby free (1M/month ≈ 33k/day).
 */
const assert = require('node:assert')
const P = require('../.tmp-test/poll-interval.js')

let pass = 0
const t = (name, fn) => { fn(); console.log(`  ok  ${name}`); pass++ }

const TZ = 'America/Los_Angeles'
/** A Date that reads as the given local wall-clock time in America/Los_Angeles. */
const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  // 2026-09-06 is PDT (UTC-7).
  return new Date(Date.UTC(2026, 8, 6, h + 7, m, 0))
}

t('local wall clock is read in the church timezone, not UTC', () => {
  assert.strictEqual(P.minutesOfDay(TZ, at('09:30')), 9 * 60 + 30)
  assert.strictEqual(P.minutesOfDay(TZ, at('00:00')), 0)
  assert.strictEqual(P.minutesOfDay(TZ, at('23:59')), 23 * 60 + 59)
  // Same instant, different zone.
  assert.strictEqual(P.minutesOfDay('UTC', at('09:30')), 16 * 60 + 30)
})

t('the window opens 20 minutes before a service and closes 90 after', () => {
  const services = ['09:30']
  assert.strictEqual(P.inServiceWindow(services, TZ, at('09:09')), false, '21 min before')
  assert.strictEqual(P.inServiceWindow(services, TZ, at('09:10')), true, '20 min before')
  assert.strictEqual(P.inServiceWindow(services, TZ, at('09:30')), true, 'at the start')
  assert.strictEqual(P.inServiceWindow(services, TZ, at('11:00')), true, '90 min after')
  assert.strictEqual(P.inServiceWindow(services, TZ, at('11:01')), false, '91 min after')
})

t('two services merge into one continuous window', () => {
  const services = ['09:30', '11:00']
  for (const time of ['09:10', '10:00', '10:45', '11:30', '12:30']) {
    assert.strictEqual(P.inServiceWindow(services, TZ, at(time)), true, time)
  }
  for (const time of ['08:00', '09:09', '12:31', '18:00']) {
    assert.strictEqual(P.inServiceWindow(services, TZ, at(time)), false, time)
  }
})

t('a late service wraps its window across midnight', () => {
  assert.strictEqual(P.inServiceWindow(['23:30'], TZ, at('23:20')), true)
  assert.strictEqual(P.inServiceWindow(['23:30'], TZ, at('00:30')), true, 'after midnight')
  assert.strictEqual(P.inServiceWindow(['23:30'], TZ, at('12:00')), false)
  // ...and an early one wraps backwards.
  assert.strictEqual(P.inServiceWindow(['00:10'], TZ, at('23:55')), true, 'before midnight')
  assert.strictEqual(P.inServiceWindow(['00:10'], TZ, at('01:00')), true)
})

t('no services means no window, and idle cadence', () => {
  assert.strictEqual(P.inServiceWindow([], TZ, at('09:30')), false)
  assert.strictEqual(
    P.agentPollMs({ timezone: TZ, serviceTimes: [], busy: false, now: at('09:30') }),
    P.IDLE_MS
  )
})

t('malformed service times are ignored rather than throwing', () => {
  assert.strictEqual(P.inServiceWindow(['', 'nope', '99:99', '9'], TZ, at('09:30')), false)
  assert.strictEqual(P.inServiceWindow(['bad', '09:30'], TZ, at('09:30')), true, 'good one still counts')
})

t('recent activity forces the fast cadence outside any window', () => {
  const args = { timezone: TZ, serviceTimes: ['09:30'], now: at('19:00') }
  assert.strictEqual(P.agentPollMs({ ...args, busy: false }), P.IDLE_MS)
  assert.strictEqual(P.agentPollMs({ ...args, busy: true }), P.FAST_MS, 'midweek event')
})

t('inside the window the cadence is fast even with nothing happening', () => {
  assert.strictEqual(
    P.agentPollMs({ timezone: TZ, serviceTimes: ['09:30'], busy: false, now: at('09:15') }),
    P.FAST_MS,
    'fast before the first family arrives, so the first label is instant'
  )
})

t('the resulting daily volume fits both free tiers', () => {
  const services = ['09:30', '11:00']
  let fast = 0
  let idle = 0
  // Walk a whole day a minute at a time and count what the agent would send.
  for (let minute = 0; minute < 1440; minute++) {
    const window = P.inServiceWindow(
      services,
      TZ,
      at(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`)
    )
    if (window) fast += 60000 / P.FAST_MS
    else idle += 60000 / P.IDLE_MS
  }

  const perDay = fast + idle
  console.log(
    `      ${perDay.toLocaleString()} req/day  (fast ${fast.toLocaleString()} + idle ${idle.toLocaleString()})` +
      `  vs 86,400 at a flat 1s`
  )

  assert.ok(perDay < 100000, `Cloudflare Workers free is 100,000/day, got ${perDay}`)
  assert.ok(perDay * 30 < 1000000, `Vercel Hobby free is 1,000,000/month, got ${perDay * 30}`)
  assert.ok(perDay < 86400 / 3, 'should be well under a third of a flat one-second poll')
})

t('the fast window still covers a full Sunday morning', () => {
  const services = ['09:30', '11:00']
  // Every minute from the first arrivals to the end of the second service.
  for (let minute = 9 * 60 + 10; minute <= 12 * 60 + 30; minute++) {
    const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    assert.strictEqual(P.inServiceWindow(services, TZ, at(hhmm)), true, hhmm)
  }
})

console.log(`\n${pass} checks passed`)
