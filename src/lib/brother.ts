/**
 * Builds a complete Brother QL raster command stream.
 *
 * The bytes this produces are written verbatim to the printer's raw port
 * (TCP 9100) — the LAN print agent is a dumb socket pipe and never needs to
 * know anything about the protocol.
 *
 * Reference: "Brother QL-800/QL-810W/QL-820NWB Raster Command Reference".
 */

import {
  BYTES_PER_LINE,
  decodeCompressedLines,
  encodeCompressedLines,
  mediaSpec,
  rotateLines180,
} from './raster'

export interface BrotherJobOptions {
  /** Tape width in mm as loaded in the printer (62 for the standard DK-2205 roll). */
  mediaWidthMm: number
  /** Continuous roll (DK-22xx) or pre-sized die-cut labels (DK-11xx). */
  mediaType?: 'continuous' | 'diecut'
  /** Only meaningful for die-cut media. */
  mediaLengthMm?: number
  /** Cut between labels. */
  autocut?: boolean
  /** Cut after the last label of the job. */
  cutAtEnd?: boolean
  /** Blank feed after the label, in dots. 35 is Brother's default for endless tape. */
  feedDots?: number
  /** How many identical copies to print. */
  copies?: number
  /** Flip the label end-for-end if it comes out of the printer upside down. */
  rotate180?: boolean
  /** 600 dpi in the feed direction. Doubles the raster count the printer expects. */
  highResolution?: boolean
}

const ESC = 0x1b
const NULL_PREAMBLE_BYTES = 200

/**
 * @param compressedStream length-prefixed PackBits raster lines, exactly as
 *   produced by `encodeCompressedLines` in the browser.
 */
export function assembleJob(
  compressedStream: Uint8Array,
  options: BrotherJobOptions
): Uint8Array {
  let lines = decodeCompressedLines(compressedStream)
  if (options.rotate180) lines = rotateLines180(lines)

  const copies = Math.max(1, Math.min(10, Math.trunc(options.copies ?? 1)))
  const mediaType = options.mediaType ?? 'continuous'
  const feedDots = clampUint16(options.feedDots ?? 35)
  const out = new ByteWriter()

  // ---- Reset ------------------------------------------------------------
  // 200 null bytes clear any half-finished job left in the printer's buffer,
  // which is what usually causes the "prints garbage after a crash" symptom.
  out.fill(0x00, NULL_PREAMBLE_BYTES)
  out.push(ESC, 0x40) // ESC @  — initialise
  out.push(ESC, 0x69, 0x61, 0x01) // ESC i a 1 — switch to raster mode

  for (let page = 0; page < copies; page++) {
    // ---- Print information (ESC i z) ------------------------------------
    let validFlags = 0x80 /* recover on */ | 0x02 /* media type */ | 0x04 /* media width */
    if (mediaType === 'diecut') validFlags |= 0x08 // media length
    if (options.highResolution) validFlags |= 0x40

    out.push(ESC, 0x69, 0x7a)
    out.push(validFlags)
    out.push(mediaType === 'diecut' ? 0x0b : 0x0a)
    out.push(options.mediaWidthMm & 0xff)
    out.push(mediaType === 'diecut' ? (options.mediaLengthMm ?? 0) & 0xff : 0x00)
    out.pushUint32LE(lines.length)
    out.push(page === 0 ? 0x00 : 0x01) // starting page
    out.push(0x00)

    // ---- Cutting --------------------------------------------------------
    out.push(ESC, 0x69, 0x4d, options.autocut === false ? 0x00 : 0x40) // ESC i M
    out.push(ESC, 0x69, 0x41, 0x01) // ESC i A — cut every 1 label

    let expanded = 0x00
    if (options.cutAtEnd !== false) expanded |= 0x08
    if (options.highResolution) expanded |= 0x40
    out.push(ESC, 0x69, 0x4b, expanded) // ESC i K

    // ---- Feed margin (ESC i d) ------------------------------------------
    out.push(ESC, 0x69, 0x64, feedDots & 0xff, (feedDots >> 8) & 0xff)

    // ---- Compression mode: TIFF/PackBits --------------------------------
    out.push(0x4d, 0x02) // M 2

    // ---- Raster data ----------------------------------------------------
    for (const line of lines) {
      out.push(0x67, 0x00, line.length)
      out.pushBytes(line)
    }

    // 0x0C prints the page and holds; 0x1A prints and feeds/cuts. Only the
    // final copy gets 0x1A so intermediate copies are not over-fed.
    out.push(page === copies - 1 ? 0x1a : 0x0c)
  }

  return out.toUint8Array()
}

/**
 * A tiny, always-valid label used by "Test print" on the Settings screen:
 * a solid frame plus alternating bars, drawn without any font so it works even
 * if the browser never got involved.
 */
export function buildSelfTestStream(mediaWidthMm = 62, lengthDots = 400): Uint8Array {
  const { printableDots, offsetDots } = mediaSpec(mediaWidthMm)
  const lines: Uint8Array[] = []

  for (let y = 0; y < lengthDots; y++) {
    const line = new Uint8Array(BYTES_PER_LINE)
    const setDot = (x: number) => {
      const pin = offsetDots + x
      line[pin >> 3] |= 0x80 >> (pin & 7)
    }
    const isEdge = y < 8 || y >= lengthDots - 8
    for (let x = 0; x < printableDots; x++) {
      if (isEdge || x < 8 || x >= printableDots - 8) setDot(x)
      else if (y % 40 < 12 && x > 40 && x < printableDots - 40) setDot(x)
    }
    lines.push(line)
  }

  return assembleJob(encodeCompressedLines(lines), { mediaWidthMm })
}

function clampUint16(n: number) {
  return Math.max(0, Math.min(0xffff, Math.trunc(n)))
}

class ByteWriter {
  private chunks: number[] = []

  push(...bytes: number[]) {
    for (const b of bytes) this.chunks.push(b & 0xff)
  }

  pushBytes(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i++) this.chunks.push(bytes[i])
  }

  pushUint32LE(value: number) {
    this.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
  }

  fill(byte: number, count: number) {
    for (let i = 0; i < count; i++) this.chunks.push(byte & 0xff)
  }

  toUint8Array() {
    return new Uint8Array(this.chunks)
  }
}
