/**
 * Which day does a check-in count for?
 *
 * `session_date` is decided in the app (src/lib/settings.ts → sessionDateIn),
 * in the church's timezone, never the server's. Vercel runs in UTC, and a
 * 5 pm Sunday check-in in Oregon is already Monday there — it must still be
 * Sunday's attendance.
 */
const assert = require('node:assert')
const { sessionDateIn } = require('../.tmp-test/settings.js')

let pass = 0
const t = (name, fn) => { fn(); console.log(`  ok  ${name}`); pass++ }
const LA = 'America/Los_Angeles'

t('5:23 pm Sunday in Oregon is Sunday, although UTC says Monday', () => {
  // The real check-in recorded on 2026-09-29 (PDT, UTC-7).
  const instant = new Date('2026-09-30T00:23:54Z')
  assert.strictEqual(sessionDateIn('UTC', instant), '2026-09-30')
  assert.strictEqual(sessionDateIn(LA, instant), '2026-09-29')
})

t('winter time (PST, UTC-8) is handled too', () => {
  // 4:30 pm on Sunday 2026-12-06 in Oregon = 00:30 UTC Monday.
  assert.strictEqual(sessionDateIn(LA, new Date('2026-12-07T00:30:00Z')), '2026-12-06')
})

t('the day changes at local midnight, not UTC midnight', () => {
  assert.strictEqual(sessionDateIn(LA, new Date('2026-09-28T06:59:59Z')), '2026-09-27') // 11:59:59 pm PDT
  assert.strictEqual(sessionDateIn(LA, new Date('2026-09-28T07:00:00Z')), '2026-09-28') // midnight PDT
})

t('the result does not depend on the machine running the code', () => {
  // TZ is read per call by Intl; a Seoul-configured laptop must agree with Vercel.
  const before = process.env.TZ
  process.env.TZ = 'Asia/Seoul'
  try {
    assert.strictEqual(sessionDateIn(LA, new Date('2026-09-30T00:23:54Z')), '2026-09-29')
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})

t('the date is always YYYY-MM-DD, ready for a Postgres date column', () => {
  assert.match(sessionDateIn(LA, new Date('2026-01-04T20:00:00Z')), /^2026-01-04$/)
})

console.log(`\n${pass} checks passed`)
