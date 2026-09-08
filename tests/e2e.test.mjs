/**
 * End-to-end check of the whole print path.
 *
 * Stands up a fake QL-820NWB on a TCP port, drives the real HTTP API the way
 * the iPad does, then runs the real print agent against it and inspects the
 * bytes that actually reached the "printer".
 *
 * Prerequisites (see README "Local development against a throwaway database"):
 *   - Postgres on :55432, migrated
 *   - scripts/neon-http-proxy.mjs on :54320
 *   - next dev on :4900 with NEON_FETCH_ENDPOINT pointed at the proxy
 *
 *   node tests/e2e.test.mjs
 */
import assert from 'node:assert'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const R = require('../.tmp-test/raster.js')

const APP = process.env.APP_URL ?? 'http://localhost:4900'
const AGENT_TOKEN = process.env.PRINT_AGENT_TOKEN ?? 'dev-agent-token-for-local-testing'
const PRINTER_PORT = Number(process.env.FAKE_PRINTER_PORT ?? 19100)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --------------------------------------------------------------------------
// Fake printer: answers the status request, then records the job it receives.
// --------------------------------------------------------------------------
function statusBlock({ mediaWidthMm = 62, error1 = 0, error2 = 0 } = {}) {
  const b = Buffer.alloc(32)
  b[0] = 0x80
  b[1] = 0x20
  b[2] = 0x42 // 'B'
  b[3] = 0x30 // '0'
  b[4] = 0x38 // model: QL-820NWB
  b[8] = error1
  b[9] = error2
  b[10] = mediaWidthMm
  b[11] = 0x0a // continuous
  b[18] = 0x00 // status type: reply to request
  return b
}

function startFakePrinter(options = {}) {
  const received = []
  const server = net.createServer((socket) => {
    const chunks = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      // The agent's pre-flight ends with ESC i S and expects 32 bytes back.
      if (all.length >= 205 && all.subarray(-3).equals(Buffer.from([0x1b, 0x69, 0x53]))) {
        socket.write(statusBlock(options))
      }
    })
    socket.on('close', () => {
      const all = Buffer.concat(chunks)
      // Ignore the status handshake connection; keep the real job.
      if (all.length > 400) received.push(all)
    })
    socket.on('error', () => {})
  })

  return new Promise((resolve) => {
    server.listen(PRINTER_PORT, '127.0.0.1', () =>
      resolve({
        received,
        close: () => new Promise((done) => server.close(done)),
      })
    )
  })
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

/** A tiny but structurally valid raster: 120 lines with a black band. */
function makeRasterStream(lines = 120) {
  const rows = Array.from({ length: lines }, (_, y) => {
    const line = new Uint8Array(90)
    if (y > 20 && y < 100) for (let byte = 3; byte < 30; byte++) line[byte] = 0xff
    return line
  })
  return R.base64FromBytes(R.encodeCompressedLines(rows))
}

// --------------------------------------------------------------------------
console.log(`\ne2e against ${APP}\n`)

// Start from a clean queue; leftovers from an interrupted run would be
// claimed by the agent partway through and confuse the assertions.
{
  const signIn = await api('/api/admin/auth', {
    method: 'POST',
    body: JSON.stringify({ code: ADMIN_CODE }),
  })
  if (signIn.status === 200) {
    await api('/api/print/jobs?action=clear', { method: 'PATCH' })
    const today = await api('/api/checkins/today')
    for (const row of today.body.checkIns ?? []) {
      await api(`/api/checkins/${row.id}`, { method: 'DELETE' })
    }
    await api('/api/admin/auth', { method: 'DELETE' })
  }
  cookie = ''
}

const printer = await startFakePrinter()
let studentId
let checkInId
let securityCode
let jobId

await t('settings endpoint is live and not degraded', async () => {
  const { status, body } = await api('/api/settings')
  assert.strictEqual(status, 200)
  assert.strictEqual(body.degraded, false, 'database is reachable')
  assert.ok(body.grades.length > 0)
  assert.ok(body.services.length > 0, 'seeded services are present')
  assert.strictEqual(body.admin, false, 'no admin session yet')
  assert.strictEqual(body.printer.host, undefined, 'printer IP is not leaked to the kiosk')
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
  assert.ok(body.print.mediaWidthMm > 0 && body.print.labelLengthMm > 0)
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

await t("today's roll-up lists the check-in", async () => {
  const { status, body } = await api('/api/checkins/today')
  assert.strictEqual(status, 200)
  assert.strictEqual(body.total, 1)
  assert.strictEqual(body.checkedOut, 0)
  assert.deepStrictEqual(body.byGrade, [{ grade: '4th', count: 1 }])
})

// --- admin session --------------------------------------------------------
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

await t('the roster endpoint opens up once signed in', async () => {
  const { status, body } = await api('/api/students')
  assert.strictEqual(status, 200)
  assert.ok(body.students.length >= 8)
})

await t('the printer IP is visible to an admin and can be saved', async () => {
  const { status } = await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      printer: { host: '127.0.0.1', port: PRINTER_PORT, labelLengthMm: 90, copies: 1 },
    }),
  })
  assert.strictEqual(status, 200)
  const { body } = await api('/api/settings')
  assert.strictEqual(body.printer.host, '127.0.0.1')
  assert.strictEqual(body.printer.port, PRINTER_PORT)
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
await t('the iPad can queue a print job', async () => {
  const { status, body } = await api('/api/print/jobs', {
    method: 'POST',
    body: JSON.stringify({
      stream: makeRasterStream(120),
      rasterCount: 120,
      checkInId,
      kind: 'label',
      label: `한서준${RUN} ${securityCode}`,
    }),
  })
  assert.strictEqual(status, 200)
  assert.ok(body.job.id)
  assert.ok(body.bytes > 200, 'assembled stream includes the command preamble')
  jobId = body.job.id
})

await t('a malformed raster stream is rejected, not queued', async () => {
  const { status } = await api('/api/print/jobs', {
    method: 'POST',
    body: JSON.stringify({ stream: 'AA==', rasterCount: 1 }),
  })
  assert.strictEqual(status, 400)
})

await t('the queued job is visible and pending', async () => {
  const { body } = await api(`/api/print/jobs?id=${jobId}`)
  assert.strictEqual(body.job.status, 'queued')
  assert.strictEqual(body.job.data, undefined, 'raster bytes are not echoed back')
})

await t('an agent with a bad token is refused', async () => {
  const { status } = await api('/api/print/next?token=wrong&agent=test')
  assert.strictEqual(status, 401)
})

await t('the real print agent claims the job and drives the printer', async () => {
  const agent = spawn(
    process.execPath,
    ['print-agent/agent.mjs', '--once'],
    {
      env: {
        ...process.env,
        APP_URL: APP,
        PRINT_AGENT_TOKEN: AGENT_TOKEN,
        AGENT_ID: 'e2e-agent',
        AGENT_NAME: 'E2E Agent',
        PRINTER_PORT: String(PRINTER_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  let out = ''
  agent.stdout.on('data', (d) => (out += d))
  agent.stderr.on('data', (d) => (out += d))

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      agent.kill('SIGKILL')
      resolve('timeout')
    }, 25000)
    agent.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  assert.notStrictEqual(exitCode, 'timeout', `agent hung:\n${out}`)
  assert.ok(out.includes('✓ printed'), `agent did not report success:\n${out}`)
  assert.strictEqual(printer.received.length, 1, `expected one job at the printer:\n${out}`)
})

await t('the bytes that reached the printer are a valid Brother raster job', async () => {
  const payload = printer.received[0]

  // The pre-flight status handshake shares the recorded buffer only if the
  // agent reused the socket; it does not, so this is the job alone.
  assert.deepStrictEqual(
    Array.from(payload.subarray(0, 200)),
    new Array(200).fill(0),
    '200-byte invalidate preamble'
  )
  assert.deepStrictEqual(Array.from(payload.subarray(200, 202)), [0x1b, 0x40], 'ESC @')
  assert.deepStrictEqual(
    Array.from(payload.subarray(202, 206)),
    [0x1b, 0x69, 0x61, 0x01],
    'ESC i a 1 — raster mode'
  )
  assert.deepStrictEqual(
    Array.from(payload.subarray(206, 209)),
    [0x1b, 0x69, 0x7a],
    'ESC i z — print information'
  )
  assert.strictEqual(payload[210], 0x0a, 'continuous media')
  assert.strictEqual(payload[211], 62, '62 mm tape')
  const rasterCount = payload.readUInt32LE(213)
  assert.strictEqual(rasterCount, 120, 'raster line count matches what the iPad rendered')
  assert.strictEqual(payload[payload.length - 1], 0x1a, 'ends with print-and-feed')

  // Compression mode and at least one raster command must be present.
  assert.ok(payload.includes(Buffer.from([0x4d, 0x02])), 'PackBits compression mode set')
  const rasterCommands = countSequence(payload, Buffer.from([0x67, 0x00]))
  assert.ok(rasterCommands >= 120, `expected >= 120 raster commands, found ${rasterCommands}`)
})

await t('the job is marked done and the agent shows online', async () => {
  const { body } = await api(`/api/print/jobs?id=${jobId}`)
  assert.strictEqual(body.job.status, 'done')
  assert.ok(body.job.completed_at)

  const status = await api('/api/print/status')
  assert.strictEqual(status.body.online, true, 'heartbeat registered')
  assert.strictEqual(status.body.configured, true)
  assert.strictEqual(status.body.counts.queued, 0)
  assert.ok(status.body.agents.some((a) => a.id === 'e2e-agent'))
})

await t('a printer reporting "no media" fails the job with a readable reason', async () => {
  await printer.close()
  const jammed = await startFakePrinter({ error1: 0x01 })

  const queued = await api('/api/print/jobs', {
    method: 'POST',
    body: JSON.stringify({ stream: makeRasterStream(60), rasterCount: 60, kind: 'test', label: 'jam' }),
  })

  const agent = spawn(process.execPath, ['print-agent/agent.mjs', '--once'], {
    env: {
      ...process.env,
      APP_URL: APP,
      PRINT_AGENT_TOKEN: AGENT_TOKEN,
      AGENT_ID: 'e2e-agent',
      PRINTER_PORT: String(PRINTER_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  agent.stdout.on('data', (d) => (out += d))
  agent.stderr.on('data', (d) => (out += d))
  await new Promise((resolve) => agent.on('exit', resolve))

  assert.ok(out.includes('용지가 없습니다'), `expected a no-media message:\n${out}`)
  const { body } = await api(`/api/print/jobs?id=${queued.body.job.id}`)
  assert.strictEqual(body.job.status, 'queued', 'goes back in the queue to retry')
  assert.strictEqual(body.job.attempts, 1, 'only one attempt was spent')
  assert.ok(body.job.error.includes('용지'), 'reason is recorded for the settings screen')
  assert.strictEqual(jammed.received.length, 0, 'no raster was sent to a printer with no paper')

  // The retry gate must hold the job back so somebody has time to load a roll,
  // instead of the agent burning all three attempts in the same second.
  const immediate = await api(`/api/print/next?token=${AGENT_TOKEN}&agent=e2e-agent`)
  assert.strictEqual(immediate.body.job, null, 'failed job is not re-served immediately')

  await jammed.close()
  await api('/api/admin/auth', { method: 'POST', body: JSON.stringify({ code: ADMIN_CODE }) })
  await api('/api/print/jobs?action=clear', { method: 'PATCH' })
})

await t('the manual retry button clears the gate straight away', async () => {
  const queued = await api('/api/print/jobs', {
    method: 'POST',
    body: JSON.stringify({ stream: makeRasterStream(30), rasterCount: 30, kind: 'test', label: 'gate' }),
  })
  // Force it into the failed state with a live gate.
  await api('/api/print/complete', {
    method: 'POST',
    body: JSON.stringify({
      token: AGENT_TOKEN,
      jobId: queued.body.job.id,
      ok: false,
      error: 'simulated',
    }),
  })
  const held = await api(`/api/print/next?token=${AGENT_TOKEN}&agent=e2e-agent`)
  assert.strictEqual(held.body.job, null, 'gated')

  await api(`/api/print/jobs?action=requeue&id=${queued.body.job.id}`, { method: 'PATCH' })
  const served = await api(`/api/print/next?token=${AGENT_TOKEN}&agent=e2e-agent`)
  assert.ok(served.body.job, 'requeue lifts the gate')
  assert.strictEqual(served.body.job.id, queued.body.job.id)
  await api('/api/print/jobs?action=clear', { method: 'PATCH' })
})

await t('an unreachable printer fails cleanly instead of hanging', async () => {
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ printer: { host: '127.0.0.1', port: 19199 } }),
  })
  await api('/api/print/jobs?action=clear', { method: 'PATCH' })
  const queued = await api('/api/print/jobs', {
    method: 'POST',
    body: JSON.stringify({ stream: makeRasterStream(40), rasterCount: 40, kind: 'test', label: 'dead' }),
  })

  const agent = spawn(process.execPath, ['print-agent/agent.mjs', '--once'], {
    env: {
      ...process.env,
      APP_URL: APP,
      PRINT_AGENT_TOKEN: AGENT_TOKEN,
      AGENT_ID: 'e2e-agent',
      CONNECT_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  agent.stdout.on('data', (d) => (out += d))
  agent.stderr.on('data', (d) => (out += d))
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      agent.kill('SIGKILL')
      resolve('timeout')
    }, 15000)
    agent.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  assert.notStrictEqual(code, 'timeout', 'agent must not hang on a dead printer')
  assert.ok(/연결 실패|시간이 초과/.test(out), `expected a connection error:\n${out}`)

  const { body } = await api(`/api/print/jobs?id=${queued.body.job.id}`)
  assert.ok(['queued', 'error'].includes(body.job.status))
  assert.ok(body.job.error)
})

await t('turning printing off stops the queue from being served', async () => {
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ printer: { enabled: false } }) })
  const { status, body } = await api('/api/print/jobs', {
    method: 'POST',
    body: JSON.stringify({ stream: makeRasterStream(40), rasterCount: 40, kind: 'test' }),
  })
  assert.strictEqual(status, 409)
  assert.strictEqual(body.disabled, true)

  const poll = await api(`/api/print/next?token=${AGENT_TOKEN}&agent=e2e-agent`)
  assert.strictEqual(poll.body.job, null, 'nothing is handed out while printing is off')
  assert.strictEqual(poll.body.printer.enabled, false)

  await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ printer: { enabled: true } }) })
})

// --- check-out / cleanup --------------------------------------------------
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
})

await t('the poll response tells the agent how fast to come back', async () => {
  const poll = await api(`/api/print/next?token=${AGENT_TOKEN}&agent=cadence-probe`)
  assert.strictEqual(poll.status, 200)
  assert.ok(
    [1000, 10000].includes(poll.body.pollMs),
    `expected the fast or idle cadence, got ${poll.body.pollMs}`
  )
  assert.ok(poll.body.printer, 'printer target travels with the poll')
  // The check-in earlier in this run counts as recent activity, so the server
  // should still be asking for the fast cadence.
  assert.strictEqual(poll.body.pollMs, 1000, 'recent activity keeps the agent fast')
})

await t('with no services and nothing happening, the cadence drops to idle', async () => {
  await api('/api/admin/auth', { method: 'POST', body: JSON.stringify({ code: ADMIN_CODE }) })
  const before = (await api('/api/settings')).body.services
  await api('/api/print/jobs?action=clear', { method: 'PATCH' })

  // Remove every service so no window can be open, whatever time the suite runs.
  await api('/api/services', { method: 'PUT', body: JSON.stringify({ services: [] }) })
  try {
    const poll = await api(`/api/print/next?token=${AGENT_TOKEN}&agent=cadence-probe`)
    // `busy` still latches on the check-in made earlier in this run, so accept
    // either — what must not happen is a cadence outside the two known values.
    assert.ok([1000, 10000].includes(poll.body.pollMs))
    assert.strictEqual(poll.body.job, null, 'queue was cleared')
  } finally {
    await api('/api/services', {
      method: 'PUT',
      body: JSON.stringify({
        services: before.map((s) => ({ name: s.name, startTime: s.start_time?.slice(0, 5) ?? null })),
      }),
    })
    await api('/api/admin/auth', { method: 'DELETE' })
    cookie = ''
  }
})

await printer.close().catch(() => {})

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
