#!/usr/bin/env node
/**
 * Generates the PWA icons with a hand-rolled PNG encoder.
 *
 * Writing ~80 lines of zlib + CRC beats adding an image library to the
 * dependency tree for three files that change roughly never.
 *
 *   npm run icons
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

const TOP = [0x84, 0x59, 0xa8]
const BOTTOM = [0xb2, 0x73, 0xd1]
const STAR = [0xff, 0xff, 0xff]
const SUPERSAMPLE = 3

/** Five-pointed star as a 10-vertex polygon, centred on (cx, cy). */
function starPolygon(cx, cy, outer, inner) {
  const points = []
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : inner
    const angle = -Math.PI / 2 + (i * Math.PI) / 5
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)])
  }
  return points
}

function insidePolygon(points, x, y) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function renderIcon(size) {
  const polygon = starPolygon(size / 2, size * 0.505, size * 0.33, size * 0.145)
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let at = 0

  for (let y = 0; y < size; y++) {
    raw[at++] = 0 // filter type: none
    for (let x = 0; x < size; x++) {
      // Diagonal gradient matching the app's purple background.
      const t = Math.min(1, Math.max(0, (x / size) * 0.45 + (y / size) * 0.55))
      const bg = [0, 1, 2].map((c) => Math.round(TOP[c] + (BOTTOM[c] - TOP[c]) * t))

      // Supersample the star edge so it does not look jagged at 192px.
      let hits = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE
          const py = y + (sy + 0.5) / SUPERSAMPLE
          if (insidePolygon(polygon, px, py)) hits++
        }
      }
      const coverage = hits / (SUPERSAMPLE * SUPERSAMPLE)

      for (let c = 0; c < 3; c++) {
        raw[at++] = Math.round(bg[c] * (1 - coverage) + STAR[c] * coverage)
      }
    }
  }

  return encodePng(size, size, raw)
}

// --- minimal PNG container -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rawRows) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawRows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  const png = renderIcon(size)
  writeFileSync(join(outDir, name), png)
  console.log(`✓ public/icons/${name} (${size}×${size}, ${png.length} bytes)`)
}
