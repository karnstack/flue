/**
 * Generate flue's PWA icon set and its OG card.
 *
 * Run with `pnpm icons`. The outputs are committed, so a clean checkout
 * builds without running this; regenerate only when the mark or the tokens
 * change.
 *
 * Why a hand-rolled rasteriser rather than an icon plugin: the whole mark is
 * three round-capped segments on a field, the colours have to come from
 * `src/lib/theme.ts` so they cannot drift from the stylesheet, and the
 * alternative is a build dependency carrying a native binary to draw a
 * chevron. Node 24 strips the types on the .ts import directly.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chrome } from '../src/lib/theme.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/**
 * The mark: a prompt chevron and a cursor bar, in a unit square.
 *
 * A maskable icon is cropped to a circle of 80% diameter by some launchers,
 * so `MASKABLE_SCALE` shrinks the mark about the centre until its furthest
 * point clears that radius (0.4). Un-scaled the mark reaches 0.437 (furthest
 * endpoint 0.384 plus half the stroke); scaled, 0.349.
 */
const STROKE = 0.105
const CORNER = 0.225
const MASKABLE_SCALE = 0.8
const SEGMENTS = [
  [0.2, 0.26, 0.46, 0.5],
  [0.46, 0.5, 0.2, 0.74],
  [0.545, 0.74, 0.8, 0.74],
]

const canvas = hexToRgb(chrome.canvasDark)
const accent = hexToRgb(chrome.accent)

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Distance from a point to a segment. */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const denom = bax * bax + bay * bay
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / denom))
  return Math.hypot(pax - bax * h, pay - bay * h)
}

/** Signed distance to a rounded box centred on the origin. */
function sdRoundBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r
  const qy = Math.abs(py) - hh + r
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  )
}

/**
 * @param {number} size
 * @param {'rounded'|'full'|'maskable'} mode
 */
function render(size, mode) {
  const SS = 4 // samples per axis
  const scale = mode === 'maskable' ? MASKABLE_SCALE : 1
  const halfStroke = (STROKE / 2) * scale
  const segments = SEGMENTS.map((s) => s.map((v) => (v - 0.5) * scale + 0.5))

  const rgba = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0
      let sg = 0
      let sb = 0
      let sa = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size

          const inField =
            mode === 'rounded'
              ? sdRoundBox(u - 0.5, v - 0.5, 0.5, 0.5, CORNER) <= 0
              : true
          if (!inField) continue

          let d = Infinity
          for (const [ax, ay, bx, by] of segments) {
            d = Math.min(d, sdSegment(u, v, ax, ay, bx, by))
          }
          const colour = d <= halfStroke ? accent : canvas

          sr += colour[0]
          sg += colour[1]
          sb += colour[2]
          sa += 1
        }
      }

      const i = (y * size + x) * 4
      if (sa === 0) continue
      // Straight alpha: average the covered samples' colour, and let the
      // covered fraction be the alpha.
      rgba[i] = Math.round(sr / sa)
      rgba[i + 1] = Math.round(sg / sa)
      rgba[i + 2] = Math.round(sb / sa)
      rgba[i + 3] = Math.round((sa / (SS * SS)) * 255)
    }
  }

  return encodePng(size, size, rgba)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The OG card: the mark centred on a full-bleed dark field, 1200x630 — the
 * same card site/scripts/generate-og.mjs draws for flue.sh, so a link to the
 * app and a link to the site wear one face.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} mark The mark's square, in canvas pixels.
 */
function renderCard(width, height, mark) {
  const SS = 4 // samples per axis
  const originX = (width - mark) / 2
  const originY = (height - mark) / 2

  // The mark's reach in canvas pixels, padded by the round caps' half stroke
  // plus a pixel of smoothed edge. Outside this box every pixel is plain
  // field, written without sampling.
  const xs = SEGMENTS.flatMap(([ax, , bx]) => [ax, bx])
  const ys = SEGMENTS.flatMap(([, ay, , by]) => [ay, by])
  const pad = (STROKE / 2) * mark + 1
  const minX = Math.floor(originX + Math.min(...xs) * mark - pad)
  const maxX = Math.ceil(originX + Math.max(...xs) * mark + pad)
  const minY = Math.floor(originY + Math.min(...ys) * mark - pad)
  const maxY = Math.ceil(originY + Math.max(...ys) * mark + pad)

  const rgba = Buffer.alloc(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4

      if (x < minX || x > maxX || y < minY || y > maxY) {
        rgba[i] = canvas[0]
        rgba[i + 1] = canvas[1]
        rgba[i + 2] = canvas[2]
        rgba[i + 3] = 255
        continue
      }

      let sr = 0
      let sg = 0
      let sb = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS - originX) / mark
          const v = (y + (sy + 0.5) / SS - originY) / mark

          let d = Infinity
          for (const [ax, ay, bx, by] of SEGMENTS) {
            d = Math.min(d, sdSegment(u, v, ax, ay, bx, by))
          }
          const colour = d <= STROKE / 2 ? accent : canvas

          sr += colour[0]
          sg += colour[1]
          sb += colour[2]
        }
      }

      rgba[i] = Math.round(sr / (SS * SS))
      rgba[i + 1] = Math.round(sg / (SS * SS))
      rgba[i + 2] = Math.round(sb / (SS * SS))
      rgba[i + 3] = 255
    }
  }

  return encodePng(width, height, rgba)
}

function svg() {
  const p = (n) => +(n * 100).toFixed(2)
  const [c0, c1, c2] = SEGMENTS
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" rx="${p(CORNER)}" fill="${chrome.canvasDark}"/>
  <g fill="none" stroke="${chrome.accent}" stroke-width="${p(STROKE)}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M${p(c0[0])} ${p(c0[1])} L${p(c0[2])} ${p(c0[3])} L${p(c1[2])} ${p(c1[3])}"/>
    <path d="M${p(c2[0])} ${p(c2[1])} L${p(c2[2])} ${p(c2[3])}"/>
  </g>
</svg>
`
}

const targets = [
  ['icons/icon-192.png', render(192, 'rounded')],
  ['icons/icon-512.png', render(512, 'rounded')],
  ['icons/icon-maskable-192.png', render(192, 'maskable')],
  ['icons/icon-maskable-512.png', render(512, 'maskable')],
  // iOS applies its own mask and does not honour transparency, so the
  // apple-touch icon is a full-bleed square.
  ['icons/apple-touch-icon.png', render(180, 'full')],
  ['favicon-32.png', render(32, 'rounded')],
  ['favicon.svg', Buffer.from(svg(), 'utf8')],
  ['og.png', renderCard(1200, 630, 360)],
]

mkdirSync(join(OUT, 'icons'), { recursive: true })
for (const [name, data] of targets) {
  const path = join(OUT, name)
  writeFileSync(path, data)
  console.log(`${name}  ${data.length} bytes`)
}
