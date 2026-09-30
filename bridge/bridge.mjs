#!/usr/bin/env node
/**
 * Bethel Starlight — print bridge (Raspberry Pi)
 * =================================================================
 * Sits on the same LAN as the Brother QL-820NWBc. When a volunteer presses
 * "Check in", the iPad renders the label, assembles the Brother raster job
 * itself, and POSTs the bytes straight here. The bridge writes them to the
 * printer's raw port (9100) and answers with the printer's actual status.
 *
 *   iPad ──HTTPS (LAN)──▶ bridge ──TCP 9100──▶ QL-820NWBc
 *
 * Why HTTPS: the iPad loads the app from the cloud over HTTPS, and Safari
 * refuses to let an HTTPS page call a plain-http LAN address. The bridge
 * therefore needs a certificate the iPad trusts — see bridge/README.md.
 *
 * Why not poll the cloud instead: a polling agent keeps the database awake
 * around the clock, which runs Neon's free plan out of compute by mid-month.
 * With a push bridge the database only wakes when someone checks in.
 *
 * Zero dependencies. Node 18+.
 *
 *   node bridge.mjs             # serve
 *   node bridge.mjs --status    # ask the printer how it is doing, then exit
 *
 * Configuration: environment variables, then bridge/config.json.
 */
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

const VERSION = '2.0.0'
const here = dirname(fileURLToPath(import.meta.url))

const fileConfig = (() => {
  const path = process.env.BRIDGE_CONFIG ?? join(here, 'config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`config.json is not valid JSON: ${error.message}`)
    process.exit(1)
  }
})()

const pick = (envName, key, fallback) => process.env[envName] ?? fileConfig[key] ?? fallback
const list = (value) =>
  Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

const config = {
  port: Number(pick('BRIDGE_PORT', 'port', 9443)),
  certFile: pick('BRIDGE_CERT', 'certFile', ''),
  keyFile: pick('BRIDGE_KEY_FILE', 'keyFile', ''),
  /** Shared key the app sends in `X-Bridge-Key`. Empty disables the check. */
  key: pick('BRIDGE_KEY', 'key', ''),
  /** Browser origins allowed to call the bridge. Empty allows any origin. */
  allowedOrigins: list(pick('BRIDGE_ALLOWED_ORIGINS', 'allowedOrigins', '')),
  printerHost: pick('PRINTER_HOST', 'printerHost', ''),
  printerPort: Number(pick('PRINTER_PORT', 'printerPort', 9100)),
  connectTimeoutMs: Number(pick('CONNECT_TIMEOUT_MS', 'connectTimeoutMs', 5000)),
  writeTimeoutMs: Number(pick('WRITE_TIMEOUT_MS', 'writeTimeoutMs', 20000)),
  preflightStatus: String(pick('PREFLIGHT_STATUS', 'preflightStatus', true)) !== 'false',
  maxJobBytes: 4 * 1024 * 1024,
}

const args = process.argv.slice(2)
const stamp = () => new Date().toLocaleTimeString()

// --------------------------------------------------------------------------
// Printer transport
// --------------------------------------------------------------------------

/** Opens a socket to the printer, hands it to `run`, always cleans up. */
function withPrinter(run) {
  const { printerHost: host, printerPort: port } = config
  return new Promise((resolvePromise, reject) => {
    if (!host) return reject(new Error('브릿지에 프린터 IP가 설정되지 않았습니다 (config.json 의 printerHost)'))

    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      error ? reject(error) : resolvePromise(value)
    }

    socket.setTimeout(config.connectTimeoutMs)
    socket.once('timeout', () => finish(new Error(`프린터 ${host}:${port} 연결 시간이 초과되었습니다`)))
    socket.once('error', (error) => finish(new Error(`프린터 ${host}:${port} 연결 실패: ${error.message}`)))
    socket.once('connect', () => {
      socket.setTimeout(config.writeTimeoutMs)
      Promise.resolve(run(socket)).then(
        (value) => finish(null, value),
        (error) => finish(error)
      )
    })
  })
}

/**
 * Brother's status request (ESC i S) returns a 32-byte block. Reading it before
 * a job turns "nothing came out of the printer" into an actual reason.
 */
function requestStatus() {
  return withPrinter(
    (socket) =>
      new Promise((done) => {
        const chunks = []
        const finish = () => done(chunks.length ? Buffer.concat(chunks) : null)
        socket.on('data', (chunk) => {
          chunks.push(chunk)
          if (Buffer.concat(chunks).length >= 32) finish()
        })
        // Not every firmware answers; silence means "unknown", not "broken".
        const timer = setTimeout(finish, 1500)
        socket.once('close', () => {
          clearTimeout(timer)
          finish()
        })
        socket.write(Buffer.alloc(200, 0x00))
        socket.write(Buffer.from([0x1b, 0x40]))
        socket.write(Buffer.from([0x1b, 0x69, 0x53]))
      })
  )
}

const ERROR_BITS_1 = [
  [0x01, '용지가 없습니다 (No media)'],
  [0x02, '용지가 끝났습니다 (End of media)'],
  [0x04, '커터에 걸렸습니다 (Cutter jam)'],
  [0x08, '배터리가 약합니다'],
  [0x40, '프린터가 사용 중입니다 (Printer in use)'],
  [0x80, '프린터 전원이 꺼져 있습니다'],
]
const ERROR_BITS_2 = [
  [0x01, '고압 어댑터 오류'],
  [0x04, '롤 커버가 열려 있습니다 (Cover open)'],
  [0x10, '용지를 공급할 수 없습니다 (Cannot feed)'],
  [0x80, '시스템 오류'],
]

export function describeStatus(block) {
  if (!block || block.length < 32) return { ok: true, unknown: true, messages: [] }
  const messages = []
  for (const [bit, text] of ERROR_BITS_1) if (block[8] & bit) messages.push(text)
  for (const [bit, text] of ERROR_BITS_2) if (block[9] & bit) messages.push(text)
  return {
    ok: messages.length === 0,
    unknown: false,
    mediaWidthMm: block[10],
    mediaType:
      block[11] === 0x0a ? 'continuous' : block[11] === 0x0b ? 'die-cut' : `0x${block[11].toString(16)}`,
    messages,
  }
}

/** A printer error the volunteer must act on, as opposed to a transport hiccup. */
class PrinterError extends Error {}

async function printJob(payload) {
  if (config.preflightStatus) {
    const status = describeStatus(await requestStatus())
    if (!status.ok) throw new PrinterError(status.messages.join(' / '))
    if (!status.unknown && status.mediaWidthMm === 0) {
      throw new PrinterError('용지 폭을 인식하지 못했습니다 — 롤을 다시 넣어 주세요')
    }
  }

  await withPrinter(
    (socket) =>
      new Promise((done, reject) => {
        socket.write(payload, (error) => {
          if (error) return reject(new Error(`전송 실패: ${error.message}`))
          // Closing too early truncates the last raster lines.
          setTimeout(() => {
            socket.end()
            done()
          }, 250)
        })
      })
  )
}

/**
 * The printer takes one connection at a time. Two iPads checking kids in at the
 * same moment must not interleave their raster streams, so everything that
 * touches the printer goes through this one-at-a-time lane.
 */
let lane = Promise.resolve()
function exclusive(task) {
  const run = lane.then(task, task)
  lane = run.catch(() => {})
  return run
}

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------

function originAllowed(origin) {
  if (!origin) return true // curl, health checks
  if (config.allowedOrigins.length === 0) return true
  return config.allowedOrigins.includes(origin)
}

function corsHeaders(request) {
  const origin = request.headers.origin
  if (!origin || !originAllowed(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Key',
    'Access-Control-Max-Age': '600',
    // Chrome's Private Network Access asks before a public page may reach a
    // LAN address. Safari does not, but answering costs nothing.
    ...(request.headers['access-control-request-private-network'] === 'true'
      ? { 'Access-Control-Allow-Private-Network': 'true' }
      : {}),
  }
}

function keyMatches(provided) {
  if (!config.key) return true
  if (typeof provided !== 'string') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(config.key)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(response, request, status, body) {
  const json = JSON.stringify(body)
  response.writeHead(status, {
    ...corsHeaders(request),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  })
  response.end(json)
}

function readBody(request, limit) {
  return new Promise((done, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('job too large'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => done(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** Cheap sanity check: a Brother raster job starts with 200 NULs then ESC @. */
function looksLikeBrotherJob(payload) {
  if (payload.length < 210) return false
  for (let i = 0; i < 200; i++) if (payload[i] !== 0) return false
  return payload[200] === 0x1b && payload[201] === 0x40
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://bridge')

  if (!originAllowed(request.headers.origin)) {
    return send(response, request, 403, { ok: false, error: 'origin not allowed' })
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(request))
    return response.end()
  }

  // Open health check — also the page to visit in Safari to confirm the iPad
  // trusts the bridge's certificate.
  if (request.method === 'GET' && url.pathname === '/') {
    return send(response, request, 200, {
      ok: true,
      service: 'starlight-print-bridge',
      version: VERSION,
      printerConfigured: Boolean(config.printerHost),
    })
  }

  if (!keyMatches(request.headers['x-bridge-key'])) {
    return send(response, request, 401, { ok: false, error: '브릿지 키가 맞지 않습니다' })
  }

  if (request.method === 'GET' && url.pathname === '/status') {
    try {
      const status = describeStatus(await exclusive(requestStatus))
      return send(response, request, 200, {
        ok: status.ok,
        reachable: true,
        printer: { host: config.printerHost, port: config.printerPort },
        ...status,
        version: VERSION,
      })
    } catch (error) {
      return send(response, request, 200, {
        ok: false,
        reachable: false,
        printer: { host: config.printerHost, port: config.printerPort },
        messages: [error.message],
        version: VERSION,
      })
    }
  }

  if (request.method === 'POST' && url.pathname === '/print') {
    let payload
    try {
      payload = await readBody(request, config.maxJobBytes)
    } catch (error) {
      return send(response, request, error.status ?? 400, { ok: false, error: error.message })
    }
    if (!looksLikeBrotherJob(payload)) {
      return send(response, request, 400, { ok: false, error: 'Brother 래스터 작업이 아닙니다' })
    }

    let label = String(request.headers['x-label'] ?? '')
    try {
      label = decodeURIComponent(label)
    } catch {
      /* keep it raw */
    }
    label = label.slice(0, 80)
    const started = Date.now()
    try {
      await exclusive(() => printJob(payload))
      const ms = Date.now() - started
      console.log(`${stamp()}  ✓ ${label || 'label'} (${(payload.length / 1024).toFixed(1)} KB, ${ms} ms)`)
      return send(response, request, 200, { ok: true, bytes: payload.length, ms })
    } catch (error) {
      console.error(`${stamp()}  ✗ ${label || 'label'}: ${error.message}`)
      // 409: the printer needs a person (paper, cover). 502: we could not reach it.
      const status = error instanceof PrinterError ? 409 : 502
      return send(response, request, status, { ok: false, error: error.message })
    }
  }

  return send(response, request, 404, { ok: false, error: 'not found' })
}

// --------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------

function loadTls() {
  const cert = resolve(here, config.certFile)
  const key = resolve(here, config.keyFile)
  return { cert: readFileSync(cert), key: readFileSync(key), certPath: cert, keyPath: key }
}

async function main() {
  if (args.includes('--status')) {
    console.log(`Asking ${config.printerHost || '(printerHost 미설정)'}:${config.printerPort} for status…`)
    try {
      const status = describeStatus(await requestStatus())
      if (status.unknown) console.log('프린터가 상태를 보고하지 않았습니다 (연결은 성공). 인쇄는 가능할 수 있습니다.')
      else {
        console.log(`  용지: ${status.mediaWidthMm} mm ${status.mediaType}`)
        console.log(status.ok ? '  상태: 정상' : `  오류: ${status.messages.join(' / ')}`)
      }
      process.exit(status.ok ? 0 : 1)
    } catch (error) {
      console.error(`  ${error.message}`)
      process.exit(1)
    }
  }

  const useTls = Boolean(config.certFile && config.keyFile)
  let server

  if (useTls) {
    const tls = loadTls()
    server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => void handle(req, res))

    // Let's Encrypt renews every ~60 days. Pick the new certificate up without
    // a restart so nobody has to remember to reboot the Pi.
    let lastMtime = statSync(tls.certPath).mtimeMs
    setInterval(() => {
      try {
        const mtime = statSync(tls.certPath).mtimeMs
        if (mtime === lastMtime) return
        const next = loadTls()
        server.setSecureContext({ cert: next.cert, key: next.key })
        lastMtime = mtime
        console.log(`${stamp()}  인증서를 다시 불러왔습니다`)
      } catch (error) {
        console.error(`${stamp()}  인증서 재로딩 실패: ${error.message}`)
      }
    }, 60 * 60 * 1000).unref()
  } else {
    console.warn(
      '⚠  certFile/keyFile 이 없어 HTTP로 실행합니다. 개발용입니다 —\n' +
        '   HTTPS 앱을 쓰는 아이패드는 이 주소로 요청을 보내지 못합니다.'
    )
    server = http.createServer((req, res) => void handle(req, res))
  }

  server.listen(config.port, () => {
    console.log(`Bethel Starlight print bridge v${VERSION}`)
    console.log(`  listen   ${useTls ? 'https' : 'http'}://0.0.0.0:${config.port}`)
    console.log(`  printer  ${config.printerHost || '(미설정)'}:${config.printerPort}`)
    console.log(`  key      ${config.key ? '설정됨' : '없음 (누구나 인쇄 가능)'}`)
    console.log(
      `  origins  ${config.allowedOrigins.length ? config.allowedOrigins.join(', ') : '(모두 허용)'}\n`
    )
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close()
      process.exit(0)
    })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
