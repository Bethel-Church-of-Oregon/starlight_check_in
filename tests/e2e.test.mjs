/**
 * End-to-end check: app API → iPad-side job assembly → Pi bridge → printer.
 *
 * Drives the real HTTP API the way the iPad does, assembles the Brother job
 * with the same code the iPad runs, posts it to the real bridge process, and
 * inspects the bytes that reached a fake QL-820NWBc.
 *
 * Prerequisites (see README "로컬 Postgres로 개발하기"):
 *   - Postgres on :55432, migrated
 *   - scripts/neon-http-proxy.mjs on :54320
 *   - next dev on :4900 with NEON_FETCH_ENDPOINT pointed at the proxy
 *
 *   npm test && node tests/e2e.test.mjs
 */
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { startFakePrinter } from './fake-printer.mjs'

const require = createRequire(import.meta.url)
const R = require('../.tmp-test/raster.js')
const B = require('../.tmp-test/brother.js')

const APP = process.env.APP_URL ?? 'http://localhost:4900'
const PRINTER_PORT = Number(process.env.FAKE_PRINTER_PORT ?? 19100)
const BRIDGE_PORT = Number(process.env.BRIDGE_TEST_PORT ?? 19444)
const BRIDGE_KEY = 'e2e-bridge-key'
const ADMIN_CODE = process.env.ADMIN_CODE ?? '1234'
/** Suffix so repeated runs against the same database never collide. */
const RUN = Date.now().toString(36).slice(-5)

let pass = 0
const failures = []
async function t(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
    pass++
  } catch (error) {
    console.error(`  FAIL  ${name}\n        ${error.stack?.split('\n').slice(0, 3).join('\n        ')}`)
    failures.push(name)
  }
}

// --------------------------------------------------------------------------
// HTTP helpers (cookie jar for the admin session)
// --------------------------------------------------------------------------
let cookie = ''
async function api(path, init = {}) {
  const response = await fetch(`${APP}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/** Compressed raster lines standing in for the canvas the iPad draws. */
function makeRasterStream(lines = 120) {
  const rows = Array.from({ length: lines }, (_, y) => {
    const line = new Uint8Array(90)
    if (y > 20 && y < 100) for (let byte = 3; byte < 30; byte++) line[byte] = 0xff
    return line
  })
  return R.encodeCompressedLines(rows)
}

/** Assemble a job exactly as src/lib/print-client.ts does, from app settings. */
function assembleFromSettings(printer, lines = 120) {
  return Buffer.from(
    B.assembleJob(makeRasterStream(lines), {
      mediaWidthMm: printer.mediaWidthMm,
      mediaType: 'continuous',
      autocut: printer.autocut,
      cutAtEnd: printer.cutAtEnd,
      feedDots: printer.feedDots,
      copies: printer.copies,
      rotate180: printer.rotate180,
    })
  )
}

function startBridge() {
  const child = spawn(process.execPath, ['bridge/bridge.mjs'], {
    env: {
      ...process.env,
      BRIDGE_CONFIG: '/nonexistent/config.json',
      BRIDGE_PORT: String(BRIDGE_PORT),
      PRINTER_HOST: '127.0.0.1',
      PRINTER_PORT: String(PRINTER_PORT),
      BRIDGE_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let log = ''
    const timer = setTimeout(() => reject(new Error(`bridge did not start:\n${log}`)), 5000)
    child.stdout.on('data', (d) => {
      log += d
      if (log.includes('listen')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
  })
}

/** What the iPad does after a check-in, minus the canvas. */
async function printViaBridge(printer, job) {
  const response = await fetch(`${printer.bridgeUrl}/print`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Bridge-Key': printer.bridgeKey },
    body: job,
  })
  return { status: response.status, body: await response.json() }
}

// --------------------------------------------------------------------------
console.log(`\ne2e against ${APP}\n`)

// Start from a clean slate for today's check-ins so counts are predictable.
{
  const signIn = await api('/api/admin/auth', {
    method: 'POST',
    body: JSON.stringify({ code: ADMIN_CODE }),
  })
  if (signIn.status === 200) {
    const today = await api('/api/checkins/today')
    for (const row of today.body.checkIns ?? []) {
      await api(`/api/checkins/${row.id}`, { method: 'DELETE' })
    }
    await api('/api/admin/auth', { method: 'DELETE' })
  }
  cookie = ''
}

const printer = await startFakePrinter(PRINTER_PORT)
const bridge = await startBridge()
let studentId
let checkInId
let securityCode

await t('settings endpoint is live and not degraded', async () => {
  const { status, body } = await api('/api/settings')
  assert.strictEqual(status, 200)
  assert.strictEqual(body.degraded, false, 'database is reachable')
  assert.ok(body.grades.length > 0)
  assert.ok(body.services.length > 0, 'seeded services are present')
  assert.strictEqual(body.admin, false, 'no admin session yet')
  // The kiosk needs the full print settings to assemble jobs itself; the
  // printer's own IP lives on the bridge and must not appear here.
  assert.ok('bridgeUrl' in body.printer, 'bridge address is available to the kiosk')
  assert.strictEqual(body.printer.host, undefined, 'printer IP is not part of app settings')
})

await t('live search finds a seeded child by Hangul', async () => {
  const { status, body } = await api('/api/students/search?q=' + encodeURIComponent('김'))
  assert.strictEqual(status, 200)
  assert.ok(body.students.length >= 1)
  const kid = body.students.find((s) => s.korean_name === '김민준')
  assert.ok(kid, 'found 김민준')
  assert.strictEqual(kid.today_checked_in_at, null, 'not checked in yet today')
})

await t('live search finds the same child by English name', async () => {
  const { body } = await api('/api/students/search?q=minjun')
  assert.ok(body.students.some((s) => s.english_name === 'Minjun Kim'))
})

await t('search for an unknown name returns an empty list, not an error', async () => {
  const { status, body } = await api('/api/students/search?q=zzzznobody')
  assert.strictEqual(status, 200)
  assert.deepStrictEqual(body.students, [])
})

await t('registering a new student works without an admin session', async () => {
  const { status, body } = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({
      koreanName: `한서준${RUN}`,
      englishName: `Seojun Han ${RUN}`,
      grade: '4th',
      guardianName: '한지영',
      guardianPhone: '360-555-7788',
      allergies: '땅콩',
    }),
  })
  assert.strictEqual(status, 201)
  assert.strictEqual(body.student.korean_name, `한서준${RUN}`)
  studentId = body.student.id
})

await t('a student with neither name is rejected', async () => {
  const { status, body } = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({ koreanName: '  ', englishName: '', grade: '4th' }),
  })
  assert.strictEqual(status, 400)
  assert.ok(body.error.includes('이름'))
})

await t('a student with no grade is rejected', async () => {
  const { status } = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({ englishName: 'No Grade', grade: '' }),
  })
  assert.strictEqual(status, 400)
})

await t('an English-only student is accepted', async () => {
  const { status, body } = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({ englishName: 'Ashley Nolan', grade: '2nd' }),
  })
  assert.strictEqual(status, 201)
  assert.strictEqual(body.student.korean_name, null)
})

await t('the new student is immediately searchable', async () => {
  const { body } = await api('/api/students/search?q=' + encodeURIComponent(`한서준${RUN}`))
  assert.ok(body.students.some((s) => s.id === studentId))
})

await t('checking in returns a label payload with a 4-character code', async () => {
  const services = (await api('/api/settings')).body.services
  const { status, body } = await api('/api/checkins', {
    method: 'POST',
    body: JSON.stringify({ studentId, serviceId: services[0].id }),
  })
  assert.strictEqual(status, 200)
  assert.strictEqual(body.alreadyCheckedIn, false)
  assert.match(body.labelPayload.securityCode, /^[34679ACDEFGHJKMNPQRTUVWXY]{4}$/)
  assert.strictEqual(body.labelPayload.koreanName, `한서준${RUN}`)
  assert.strictEqual(body.labelPayload.englishName, `Seojun Han ${RUN}`)
  assert.strictEqual(body.labelPayload.grade, '4th')
  assert.strictEqual(body.labelPayload.serviceName, services[0].name)
  assert.ok(body.printer.mediaWidthMm > 0 && body.printer.labelLengthMm > 0)
  assert.ok('bridgeUrl' in body.printer, 'check-in hands the iPad everything it needs to print')
  assert.ok(body.autoReturnSeconds >= 2)
  checkInId = body.checkIn.id
  securityCode = body.labelPayload.securityCode
})

await t('checking in again reuses the row and the same code', async () => {
  const services = (await api('/api/settings')).body.services
  const { body } = await api('/api/checkins', {
    method: 'POST',
    body: JSON.stringify({ studentId, serviceId: services[0].id }),
  })
  assert.strictEqual(body.alreadyCheckedIn, true, 'recognised as a reprint')
  assert.strictEqual(body.labelPayload.securityCode, securityCode, 'code is stable across reprints')
  assert.strictEqual(body.checkIn.id, checkInId, 'no duplicate check-in row')
  assert.strictEqual(body.checkIn.reprints, 1)
})

await t('checking in an unknown student 404s', async () => {
  const { status } = await api('/api/checkins', {
    method: 'POST',
    body: JSON.stringify({ studentId: '00000000-0000-0000-0000-000000000000' }),
  })
  assert.strictEqual(status, 404)
})

await t('the search row now shows the child as checked in today', async () => {
  const { body } = await api('/api/students/search?q=' + encodeURIComponent(`한서준${RUN}`))
  const row = body.students.find((s) => s.id === studentId)
  assert.strictEqual(row.today_code, securityCode)
  assert.ok(row.today_checked_in_at)
})

await t("today's roll-up (with pickup codes) is closed without the admin code", async () => {
  const { status, body } = await api('/api/checkins/today')
  assert.strictEqual(status, 401)
  assert.strictEqual(body.checkIns, undefined, 'no names or pickup codes leak')
  const checkout = await api(`/api/checkins/${checkInId}`, {
    method: 'PATCH',
    body: JSON.stringify({ checkedOut: true }),
  })
  assert.strictEqual(checkout.status, 401, 'nobody can check a child out from the kiosk')
})

await t('a wrong admin code is refused', async () => {
  const { status } = await api('/api/admin/auth', {
    method: 'POST',
    body: JSON.stringify({ code: '9999' }),
  })
  assert.strictEqual(status, 401)
})

await t('admin-only endpoints are closed before signing in', async () => {
  assert.strictEqual((await api('/api/students')).status, 401)
  assert.strictEqual((await api('/api/stats')).status, 401)
  assert.strictEqual(
    (await api('/api/settings', { method: 'PATCH', body: '{}' })).status,
    401
  )
})

await t('the right admin code opens a session', async () => {
  const { status } = await api('/api/admin/auth', {
    method: 'POST',
    body: JSON.stringify({ code: ADMIN_CODE }),
  })
  assert.strictEqual(status, 200)
  assert.ok(cookie.startsWith('starlight_admin='), 'session cookie was set')
  const check = await api('/api/admin/auth')
  assert.strictEqual(check.body.authenticated, true)
})

await t("today's roll-up lists the check-in once signed in", async () => {
  const { status, body } = await api('/api/checkins/today')
  assert.strictEqual(status, 200)
  assert.strictEqual(body.total, 1)
  assert.strictEqual(body.checkedOut, 0)
  assert.deepStrictEqual(body.byGrade, [{ grade: '4th', count: 1 }])
})

// --- admin session --------------------------------------------------------
await t('the roster endpoint opens up once signed in', async () => {
  const { status, body } = await api('/api/students')
  assert.strictEqual(status, 200)
  assert.ok(body.students.length >= 8)
})

await t('the bridge address and key can be saved, and reach the kiosk', async () => {
  const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`
  const { status } = await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      printer: { bridgeUrl: `${bridgeUrl}/`, bridgeKey: BRIDGE_KEY, labelLengthMm: 90, copies: 1 },
    }),
  })
  assert.strictEqual(status, 200)

  // Read back without the admin cookie, the way the kiosk sees it.
  const saved = cookie
  cookie = ''
  const { body } = await api('/api/settings')
  cookie = saved
  assert.strictEqual(body.printer.bridgeUrl, bridgeUrl, 'trailing slash trimmed')
  assert.strictEqual(body.printer.bridgeKey, BRIDGE_KEY)
})

await t('a malformed bridge address is rejected', async () => {
  for (const bad of ['192.168.1.60:9443', 'ftp://192.168.1.60', 'not a url']) {
    const { status, body } = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ printer: { bridgeUrl: bad } }),
    })
    assert.strictEqual(status, 400, bad)
    assert.match(body.error, /브릿지 주소/)
  }
  const { body } = await api('/api/settings')
  assert.strictEqual(body.printer.bridgeUrl, `http://127.0.0.1:${BRIDGE_PORT}`, 'good value kept')
})

await t('settings values are clamped to sane ranges', async () => {
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ printer: { copies: 99, threshold: 5, labelLengthMm: 9999 } }),
  })
  const { body } = await api('/api/settings')
  assert.strictEqual(body.printer.copies, 5, 'copies capped')
  assert.strictEqual(body.printer.threshold, 40, 'threshold floored')
  assert.strictEqual(body.printer.labelLengthMm, 300, 'label length capped')
  // Put it back for the print test.
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ printer: { copies: 1, threshold: 160, labelLengthMm: 90 } }),
  })
})

await t('stats endpoint returns all of its aggregates', async () => {
  const { status, body } = await api('/api/stats')
  assert.strictEqual(status, 200)
  // Other suites may have left check-ins on other dates, so assert on today's
  // row rather than the size of the whole range.
  assert.ok(Array.isArray(body.daily) && body.daily.length >= 1)
  const todayRow = body.daily.find((d) => d.session_date.slice(0, 10) === body.today)
  assert.ok(todayRow, `today (${body.today}) is present in the daily roll-up`)
  assert.ok(todayRow.total >= 1)
  assert.ok(Array.isArray(body.byGrade))
  assert.ok(Array.isArray(body.byService))
  assert.ok(Array.isArray(body.perStudent))
  assert.ok(body.roster.active_students >= 8)
  assert.ok(body.perStudent.some((s) => s.visits === 0), 'non-attendees included')
})

// --- print queue ----------------------------------------------------------
await t('a check-in label goes API → iPad assembly → bridge → printer', async () => {
  const services = (await api('/api/settings')).body.services
  // Checking in again reprints, which is also exactly what a volunteer does.
  const checkIn = await api('/api/checkins', {
    method: 'POST',
    body: JSON.stringify({ studentId, serviceId: services[0].id }),
  })
  assert.strictEqual(checkIn.status, 200)
  const settings = checkIn.body.printer
  assert.strictEqual(settings.bridgeUrl, `http://127.0.0.1:${BRIDGE_PORT}`)

  const job = assembleFromSettings(settings, 120)
  const result = await printViaBridge(settings, job)
  assert.strictEqual(result.status, 200, JSON.stringify(result.body))
  assert.strictEqual(printer.jobs.length, 1)

  const payload = printer.jobs[0]
  assert.ok(payload.equals(job), 'printer received exactly what the iPad assembled')
  assert.deepStrictEqual(Array.from(payload.subarray(0, 200)), new Array(200).fill(0), 'invalidate')
  assert.deepStrictEqual(Array.from(payload.subarray(200, 202)), [0x1b, 0x40], 'ESC @')
  assert.deepStrictEqual(Array.from(payload.subarray(202, 206)), [0x1b, 0x69, 0x61, 0x01], 'raster mode')
  assert.deepStrictEqual(Array.from(payload.subarray(206, 209)), [0x1b, 0x69, 0x7a], 'ESC i z')
  assert.strictEqual(payload[211], 62, '62 mm tape')
  assert.strictEqual(payload.readUInt32LE(213), 120, 'raster line count')
  assert.ok(countSequence(payload, Buffer.from([0x67, 0x00])) >= 120, 'raster commands present')
  assert.strictEqual(payload[payload.length - 1], 0x1a, 'print and feed')
})

await t('print settings saved in the app shape the job that reaches the printer', async () => {
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ printer: { copies: 2, autocut: false } }),
  })
  try {
    const settings = (await api('/api/settings')).body.printer
    const before = printer.jobs.length
    const result = await printViaBridge(settings, assembleFromSettings(settings, 60))
    assert.strictEqual(result.status, 200)
    const payload = printer.jobs[before]
    assert.strictEqual(countSequence(payload, Buffer.from([0x1b, 0x69, 0x7a])), 2, 'two copies')
    const autocut = payload[payload.indexOf(Buffer.from([0x1b, 0x69, 0x4d])) + 3]
    assert.strictEqual(autocut, 0x00, 'autocut switched off')
  } finally {
    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ printer: { copies: 1, autocut: true } }),
    })
  }
})

await t('the wrong bridge key is refused before anything prints', async () => {
  const settings = (await api('/api/settings')).body.printer
  const before = printer.jobs.length
  const result = await printViaBridge({ ...settings, bridgeKey: 'stale-key' }, assembleFromSettings(settings))
  assert.strictEqual(result.status, 401)
  assert.strictEqual(printer.jobs.length, before)
})

await t('turning printing off is visible to the iPad at check-in', async () => {
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ printer: { enabled: false } }) })
  try {
    const services = (await api('/api/settings')).body.services
    const checkIn = await api('/api/checkins', {
      method: 'POST',
      body: JSON.stringify({ studentId, serviceId: services[0].id }),
    })
    assert.strictEqual(checkIn.body.printer.enabled, false, 'the iPad skips printing')
  } finally {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ printer: { enabled: true } }) })
  }
})

await t('a child can be checked out and the check-out undone', async () => {
  const out = await api(`/api/checkins/${checkInId}`, {
    method: 'PATCH',
    body: JSON.stringify({ checkedOut: true, checkedOutBy: '한지영' }),
  })
  assert.strictEqual(out.status, 200)
  assert.ok(out.body.checkIn.checked_out_at)

  const today = await api('/api/checkins/today')
  assert.strictEqual(today.body.checkedOut, 1)

  const undo = await api(`/api/checkins/${checkInId}`, {
    method: 'PATCH',
    body: JSON.stringify({ checkedOut: false }),
  })
  assert.strictEqual(undo.body.checkIn.checked_out_at, null)
})

await t('a student can be edited and soft-deleted', async () => {
  const edit = await api(`/api/students/${studentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ grade: '5th', allergies: '땅콩, 우유' }),
  })
  assert.strictEqual(edit.status, 200)
  assert.strictEqual(edit.body.student.grade, '5th')

  const del = await api(`/api/students/${studentId}`, { method: 'DELETE' })
  assert.strictEqual(del.body.mode, 'soft')

  const search = await api('/api/students/search?q=' + encodeURIComponent(`한서준${RUN}`))
  assert.ok(!search.body.students.some((s) => s.id === studentId), 'hidden from the kiosk')

  const today = await api('/api/checkins/today')
  assert.strictEqual(today.body.total, 1, 'attendance history survives the soft delete')
})

await t('signing out closes the admin endpoints again', async () => {
  await api('/api/admin/auth', { method: 'DELETE' })
  cookie = ''
  assert.strictEqual((await api('/api/students')).status, 401)
  assert.strictEqual((await api('/api/checkins/today')).status, 401)
})

await printer.close().catch(() => {})
bridge.kill()

function countSequence(buffer, needle) {
  let count = 0
  let index = 0
  while ((index = buffer.indexOf(needle, index)) !== -1) {
    count++
    index += needle.length
  }
  return count
}

console.log(`\n${pass} checks passed${failures.length ? `, ${failures.length} FAILED: ${failures.join(', ')}` : ''}`)
process.exit(failures.length ? 1 : 0)
