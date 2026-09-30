/**
 * Printing from the iPad, straight to the Raspberry Pi bridge on the LAN.
 *
 * The browser does the whole job: draw the label on a canvas, pack it into
 * raster lines, wrap them in Brother's command sequence (brother.ts is plain
 * Uint8Array code and runs fine in Safari), and POST the finished bytes to
 * the bridge. The bridge only forwards them to TCP 9100, so changing a print
 * setting never means touching the Pi.
 *
 * Browser-only — call from client components.
 */

import { assembleJob } from './brother'
import { renderLabelStream, waitForFonts } from './label'
import type { LabelPayload, LabelSettings, PrinterSettings } from './types'

export interface BridgeStatus {
  /** The bridge answered at all. */
  bridgeReachable: boolean
  /** The bridge reached the printer. */
  printerReachable: boolean
  /** No printer-side error (paper, cover…). */
  ok: boolean
  messages: string[]
  mediaWidthMm?: number
  mediaType?: string
  printerHost?: string
}

export class PrintError extends Error {
  /** True when a person has to fix something at the printer. */
  constructor(
    message: string,
    readonly needsAttention: boolean
  ) {
    super(message)
  }
}

export function bridgeConfigured(printer: Pick<PrinterSettings, 'bridgeUrl'>): boolean {
  return Boolean(printer.bridgeUrl?.trim())
}

function bridgeBase(printer: Pick<PrinterSettings, 'bridgeUrl'>): string {
  return printer.bridgeUrl.trim().replace(/\/+$/, '')
}

/** Render + assemble a complete Brother job for one label. */
export async function buildLabelJob(options: {
  payload: LabelPayload
  label: LabelSettings
  printer: PrinterSettings
  timezone: string
  copies?: number
}): Promise<Uint8Array> {
  await waitForFonts()
  const { stream } = renderLabelStream({
    payload: options.payload,
    label: options.label,
    timezone: options.timezone,
    mediaWidthMm: options.printer.mediaWidthMm,
    labelLengthMm: options.printer.labelLengthMm,
    threshold: options.printer.threshold,
  })
  return assembleJob(stream, {
    mediaWidthMm: options.printer.mediaWidthMm,
    mediaType: 'continuous',
    autocut: options.printer.autocut,
    cutAtEnd: options.printer.cutAtEnd,
    feedDots: options.printer.feedDots,
    copies: options.copies ?? options.printer.copies,
    rotate180: options.printer.rotate180,
  })
}

/**
 * Send a finished job to the bridge. Resolves once the printer has taken it;
 * rejects with a PrintError whose message is fit to show a volunteer.
 */
export async function sendToBridge(
  printer: Pick<PrinterSettings, 'bridgeUrl' | 'bridgeKey'>,
  job: Uint8Array,
  label = ''
): Promise<void> {
  if (!bridgeConfigured(printer)) {
    throw new PrintError('프린트 브릿지 주소가 설정되지 않았습니다 (세팅 → 프린터)', true)
  }

  let response: Response
  try {
    response = await fetch(`${bridgeBase(printer)}/print`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Bridge-Key': printer.bridgeKey ?? '',
        // Header values must be ASCII; the label is only for the bridge log.
        'X-Label': encodeURIComponent(label).slice(0, 80),
      },
      body: job as BodyInit,
      signal: AbortSignal.timeout(25000),
    })
  } catch {
    // A fetch that never gets a response is, in practice, one of: the Pi is
    // off, the iPad is on a different network, or the iPad does not trust the
    // bridge's certificate. Safari gives the page no way to tell them apart.
    throw new PrintError(
      '프린트 브릿지에 연결할 수 없습니다 — 라즈베리파이 전원, 같은 와이파이인지, 인증서를 확인해 주세요',
      true
    )
  }

  if (response.ok) return

  const body = await response.json().catch(() => ({}) as { error?: string })
  const message = body.error ?? `브릿지 오류 (${response.status})`
  throw new PrintError(message, response.status === 409 || response.status === 401)
}

/** Ask the bridge how the printer is doing. Never throws. */
export async function fetchBridgeStatus(
  printer: Pick<PrinterSettings, 'bridgeUrl' | 'bridgeKey'>
): Promise<BridgeStatus> {
  if (!bridgeConfigured(printer)) {
    return { bridgeReachable: false, printerReachable: false, ok: false, messages: [] }
  }
  try {
    const response = await fetch(`${bridgeBase(printer)}/status`, {
      headers: { 'X-Bridge-Key': printer.bridgeKey ?? '' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    const body = await response.json()
    if (!response.ok) {
      return {
        bridgeReachable: true,
        printerReachable: false,
        ok: false,
        messages: [body.error ?? `브릿지 오류 (${response.status})`],
      }
    }
    return {
      bridgeReachable: true,
      printerReachable: Boolean(body.reachable),
      ok: Boolean(body.ok),
      messages: body.messages ?? [],
      mediaWidthMm: body.mediaWidthMm,
      mediaType: body.mediaType,
      printerHost: body.printer?.host,
    }
  } catch {
    return {
      bridgeReachable: false,
      printerReachable: false,
      ok: false,
      messages: ['프린트 브릿지에 연결할 수 없습니다'],
    }
  }
}
