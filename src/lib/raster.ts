/**
 * Shared (browser + server) bitmap helpers for the Brother QL raster protocol.
 *
 * The QL-800/810W/820NWB family has a 720-pin head, so every raster line is
 * exactly 90 bytes regardless of which tape is loaded. A 62 mm continuous roll
 * has 696 printable dots, centred in those 720 pins with a 12-dot dead zone on
 * each side.
 *
 * Pure TypeScript on Uint8Array only — no Buffer, no DOM — so the same code
 * runs in Safari on the iPad and in the Vercel function.
 */

export const PINS = 720
export const BYTES_PER_LINE = PINS / 8 // 90

/** Printable dots and the pin offset for each supported tape width. */
export const MEDIA: Record<number, { printableDots: number; offsetDots: number }> = {
  62: { printableDots: 696, offsetDots: 12 },
  50: { printableDots: 554, offsetDots: 83 },
  54: { printableDots: 590, offsetDots: 65 },
  38: { printableDots: 413, offsetDots: 154 },
  29: { printableDots: 306, offsetDots: 207 },
  17: { printableDots: 165, offsetDots: 278 },
  12: { printableDots: 106, offsetDots: 307 },
}

export function mediaSpec(widthMm: number) {
  return MEDIA[widthMm] ?? MEDIA[62]
}

/**
 * TIFF PackBits, which is what the QL series calls "compression mode 2".
 *
 * Control byte n:
 *   0x00..0x7F  copy the next n + 1 bytes verbatim
 *   0x81..0xFF  repeat the next byte 257 - n times (i.e. 2..128 times)
 *   0x80        no-op (never emitted)
 */
export function packBits(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0

  while (i < input.length) {
    // How long is the run starting here?
    let runEnd = i + 1
    while (runEnd < input.length && input[runEnd] === input[i] && runEnd - i < 128) runEnd++
    const runLength = runEnd - i

    if (runLength >= 2) {
      out.push(257 - runLength, input[i])
      i = runEnd
      continue
    }

    // No run: gather literals until a run of 3+ appears (a shorter run is not
    // worth breaking the literal block for).
    let litEnd = i
    while (litEnd < input.length && litEnd - i < 128) {
      const a = input[litEnd]
      if (
        litEnd + 2 < input.length &&
        input[litEnd + 1] === a &&
        input[litEnd + 2] === a
      ) {
        break
      }
      litEnd++
    }
    const litLength = litEnd - i
    out.push(litLength - 1)
    for (let k = i; k < litEnd; k++) out.push(input[k])
    i = litEnd
  }

  return new Uint8Array(out)
}

/**
 * Length-prefixed stream of PackBits-compressed raster lines:
 *   [len][len bytes][len][len bytes]...
 *
 * This is what the iPad uploads. PackBits of a 90-byte line never exceeds 92
 * bytes, so a single length byte is always enough.
 */
export function encodeCompressedLines(lines: Uint8Array[]): Uint8Array {
  let total = 0
  const compressed = lines.map((line) => {
    const c = packBits(line)
    total += c.length + 1
    return c
  })

  const out = new Uint8Array(total)
  let at = 0
  for (const c of compressed) {
    out[at++] = c.length
    out.set(c, at)
    at += c.length
  }
  return out
}

/** Inverse of {@link encodeCompressedLines} — splits without decompressing. */
export function decodeCompressedLines(stream: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = []
  let at = 0
  while (at < stream.length) {
    const len = stream[at++]
    if (len === 0 || at + len > stream.length) {
      throw new Error(`malformed raster stream at byte ${at - 1}`)
    }
    lines.push(stream.subarray(at, at + len))
    at += len
  }
  return lines
}

/** Rotate a compressed-line stream by 180°: reverse line and bit order. */
export function rotateLines180(lines: Uint8Array[]): Uint8Array[] {
  const reversedBits = (line: Uint8Array) => {
    const out = new Uint8Array(line.length)
    for (let i = 0; i < line.length; i++) out[i] = reverseByte(line[line.length - 1 - i])
    return out
  }
  return lines.slice().reverse().map(reversedBits)
}

const REVERSE_TABLE = (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    let v = 0
    for (let b = 0; b < 8; b++) if (i & (1 << b)) v |= 1 << (7 - b)
    t[i] = v
  }
  return t
})()

function reverseByte(b: number) {
  return REVERSE_TABLE[b]
}

export function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function bytesFromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'))
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
