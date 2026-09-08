#!/usr/bin/env node
/**
 * Bethel Starlight — LAN print agent
 * =================================================================
 * Runs on any always-on machine on the same network as the Brother
 * QL-820NWB. Polls the app for queued print jobs and writes the bytes
 * straight to the printer's raw port (9100).
 *
 * Why this exists: the iPad loads the app over HTTPS from the cloud, and Safari
 * will not let an HTTPS page open a connection to a plain-HTTP LAN address. So
 * instead of the iPad talking to the printer, the printer's side of the network
 * reaches out to the app. That also means print jobs survive the agent being
 * down — they just queue until it comes back.
 *
 * Zero dependencies. Node 18+.
 *
 *   node agent.mjs                 # run
 *   node agent.mjs --status        # ask the printer how it is doing and exit
 *   node agent.mjs --once          # handle at most one job, then exit
 *
 * Configuration, in order of precedence:
 *   1. environment variables
 *   2. print-agent/config.json     (copy config.example.json)
 */
import net from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const VERSION = '1.0.0'
const here = dirname(fileURLToPath(import.meta.url))

const fileConfig = (() => {
  const path = join(here, 'config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`config.json is not valid JSON: ${error.message}`)
    process.exit(1)
  }
})()

const config = {
  appUrl: (process.env.APP_URL ?? fileConfig.appUrl ?? '').replace(/\/+$/, ''),
  token: process.env.PRINT_AGENT_TOKEN ?? fileConfig.token ?? '',
  agentId: process.env.AGENT_ID ?? fileConfig.agentId ?? `agent-${os.hostname()}`,
  agentName: process.env.AGENT_NAME ?? fileConfig.agentName ?? os.hostname(),
  printerHost: process.env.PRINTER_HOST ?? fileConfig.printerHost ?? '',
  printerPort: Number(process.env.PRINTER_PORT ?? fileConfig.printerPort ?? 9100),
  // The server decides the cadence (see src/lib/poll-interval.ts). Setting
  // POLL_MS / pollMs here overrides it, which is only useful for debugging.
  pollMsOverride: Number(process.env.POLL_MS ?? fileConfig.pollMs ?? 0) || null,
  fallbackPollMs: 5000,
  failurePauseMs: Number(process.env.FAILURE_PAUSE_MS ?? fileConfig.failurePauseMs ?? 5000),
  connectTimeoutMs: Number(process.env.CONNECT_TIMEOUT_MS ?? fileConfig.connectTimeoutMs ?? 6000),
  writeTimeoutMs: Number(process.env.WRITE_TIMEOUT_MS ?? fileConfig.writeTimeoutMs ?? 20000),
  preflightStatus: process.env.PREFLIGHT_STATUS
    ? process.env.PREFLIGHT_STATUS !== '0'
    : (fileConfig.preflightStatus ?? true),
}

const args = process.argv.slice(2)
const onlyStatus = args.includes('--status')
const once = args.includes('--once')

if (!onlyStatus && (!config.appUrl || !config.token)) {
  console.error(
    'Missing configuration.\n' +
      '  APP_URL           e.g. https://starlight-checkin.vercel.app\n' +
      '  PRINT_AGENT_TOKEN must match the value set in the app environment\n\n' +
      'Set them as environment variables or in print-agent/config.json.'
  )
  process.exit(1)
}

// --------------------------------------------------------------------------
// Printer transport
// --------------------------------------------------------------------------

/** Opens a socket, hands it to `run`, and always cleans up. */
function withPrinter(host, port, run) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      error ? reject(error) : resolve(value)
    }

    socket.setTimeout(config.connectTimeoutMs)
    socket.once('timeout', () =>
      finish(new Error(`프린터 ${host}:${port} 연결 시간이 초과되었습니다`))
    )
    socket.once('error', (error) =>
      finish(new Error(`프린터 ${host}:${port} 연결 실패: ${error.message}`))
    )
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
function requestStatus(host, port) {
  return withPrinter(host, port, (socket) => {
    return new Promise((resolve) => {
      const chunks = []
      const done = () => resolve(chunks.length ? Buffer.concat(chunks) : null)

      socket.on('data', (chunk) => {
        chunks.push(chunk)
        if (Buffer.concat(chunks).length >= 32) done()
      })
      // Not every firmware/connection answers; treat silence as "unknown".
      const timer = setTimeout(done, 1500)
      socket.once('close', () => {
        clearTimeout(timer)
        done()
      })

      // Invalidate + initialise, then ask.
      socket.write(Buffer.alloc(200, 0x00))
      socket.write(Buffer.from([0x1b, 0x40]))
      socket.write(Buffer.from([0x1b, 0x69, 0x53]))
    })
  })
}

const ERROR_BITS_1 = [
  [0x01, '용지가 없습니다 (No media)'],
  [0x02, '엔드 오브 미디어'],
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

function describeStatus(block) {
  if (!block || block.length < 32) return { ok: true, unknown: true, messages: [] }

  const messages = []
  for (const [bit, text] of ERROR_BITS_1) if (block[8] & bit) messages.push(text)
  for (const [bit, text] of ERROR_BITS_2) if (block[9] & bit) messages.push(text)

  return {
    ok: messages.length === 0,
    unknown: false,
    mediaWidthMm: block[10],
    mediaType: block[11] === 0x0a ? 'continuous' : block[11] === 0x0b ? 'die-cut' : `0x${block[11].toString(16)}`,
    messages,
  }
}

async function sendToPrinter(host, port, payload) {
  if (config.preflightStatus) {
    try {
      const status = describeStatus(await requestStatus(host, port))
      if (!status.ok) throw new Error(status.messages.join(' / '))
      if (!status.unknown && status.mediaWidthMm === 0) {
        throw new Error('용지 폭을 인식하지 못했습니다 — 롤을 다시 넣어 주세요')
      }
    } catch (error) {
      // A refused connection here is a real failure; a silent printer is not.
      if (/연결 실패|시간이 초과/.test(error.message)) throw error
      if (!/^용지|^커터|^롤|^프린터|^시스템|^고압|^배터리|^엔드/.test(error.message)) {
        console.warn(`  status check inconclusive: ${error.message}`)
      } else {
        throw error
      }
    }
  }

  await withPrinter(host, port, (socket) => {
    return new Promise((resolve, reject) => {
      socket.write(payload, (error) => {
        if (error) return reject(new Error(`전송 실패: ${error.message}`))
        // Give the printer a moment to take the whole buffer before we hang up;
        // closing too early truncates the last raster lines.
        setTimeout(() => {
          socket.end()
          resolve()
        }, 250)
      })
    })
  })
}

// --------------------------------------------------------------------------
// App transport
// --------------------------------------------------------------------------

async function claimJob() {
  const params = new URLSearchParams({
    token: config.token,
    agent: config.agentId,
    name: config.agentName,
    version: VERSION,
  })
  if (config.printerHost) params.set('host', config.printerHost)

  const response = await fetch(`${config.appUrl}/api/print/next?${params}`, {
    headers: { 'x-agent-token': config.token },
  })

  if (response.status === 401) throw new Error('PRINT_AGENT_TOKEN 이 서버 값과 다릅니다')
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => body.error)
      .catch(() => null)
    throw new Error(detail ? `${response.status}: ${detail}` : `서버 응답 ${response.status}`)
  }
  return response.json()
}

async function reportJob(jobId, ok, errorMessage) {
  await fetch(`${config.appUrl}/api/print/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': config.token },
    body: JSON.stringify({
      token: config.token,
      agent: config.agentId,
      jobId,
      ok,
      error: errorMessage,
    }),
  }).catch((error) => console.error(`  could not report job ${jobId}: ${error.message}`))
}

// --------------------------------------------------------------------------
// Main loop
// --------------------------------------------------------------------------

let running = true
let consecutiveFailures = 0
let nextPollMs = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toLocaleTimeString()

async function tick() {
  const result = await claimJob()
  // The app owns the printer address so it can be changed from the Settings
  // screen without touching this machine; local config is the fallback.
  const host = result.printer?.host || config.printerHost
  const port = result.printer?.port || config.printerPort
  const job = result.job

  // The server tells us how fast to come back; it knows the service schedule
  // and whether anything has happened recently.
  nextPollMs =
    config.pollMsOverride ?? (Number(result.pollMs) || config.fallbackPollMs)

  if (!job) return 'idle'

  if (!host) {
    console.error(`${stamp()}  job ${job.id}: 프린터 IP가 설정되지 않았습니다`)
    await reportJob(job.id, false, '프린터 IP가 설정되지 않았습니다 (설정 화면에서 입력)')
    return 'failed'
  }

  const payload = Buffer.from(job.data, 'base64')
  console.log(
    `${stamp()}  job ${job.id.slice(0, 8)} [${job.kind}] ${job.label ?? ''} → ${host}:${port} (${(
      payload.length / 1024
    ).toFixed(1)} KB)`
  )

  try {
    await sendToPrinter(host, port, payload)
    console.log(`${stamp()}  ✓ printed`)
    await reportJob(job.id, true)
    return 'printed'
  } catch (error) {
    console.error(`${stamp()}  ✗ ${error.message}`)
    await reportJob(job.id, false, error.message)
    return 'failed'
  }
}

async function main() {
  if (onlyStatus) {
    const host = config.printerHost
    if (!host) {
      console.error('PRINTER_HOST 를 설정해 주세요 (예: PRINTER_HOST=192.168.1.50)')
      process.exit(1)
    }
    console.log(`Asking ${host}:${config.printerPort} for status…`)
    const status = describeStatus(await requestStatus(host, config.printerPort))
    if (status.unknown) {
      console.log('프린터가 상태를 보고하지 않았습니다 (연결은 성공). 인쇄는 가능할 수 있습니다.')
    } else {
      console.log(`  용지: ${status.mediaWidthMm} mm ${status.mediaType}`)
      console.log(status.ok ? '  상태: 정상' : `  오류: ${status.messages.join(' / ')}`)
    }
    process.exit(status.ok ? 0 : 1)
  }

  console.log(`Bethel Starlight print agent v${VERSION}`)
  console.log(`  app     ${config.appUrl}`)
  console.log(`  agent   ${config.agentId} (${config.agentName})`)
  console.log(`  printer ${config.printerHost || '(설정 화면에서 지정)'}:${config.printerPort}`)
  console.log(
    `  poll    ${config.pollMsOverride ? `${config.pollMsOverride} ms (override)` : '서버가 결정'}\n`
  )

  while (running) {
    try {
      const outcome = await tick()
      consecutiveFailures = 0
      if (once) break
      // A printed job means the queue may hold more, so poll straight away.
      // A failure usually means somebody has to walk over and load paper, so
      // pause rather than spinning through the retry budget in one second.
      if (outcome === 'failed') await sleep(config.failurePauseMs)
      else if (outcome === 'idle') await sleep(nextPollMs)
    } catch (error) {
      consecutiveFailures++
      // Back off so a wrong URL or a dead link does not spam the log or the API.
      const backoff = Math.min(30000, 1000 * 2 ** Math.min(consecutiveFailures, 5))
      console.error(`${stamp()}  poll failed: ${error.message} — ${backoff / 1000}s 후 재시도`)
      if (once) break
      await sleep(backoff)
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nstopping…')
    running = false
    setTimeout(() => process.exit(0), 200)
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
