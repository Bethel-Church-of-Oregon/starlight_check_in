/**
 * Client-side label rendering.
 *
 * The label is drawn on a canvas in the browser rather than on the server for
 * one specific reason: Hangul. Safari on the iPad has Apple SD Gothic Neo and
 * renders Korean names beautifully with no font files to ship, whereas the
 * printer's resident fonts are Latin-only and server-side rasterising would
 * mean bundling a CJK font and a text shaper into a serverless function.
 *
 * Everything here is browser-only — call it from a client component.
 */

import { encodeCompressedLines, mediaSpec } from './raster'
import type { LabelPayload, LabelSettings } from './types'

const DPI = 300
const MM_PER_INCH = 25.4

export function mmToDots(mm: number): number {
  return Math.round((mm / MM_PER_INCH) * DPI)
}

const FONT_STACK =
  '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", "Nanum Gothic", -apple-system, "Segoe UI", Roboto, sans-serif'

/**
 * Draws the label in *readable* orientation: `w` runs along the reading
 * direction, `h` across the tape. Used both for printing (via a rotated
 * transform) and for the on-screen preview on the Settings screen.
 */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  payload: LabelPayload,
  settings: LabelSettings,
  timezone: string
): void {
  const margin = Math.round(h * 0.06)
  const scale = clamp(settings.nameScale || 1, 0.6, 1.6)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  const korean = settings.showKorean ? clean(payload.koreanName) : null
  const english = settings.showEnglish ? clean(payload.englishName) : null
  const primary = korean ?? english
  const secondary = korean ? english : null

  // ---- pickup code box, right-hand side ----------------------------------
  let contentRight = w - margin
  if (settings.showCode && payload.securityCode) {
    const boxW = Math.round(w * 0.235)
    const boxH = Math.round(h * 0.42)
    const boxX = w - margin - boxW
    const boxY = margin

    ctx.lineWidth = Math.max(4, Math.round(h * 0.012))
    ctx.strokeStyle = '#000000'
    roundRect(ctx, boxX, boxY, boxW, boxH, Math.round(h * 0.03))
    ctx.stroke()

    const captionSize = Math.round(h * 0.055)
    ctx.font = `600 ${captionSize}px ${FONT_STACK}`
    ctx.textAlign = 'center'
    ctx.fillText('PICKUP', boxX + boxW / 2, boxY + captionSize * 1.55)

    const codeSize = fitFontSize(
      ctx,
      payload.securityCode,
      Math.round(boxW * 0.84),
      Math.round(h * 0.24),
      700
    )
    ctx.font = `700 ${codeSize}px ${FONT_STACK}`
    ctx.fillText(payload.securityCode, boxX + boxW / 2, boxY + boxH * 0.82)
    ctx.textAlign = 'left'

    contentRight = boxX - Math.round(w * 0.03)
  }

  const contentWidth = contentRight - margin

  // ---- footer line: grade · service · time -------------------------------
  const footerParts: string[] = []
  if (settings.showGrade && payload.grade) footerParts.push(payload.grade)
  if (settings.showService && payload.serviceName) footerParts.push(payload.serviceName)

  const metaParts: string[] = []
  if (settings.showDateTime) metaParts.push(formatStamp(payload.checkedInAt, timezone))

  let cursorBottom = h - margin

  if (metaParts.length) {
    const size = Math.round(h * 0.075)
    ctx.font = `500 ${size}px ${FONT_STACK}`
    ctx.fillText(metaParts.join('  ·  '), margin, cursorBottom)
    cursorBottom -= Math.round(size * 1.5)
  }

  if (footerParts.length) {
    const size = Math.round(h * 0.115)
    ctx.font = `600 ${size}px ${FONT_STACK}`
    ctx.fillText(footerParts.join('  ·  '), margin, cursorBottom)
    cursorBottom -= Math.round(size * 1.35)
  }

  // ---- names, filling the space that is left -----------------------------
  const nameSpace = cursorBottom - margin

  if (primary && secondary) {
    const primarySize = fitFontSize(
      ctx,
      primary,
      contentWidth,
      Math.min(Math.round(h * 0.30 * scale), Math.round(nameSpace * 0.62)),
      700
    )
    const secondarySize = fitFontSize(
      ctx,
      secondary,
      contentWidth,
      Math.min(Math.round(h * 0.155 * scale), Math.round(nameSpace * 0.34)),
      600
    )
    ctx.font = `700 ${primarySize}px ${FONT_STACK}`
    ctx.fillText(primary, margin, margin + primarySize * 0.86)
    ctx.font = `600 ${secondarySize}px ${FONT_STACK}`
    ctx.fillText(secondary, margin, margin + primarySize * 0.86 + secondarySize * 1.25)
  } else if (primary) {
    const size = fitFontSize(
      ctx,
      primary,
      contentWidth,
      Math.min(Math.round(h * 0.34 * scale), Math.round(nameSpace * 0.8)),
      700
    )
    ctx.font = `700 ${size}px ${FONT_STACK}`
    ctx.fillText(primary, margin, margin + size * 0.9)
  }
}

/**
 * Renders the label and packs it into the length-prefixed PackBits raster
 * stream that `assembleJob` (brother.ts) wraps into a Brother print job.
 *
 * The canvas is `tapeDots` wide and `lengthDots` tall, and the drawing is
 * rotated 90° into it, so every canvas row is already exactly one raster line
 * for the print head. No transposing anywhere.
 */
export function renderLabelStream(options: {
  payload: LabelPayload
  label: LabelSettings
  timezone: string
  mediaWidthMm: number
  labelLengthMm: number
  threshold?: number
}): { stream: Uint8Array; rasterCount: number } {
  const { printableDots, offsetDots } = mediaSpec(options.mediaWidthMm)
  const lengthDots = Math.max(100, mmToDots(options.labelLengthMm))
  const threshold = options.threshold ?? 160

  const canvas = document.createElement('canvas')
  canvas.width = printableDots
  canvas.height = lengthDots

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // (u, v) in readable coordinates lands at (tapeDots - v, u) on the canvas:
  // a true 90° rotation, so nothing comes out mirrored.
  ctx.save()
  ctx.translate(printableDots, 0)
  ctx.rotate(Math.PI / 2)
  drawLabel(ctx, lengthDots, printableDots, options.payload, options.label, options.timezone)
  ctx.restore()

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const bytesPerLine = 90
  const lines: Uint8Array[] = []

  for (let y = 0; y < canvas.height; y++) {
    const line = new Uint8Array(bytesPerLine)
    const rowStart = y * canvas.width * 4
    for (let x = 0; x < canvas.width; x++) {
      const i = rowStart + x * 4
      const alpha = data[i + 3]
      // Composite against white so unpainted (transparent) pixels read as paper.
      const luminance =
        alpha === 0
          ? 255
          : ((data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) * alpha +
              255 * (255 - alpha)) /
            255
      if (luminance < threshold) {
        const pin = offsetDots + x
        line[pin >> 3] |= 0x80 >> (pin & 7)
      }
    }
    lines.push(line)
  }

  return { stream: encodeCompressedLines(lines), rasterCount: lines.length }
}

/** Data URL of the label in readable orientation, for on-screen previews. */
export function renderLabelPreview(options: {
  payload: LabelPayload
  label: LabelSettings
  timezone: string
  mediaWidthMm: number
  labelLengthMm: number
  cssWidth?: number
}): string {
  const { printableDots } = mediaSpec(options.mediaWidthMm)
  const lengthDots = Math.max(100, mmToDots(options.labelLengthMm))
  const targetWidth = options.cssWidth ?? 720
  const scale = targetWidth / lengthDots

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(lengthDots * scale)
  canvas.height = Math.round(printableDots * scale)

  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.scale(scale, scale)
  drawLabel(ctx, lengthDots, printableDots, options.payload, options.label, options.timezone)
  return canvas.toDataURL('image/png')
}

/** Wait for the Korean font to be ready so the first label of the day is not blank. */
export async function waitForFonts(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && 'fonts' in document) {
      await (document as Document & { fonts: FontFaceSet }).fonts.ready
    }
  } catch {
    /* not fatal */
  }
}

// --- helpers ---------------------------------------------------------------

function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  weight: number
): number {
  let size = startSize
  const min = Math.max(16, Math.round(startSize * 0.35))
  while (size > min) {
    ctx.font = `${weight} ${size}px ${FONT_STACK}`
    if (ctx.measureText(text).width <= maxWidth) break
    size -= Math.max(2, Math.round(size * 0.04))
  }
  return size
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

function formatStamp(iso: string, timezone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
