/**
 * Raspberry Pi print bridge checks.
 *
 * Runs the real bridge process against a fake QL-820NWBc — no database, no
 * app server. Covers the HTTP contract the iPad relies on, the one-at-a-time
 * printer lane, CORS for a cross-origin HTTPS page, and HTTPS itself using a
 * certificate issued by bridge/make-cert.sh.
 *
 *   npm test && node tests/bridge.test.mjs
 */
import assert from 'node:assert'
import https from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startFakePrinter } from './fake-printer.mjs'

const require = createRequire(import.meta.url)
const R = require('../.tmp-test/raster.js')
const B = require('../.tmp-test/brother.js')

const PRINTER_PORT = 19110
const BRIDGE_PORT = 19443
const KEY = 'test-bridge-key'
const APP_ORIGIN = 'https://starlight.example'

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

/** A real Brother job, assembled exactly as the iPad does it. */
function makeJob(lines = 80, marker = 0xff) {
  const rows = Array.from({ length: lines }, (_, y) => {
    const line = new Uint8Array(90)
    if (y > 10 && y < lines - 10) for (let i = 3; i < 30; i++) line[i] = marker
    return line
  })
  return Buffer.from(B.assembleJob(R.encodeCompressedLines(rows), { mediaWidthMm: 62 }))
}

function startBridge(env = {}) {
  const child = spawn(process.execPath, ['bridge/bridge.mjs'], {
    env: {
      ...process.env,
      BRIDGE_CONFIG: '/nonexistent/config.json', // never pick up a real config
      BRIDGE_PORT: String(BRIDGE_PORT),
      PRINTER_HOST: '127.0.0.1',
      PRINTER_PORT: String(PRINTER_PORT),
      BRIDGE_KEY: KEY,
      BRIDGE_ALLOWED_ORIGINS: APP_ORIGIN,
      CONNECT_TIMEOUT_MS: '1500',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start:\n${log}`)), 5000)
    child.stdout.on('data', () => {
      if (log.includes('listen')) {
        clearTimeout(timer)
        resolve({ child, log: () => log, stop: () => new Promise((r) => { child.once('exit', r); child.kill() }) })
      }
    })
  })
}

const base = `http://127.0.0.1:${BRIDGE_PORT}`
const withKey = (headers = {}) => ({ 'X-Bridge-Key': KEY, ...headers })

async function print(body, headers = withKey()) {
  const response = await fetch(`${base}/print`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  })
  return { status: response.status, body: await response.json() }
}

// ==========================================================================
console.log('\nbridge (HTTP mode)\n')

let printer = await startFakePrinter(PRINTER_PORT)
let bridge = await startBridge()

await t('health check answers without a key', async () => {
  const response = await fetch(`${base}/`)
  const body = await response.json()
  assert.strictEqual(response.status, 200)
  assert.strictEqual(body.service, 'starlight-print-bridge')
  assert.strictEqual(body.printerConfigured, true)
})

await t('status and print refuse a missing or wrong key', async () => {
  assert.strictEqual((await fetch(`${base}/status`)).status, 401)
  assert.strictEqual((await fetch(`${base}/status`, { headers: { 'X-Bridge-Key': 'nope' } })).status, 401)
  assert.strictEqual((await print(makeJob(), {})).status, 401)
  assert.strictEqual(printer.jobs.length, 0, 'nothing reached the printer')
})

await t('status reports the printer and the loaded tape', async () => {
  const response = await fetch(`${base}/status`, { headers: withKey() })
  const body = await response.json()
  assert.strictEqual(body.reachable, true)
  assert.strictEqual(body.ok, true)
  assert.strictEqual(body.mediaWidthMm, 62)
  assert.strictEqual(body.mediaType, 'continuous')
  assert.deepStrictEqual(body.printer, { host: '127.0.0.1', port: PRINTER_PORT })
})

await t('a valid job reaches the printer byte-for-byte', async () => {
  const job = makeJob()
  const result = await print(job, withKey({ 'X-Label': encodeURIComponent('김민준 H7KM') }))
  assert.strictEqual(result.status, 200, JSON.stringify(result.body))
  assert.strictEqual(result.body.ok, true)
  assert.strictEqual(result.body.bytes, job.length)
  assert.strictEqual(printer.jobs.length, 1)
  assert.ok(printer.jobs[0].equals(job), 'printer received exactly the bytes the iPad sent')
  assert.ok(bridge.log().includes('김민준 H7KM'), 'Korean label is decoded in the bridge log')
})

await t('the printer is asked for its status before every job', async () => {
  const before = printer.statusRequests
  await print(makeJob())
  assert.strictEqual(printer.statusRequests, before + 1)
})

await t('anything that is not a Brother job is refused', async () => {
  const before = printer.jobs.length
  const garbage = await print(Buffer.alloc(1000, 0x41))
  assert.strictEqual(garbage.status, 400)
  const tiny = await print(Buffer.alloc(10))
  assert.strictEqual(tiny.status, 400)
  assert.strictEqual(printer.jobs.length, before)
})

await t('an oversized upload is cut off', async () => {
  const huge = Buffer.alloc(5 * 1024 * 1024)
  huge[200] = 0x1b
  huge[201] = 0x40
  const response = await fetch(`${base}/print`, {
    method: 'POST',
    headers: withKey({ 'Content-Type': 'application/octet-stream' }),
    body: huge,
  }).catch((error) => ({ status: 'reset', error }))
  // The bridge either answers 413 or drops the connection mid-upload.
  assert.ok(response.status === 413 || response.status === 'reset', `got ${response.status}`)
})

await t('two iPads printing at once never interleave on the printer', async () => {
  const before = printer.jobs.length
  const a = makeJob(120, 0xaa)
  const b = makeJob(120, 0x55)
  const results = await Promise.all([print(a), print(b)])
  assert.deepStrictEqual(results.map((r) => r.status), [200, 200])
  const received = printer.jobs.slice(before)
  assert.strictEqual(received.length, 2)
  // Each connection carried one whole job — never a mix of the two.
  for (const job of received) assert.ok(job.equals(a) || job.equals(b), 'job arrived intact')
  assert.ok(!received[0].equals(received[1]), 'both jobs arrived')
})

await t('CORS preflight from the app origin is allowed, incl. private network', async () => {
  const response = await fetch(`${base}/print`, {
    method: 'OPTIONS',
    headers: {
      Origin: APP_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-bridge-key',
      'Access-Control-Request-Private-Network': 'true',
    },
  })
  assert.strictEqual(response.status, 204)
  assert.strictEqual(response.headers.get('access-control-allow-origin'), APP_ORIGIN)
  assert.match(response.headers.get('access-control-allow-headers'), /X-Bridge-Key/i)
  assert.strictEqual(response.headers.get('access-control-allow-private-network'), 'true')
})

await t('a real response carries CORS headers for the app origin', async () => {
  const response = await fetch(`${base}/status`, { headers: withKey({ Origin: APP_ORIGIN }) })
  assert.strictEqual(response.headers.get('access-control-allow-origin'), APP_ORIGIN)
})

await t('other origins are refused outright', async () => {
  const response = await fetch(`${base}/print`, {
    method: 'POST',
    headers: withKey({ Origin: 'https://evil.example', 'Content-Type': 'application/octet-stream' }),
    body: makeJob(),
  })
  assert.strictEqual(response.status, 403)
})

await printer.close()

await t('a printer with no paper fails with 409 and a readable reason', async () => {
  printer = await startFakePrinter(PRINTER_PORT, { error1: 0x01 })
  const result = await print(makeJob())
  assert.strictEqual(result.status, 409)
  assert.match(result.body.error, /용지가 없습니다/)
  assert.strictEqual(printer.jobs.length, 0, 'no raster sent to a printer without paper')

  const status = await (await fetch(`${base}/status`, { headers: withKey() })).json()
  assert.strictEqual(status.reachable, true)
  assert.strictEqual(status.ok, false)
  assert.ok(status.messages.some((m) => m.includes('용지')))
  await printer.close()
})

await t('an open cover is reported too', async () => {
  printer = await startFakePrinter(PRINTER_PORT, { error2: 0x04 })
  const result = await print(makeJob())
  assert.strictEqual(result.status, 409)
  assert.match(result.body.error, /커버/)
  await printer.close()
})

await t('an unreachable printer fails fast with 502', async () => {
  const started = Date.now()
  const result = await print(makeJob())
  assert.strictEqual(result.status, 502)
  assert.match(result.body.error, /연결/)
  assert.ok(Date.now() - started < 5000, 'does not hang')

  const status = await (await fetch(`${base}/status`, { headers: withKey() })).json()
  assert.strictEqual(status.reachable, false)
})

await bridge.stop()

// ==========================================================================
console.log('\nbridge (HTTPS mode, certificate from make-cert.sh)\n')

const certDir = mkdtempSync(join(tmpdir(), 'starlight-cert-'))
copyFileSync('bridge/make-cert.sh', join(certDir, 'make-cert.sh'))
execFileSync('bash', [join(certDir, 'make-cert.sh'), '127.0.0.1', 'localhost'], { stdio: 'ignore' })
const ca = readFileSync(join(certDir, 'certs', 'ca.crt'))

printer = await startFakePrinter(PRINTER_PORT)
bridge = await startBridge({
  BRIDGE_CERT: join(certDir, 'certs', 'bridge.crt'),
  BRIDGE_KEY_FILE: join(certDir, 'certs', 'bridge.key'),
})

function httpsRequest(path, { method = 'GET', headers = {}, body, trust = true } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { host: '127.0.0.1', port: BRIDGE_PORT, path, method, headers, ca: trust ? ca : undefined },
      (response) => {
        const chunks = []
        response.on('data', (c) => chunks.push(c))
        response.on('end', () =>
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
        )
      }
    )
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

await t('serves HTTPS with a certificate the local CA vouches for', async () => {
  const response = await httpsRequest('/')
  assert.strictEqual(response.status, 200)
  assert.strictEqual(response.body.service, 'starlight-print-bridge')
})

await t('a client that does not trust the CA is refused (TLS is real)', async () => {
  await assert.rejects(() => httpsRequest('/', { trust: false }), /self[- ]signed|unable to verify|certificate/i)
})

await t('prints over HTTPS', async () => {
  const job = makeJob()
  const response = await httpsRequest('/print', {
    method: 'POST',
    headers: withKey({ 'Content-Type': 'application/octet-stream', 'Content-Length': job.length }),
    body: job,
  })
  assert.strictEqual(response.status, 200, JSON.stringify(response.body))
  assert.strictEqual(printer.jobs.length, 1)
  assert.ok(printer.jobs[0].equals(job))
})

await bridge.stop()

await t('--status checks the printer from the command line', async () => {
  // Must be async: the fake printer lives in this process, and a sync spawn
  // would block the event loop it needs to answer on.
  const child = spawn(process.execPath, ['bridge/bridge.mjs', '--status'], {
    env: {
      ...process.env,
      BRIDGE_CONFIG: '/nonexistent/config.json',
      PRINTER_HOST: '127.0.0.1',
      PRINTER_PORT: String(PRINTER_PORT),
    },
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.strictEqual(code, 0, out)
  assert.match(out, /62 mm continuous/)
  assert.match(out, /정상/)
})

await printer.close()
rmSync(certDir, { recursive: true, force: true })

console.log(`\n${pass} checks passed${failures.length ? `, ${failures.length} FAILED: ${failures.join(', ')}` : ''}`)
process.exit(failures.length ? 1 : 0)
