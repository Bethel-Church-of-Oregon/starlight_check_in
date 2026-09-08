/**
 * Label bit-packing checks.
 *
 * `renderLabelStream` draws into a canvas that is `tapeDots` wide and rotates
 * the artwork 90° into it, so canvas row y maps 1:1 onto raster line y and no
 * transposing happens anywhere. That mapping — plus the 12-dot pin offset and
 * MSB-first bit order — is the easiest thing in the project to get subtly
 * wrong, and a wrong version prints a mirrored or shifted label.
 *
 * Text rendering is not exercised (no font engine in Node); the canvas is
 * stubbed so getImageData returns pixels we chose.
 */
const assert = require('node:assert')

let pass = 0
const t = (name, fn) => { fn(); console.log(`  ok  ${name}`); pass++ }

// --- canvas stub -----------------------------------------------------------
/** @param paint (x, y) => [r,g,b,a] */
function installCanvasStub(paint) {
  const created = []

  const makeContext = (canvas) => ({
    canvas,
    fillStyle: '', strokeStyle: '', font: '', textBaseline: '', textAlign: '', lineWidth: 0,
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    fillRect() {}, fillText() {}, stroke() {},
    beginPath() {}, moveTo() {}, arcTo() {}, closePath() {},
    measureText: (text) => ({ width: text.length * 10 }),
    getImageData(_x, _y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const [r, g, b, a] = paint(x, y)
          const i = (y * w + x) * 4
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a
        }
      }
      return { data, width: w, height: h }
    },
    toDataURL: () => 'data:image/png;base64,stub',
  })

  global.document = {
    createElement(tag) {
      assert.strictEqual(tag, 'canvas')
      const canvas = { width: 0, height: 0, toDataURL: () => 'data:image/png;base64,stub' }
      canvas.getContext = () => makeContext(canvas)
      created.push(canvas)
      return canvas
    },
  }
  return created
}

const PAYLOAD = {
  koreanName: '김민준',
  englishName: 'Minjun Kim',
  grade: '3rd',
  securityCode: 'H7KM',
  serviceName: '1부 예배',
  checkedInAt: '2026-09-08T16:32:00.000Z',
}

const LABEL = {
  showKorean: true, showEnglish: true, showGrade: true,
  showCode: true, showDateTime: true, showService: true, nameScale: 1,
}

const WHITE = () => [255, 255, 255, 255]
const BLACK = [0, 0, 0, 255]

function setPins(line) {
  const pins = []
  for (let pin = 0; pin < 720; pin++) {
    if (line[pin >> 3] & (0x80 >> (pin & 7))) pins.push(pin)
  }
  return pins
}

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

// --- tests -----------------------------------------------------------------
function load() {
  // Re-require after the stub is installed; the module reads `document` lazily
  // inside the function, but keep this explicit for clarity.
  delete require.cache[require.resolve('../.tmp-test/label.js')]
  return require('../.tmp-test/label.js')
}
const R = require('../.tmp-test/raster.js')

t('mmToDots converts at 300 dpi', () => {
  installCanvasStub(WHITE)
  const { mmToDots } = load()
  assert.strictEqual(mmToDots(25.4), 300)
  assert.strictEqual(mmToDots(90), 1063)
  assert.strictEqual(mmToDots(62), 732)
})

t('canvas is tape-width wide and label-length tall', () => {
  const created = installCanvasStub(WHITE)
  const { renderLabelStream } = load()
  const { rasterCount } = renderLabelStream({
    payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
    mediaWidthMm: 62, labelLengthMm: 90,
  })
  assert.strictEqual(created[0].width, 696, '696 printable dots across a 62mm roll')
  assert.strictEqual(created[0].height, 1063, '90mm of feed at 300 dpi')
  assert.strictEqual(rasterCount, 1063, 'one raster line per canvas row')
})

t('a blank canvas produces blank raster lines', () => {
  installCanvasStub(WHITE)
  const { renderLabelStream } = load()
  const { stream } = renderLabelStream({
    payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
    mediaWidthMm: 62, labelLengthMm: 30,
  })
  const lines = R.decodeCompressedLines(stream)
  for (const compressed of lines) {
    assert.deepStrictEqual(setPins(unpackBits(compressed, 90)), [], 'no dots set')
  }
})

t('canvas pixel (0,0) lands on pin 12 of raster line 0', () => {
  installCanvasStub((x, y) => (x === 0 && y === 0 ? BLACK : WHITE()))
  const { renderLabelStream } = load()
  const { stream } = renderLabelStream({
    payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
    mediaWidthMm: 62, labelLengthMm: 30,
  })
  const lines = R.decodeCompressedLines(stream).map((c) => unpackBits(c, 90))
  assert.deepStrictEqual(setPins(lines[0]), [12], 'left dead zone is 12 pins wide')
  assert.deepStrictEqual(setPins(lines[1]), [], 'only the first line is marked')
})

t('the far corner lands on the last printable pin of the last line', () => {
  const lengthDots = Math.round((30 / 25.4) * 300) // 354
  installCanvasStub((x, y) => (x === 695 && y === lengthDots - 1 ? BLACK : WHITE()))
  const { renderLabelStream } = load()
  const { stream } = renderLabelStream({
    payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
    mediaWidthMm: 62, labelLengthMm: 30,
  })
  const lines = R.decodeCompressedLines(stream).map((c) => unpackBits(c, 90))
  assert.strictEqual(lines.length, lengthDots)
  assert.deepStrictEqual(setPins(lines[lengthDots - 1]), [12 + 695])
  assert.strictEqual(12 + 695, 707, 'right dead zone is also 12 pins')
})

t('every canvas row maps to its own raster line, in order', () => {
  // A diagonal: pixel (y, y) black. Line y must have exactly pin 12+y set.
  installCanvasStub((x, y) => (x === y ? BLACK : WHITE()))
  const { renderLabelStream } = load()
  const { stream } = renderLabelStream({
    payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
    mediaWidthMm: 62, labelLengthMm: 20,
  })
  const lines = R.decodeCompressedLines(stream).map((c) => unpackBits(c, 90))
  lines.forEach((line, y) => {
    assert.deepStrictEqual(setPins(line), [12 + y], `raster line ${y}`)
  })
})

t('threshold decides what counts as black', () => {
  const grey = (v) => [v, v, v, 255]
  for (const [value, threshold, expectBlack] of [
    [100, 160, true],
    [200, 160, false],
    [200, 240, true],
    [159, 160, true],
    [160, 160, false],
  ]) {
    installCanvasStub((x, y) => (x === 0 && y === 0 ? grey(value) : WHITE()))
    const { renderLabelStream } = load()
    const { stream } = renderLabelStream({
      payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
      mediaWidthMm: 62, labelLengthMm: 20, threshold,
    })
    const first = unpackBits(R.decodeCompressedLines(stream)[0], 90)
    assert.strictEqual(
      setPins(first).length === 1,
      expectBlack,
      `grey ${value} at threshold ${threshold}`
    )
  }
})

t('transparent pixels read as paper, not as ink', () => {
  // A zero-alpha black pixel is unpainted canvas; it must not print.
  installCanvasStub((x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : WHITE()))
  const { renderLabelStream } = load()
  const { stream } = renderLabelStream({
    payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
    mediaWidthMm: 62, labelLengthMm: 20,
  })
  assert.deepStrictEqual(setPins(unpackBits(R.decodeCompressedLines(stream)[0], 90)), [])
})

t('narrower tape shifts the artwork to its own pin window', () => {
  installCanvasStub((x, y) => (x === 0 && y === 0 ? BLACK : WHITE()))
  const { renderLabelStream } = load()
  const { stream } = renderLabelStream({
    payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
    mediaWidthMm: 29, labelLengthMm: 20,
  })
  const first = unpackBits(R.decodeCompressedLines(stream)[0], 90)
  assert.deepStrictEqual(setPins(first), [207], '29mm tape starts at pin 207')
})

t('renderLabelPreview returns a data URL in readable orientation', () => {
  const created = installCanvasStub(WHITE)
  const { renderLabelPreview } = load()
  const url = renderLabelPreview({
    payload: PAYLOAD, label: LABEL, timezone: 'America/Los_Angeles',
    mediaWidthMm: 62, labelLengthMm: 90, cssWidth: 760,
  })
  assert.ok(url.startsWith('data:image/png'), 'produces an image')
  // Readable orientation: wider than tall, unlike the print canvas.
  assert.ok(created[0].width > created[0].height, 'preview is landscape')
})

console.log(`\n${pass} checks passed`)
