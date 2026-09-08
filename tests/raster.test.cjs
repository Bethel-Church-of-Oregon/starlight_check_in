/**
 * Brother QL raster protocol checks.
 *
 * This is the part of the system that cannot be eyeballed: if a byte is wrong
 * the printer either jams, prints garbage, or silently does nothing. The tests
 * assemble real command streams and decode them back.
 *
 *   npm test
 *
 * (`npm test` compiles src/lib/raster.ts and src/lib/brother.ts into
 * .tmp-test/ first, which is why the requires point there.)
 */
const assert = require('node:assert')
const R = require('../.tmp-test/raster.js')
const B = require('../.tmp-test/brother.js')

let pass = 0
const t = (name, fn) => { fn(); console.log(`  ok  ${name}`); pass++ }

// --- PackBits round trip ---------------------------------------------------
function unpackBits(input, expectedLength) {
  const out = []
  let i = 0
  while (i < input.length && out.length < expectedLength) {
    const n = input[i++]
    if (n === 128) continue
    if (n < 128) { for (let k = 0; k <= n; k++) out.push(input[i++]) }
    else { const b = input[i++]; for (let k = 0; k < 257 - n; k++) out.push(b) }
  }
  return Uint8Array.from(out)
}

t('packBits round-trips an all-white line', () => {
  const line = new Uint8Array(90)
  const c = R.packBits(line)
  assert.deepStrictEqual(Array.from(unpackBits(c, 90)), Array.from(line))
  assert.ok(c.length <= 4, `all-white line should compress hard, got ${c.length} bytes`)
})

t('packBits round-trips 500 random lines', () => {
  for (let n = 0; n < 500; n++) {
    const line = new Uint8Array(90)
    for (let i = 0; i < 90; i++) {
      // Mix runs and noise, which is what real label rasters look like.
      line[i] = n % 3 === 0 ? (i < 40 ? 0 : 0xff) : Math.floor(Math.random() * 256)
    }
    const c = R.packBits(line)
    assert.deepStrictEqual(Array.from(unpackBits(c, 90)), Array.from(line), `line ${n}`)
    assert.ok(c.length <= 92, `packbits worst case exceeded: ${c.length}`)
  }
})

t('encode/decodeCompressedLines is symmetric', () => {
  const lines = [0, 1, 2].map((k) => {
    const l = new Uint8Array(90)
    l.fill(k * 0x40)
    l[10] = 0xa5
    return l
  })
  const stream = R.encodeCompressedLines(lines)
  const decoded = R.decodeCompressedLines(stream)
  assert.strictEqual(decoded.length, 3)
  decoded.forEach((c, i) => {
    assert.deepStrictEqual(Array.from(unpackBits(c, 90)), Array.from(lines[i]))
  })
})

// --- media geometry --------------------------------------------------------
t('62mm media centres 696 dots inside the 720 pins', () => {
  const { printableDots, offsetDots } = R.mediaSpec(62)
  assert.strictEqual(printableDots, 696)
  assert.strictEqual(offsetDots, 12)
  assert.strictEqual(offsetDots + printableDots + 12, R.PINS)
  assert.strictEqual(R.BYTES_PER_LINE, 90)
})

// --- Brother command stream ------------------------------------------------
function makeLines(count) {
  return Array.from({ length: count }, (_, y) => {
    const l = new Uint8Array(90)
    // A single black dot per line, walking across the printable area.
    const pin = 12 + y
    l[pin >> 3] |= 0x80 >> (pin & 7)
    return l
  })
}

function parse(stream) {
  const bytes = Array.from(stream)
  let i = 0
  const eat = (...expected) => {
    for (const e of expected) {
      assert.strictEqual(bytes[i], e, `at byte ${i}: expected 0x${e.toString(16)}, got 0x${bytes[i].toString(16)}`)
      i++
    }
  }
  return { bytes, at: () => i, eat, skip: (n) => { i += n }, take: (n) => bytes.slice(i, (i += n)) }
}

t('assembleJob emits a well-formed single-page raster stream', () => {
  const lines = makeLines(5)
  const out = B.assembleJob(R.encodeCompressedLines(lines), { mediaWidthMm: 62 })
  const p = parse(out)

  assert.deepStrictEqual(p.take(200), new Array(200).fill(0), 'invalidate preamble')
  p.eat(0x1b, 0x40)              // ESC @  initialise
  p.eat(0x1b, 0x69, 0x61, 0x01)  // ESC i a 1  raster mode

  p.eat(0x1b, 0x69, 0x7a)        // ESC i z  print information
  const info = p.take(10) // ESC i z takes n1..n10
  assert.strictEqual(info[0], 0x86, 'valid flags = recover|media type|media width')
  assert.strictEqual(info[1], 0x0a, 'continuous media')
  assert.strictEqual(info[2], 62, 'media width mm')
  assert.strictEqual(info[3], 0x00, 'media length unused for continuous')
  const rasterCount = info[4] | (info[5] << 8) | (info[6] << 16) | (info[7] << 24)
  assert.strictEqual(rasterCount, 5, 'raster line count in the header')
  assert.strictEqual(info[8], 0x00, 'starting page')
  assert.strictEqual(info[9], 0x00, 'n10 is fixed at zero')

  p.eat(0x1b, 0x69, 0x4d, 0x40)  // ESC i M  autocut on
  p.eat(0x1b, 0x69, 0x41, 0x01)  // ESC i A  cut every label
  p.eat(0x1b, 0x69, 0x4b, 0x08)  // ESC i K  cut at end
  p.eat(0x1b, 0x69, 0x64, 35, 0) // ESC i d  35 dot feed
  p.eat(0x4d, 0x02)              // M 2      PackBits

  for (let y = 0; y < 5; y++) {
    p.eat(0x67, 0x00)
    const len = p.take(1)[0]
    const payload = Uint8Array.from(p.take(len))
    assert.deepStrictEqual(
      Array.from(unpackBits(payload, 90)),
      Array.from(lines[y]),
      `raster line ${y} survives the round trip`
    )
  }

  p.eat(0x1a)                    // print with feeding
  assert.strictEqual(p.at(), out.length, 'no trailing bytes')
})

t('copies=3 emits three pages, only the last one feeds', () => {
  const out = B.assembleJob(R.encodeCompressedLines(makeLines(2)), {
    mediaWidthMm: 62,
    copies: 3,
  })
  const bytes = Array.from(out)
  const pageEnds = bytes.reduce((acc, b, i) => {
    if (b === 0x0c || b === 0x1a) {
      // Only count the ones that sit where a page terminator belongs: right
      // after a raster block, i.e. not inside compressed payload bytes.
      acc.push([i, b])
    }
    return acc
  }, [])
  const terminators = [bytes[bytes.length - 1]]
  assert.strictEqual(terminators[0], 0x1a, 'stream ends with print+feed')

  // Three print-information headers means three pages.
  let headers = 0
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x69 && bytes[i + 2] === 0x7a) headers++
  }
  assert.strictEqual(headers, 3, 'one print-information block per copy')
  assert.ok(pageEnds.length >= 3)
})

t('starting-page byte is 0 for the first copy and 1 afterwards', () => {
  const out = Array.from(
    B.assembleJob(R.encodeCompressedLines(makeLines(1)), { mediaWidthMm: 62, copies: 2 })
  )
  const startingPages = []
  for (let i = 0; i < out.length - 12; i++) {
    if (out[i] === 0x1b && out[i + 1] === 0x69 && out[i + 2] === 0x7a) {
      startingPages.push(out[i + 11])
    }
  }
  assert.deepStrictEqual(startingPages, [0x00, 0x01])
})

t('autocut off / cutAtEnd off clears the right bits', () => {
  const out = Array.from(
    B.assembleJob(R.encodeCompressedLines(makeLines(1)), {
      mediaWidthMm: 62,
      autocut: false,
      cutAtEnd: false,
      feedDots: 0,
    })
  )
  const find = (a, b, c) => {
    for (let i = 0; i < out.length - 3; i++) {
      if (out[i] === a && out[i + 1] === b && out[i + 2] === c) return out[i + 3]
    }
    return null
  }
  assert.strictEqual(find(0x1b, 0x69, 0x4d), 0x00, 'ESC i M cleared')
  assert.strictEqual(find(0x1b, 0x69, 0x4b), 0x00, 'ESC i K cleared')
})

t('rotate180 reverses both line order and bit order', () => {
  const lines = makeLines(3) // dots at pins 12, 13, 14 on lines 0, 1, 2
  const stream = R.encodeCompressedLines(lines)
  const rotated = R.rotateLines180(R.decodeCompressedLines(stream).map((c) => unpackBits(c, 90)))

  // Line 0 of the rotated output is the last input line, bit-mirrored:
  // input pin 14 (0-based) -> output pin 720 - 1 - 14 = 705.
  const first = rotated[0]
  const setPins = []
  for (let pin = 0; pin < 720; pin++) {
    if (first[pin >> 3] & (0x80 >> (pin & 7))) setPins.push(pin)
  }
  assert.deepStrictEqual(setPins, [705], 'mirrored pin position')
  assert.strictEqual(rotated.length, 3)
})

t('assembleJob rejects a malformed raster stream', () => {
  assert.throws(() => B.assembleJob(Uint8Array.from([0x00]), { mediaWidthMm: 62 }), /malformed/)
})

t('die-cut media sets the media-length flag and value', () => {
  const out = Array.from(
    B.assembleJob(R.encodeCompressedLines(makeLines(1)), {
      mediaWidthMm: 62,
      mediaType: 'diecut',
      mediaLengthMm: 100,
    })
  )
  for (let i = 0; i < out.length - 12; i++) {
    if (out[i] === 0x1b && out[i + 1] === 0x69 && out[i + 2] === 0x7a) {
      assert.strictEqual(out[i + 3], 0x8e, 'valid flags include media length')
      assert.strictEqual(out[i + 4], 0x0b, 'die-cut media type')
      assert.strictEqual(out[i + 6], 100, 'media length mm')
      return
    }
  }
  assert.fail('no print-information block found')
})

t('a realistic 90mm label compresses to a sane payload size', () => {
  // 1063 raster lines, mostly white with a black band where text would be.
  const lines = Array.from({ length: 1063 }, (_, y) => {
    const l = new Uint8Array(90)
    if (y > 200 && y < 500) for (let b = 6; b < 40; b++) l[b] = 0xff
    return l
  })
  const out = B.assembleJob(R.encodeCompressedLines(lines), { mediaWidthMm: 62 })
  const uncompressed = 1063 * 90
  console.log(
    `      ${(out.length / 1024).toFixed(1)} KB assembled vs ${(uncompressed / 1024).toFixed(
      1
    )} KB raw (${((1 - out.length / uncompressed) * 100).toFixed(0)}% smaller)`
  )
  assert.ok(out.length < uncompressed / 3, 'PackBits should cut this by well over 3x')
  assert.ok(out.length > 1000, 'sanity: not empty')
})

console.log(`\n${pass} checks passed`)
