/**
 * Generate the flue.sh OG card: the flue mark centred on a full-bleed
 * dark field, 1200x630.
 *
 * Run with `node site/scripts/generate-og.mjs`. The output is committed at
 * site/public/og.png, so a clean checkout serves without running this;
 * regenerate only when the mark or the colours change.
 *
 * Adapted from web/scripts/generate-icons.mjs: the same sdSegment sampling
 * loop and hand-rolled PNG encoder, node:zlib only, zero dependencies.
 * site/ must not import from web/, so the code is copied, not imported.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const WIDTH = 1200
const HEIGHT = 630
/** The mark's square, centred in the canvas. */
const MARK = 360

// These mirror web/src/lib/theme.ts (`chrome.canvasDark`, `chrome.accent`);
// the site/ -> web/ boundary forbids importing them, so they are hardcoded.
const CANVAS_DARK = '#09090b'
const ACCENT = '#00bba7'

/**
 * The mark in the favicon's 0-100 viewBox: a prompt chevron
 * (M20 26 L46 50 L20 74) and a cursor bar (M54.5 74 L80 74),
 * stroke-width 10.5, round caps.
 */
const STROKE = 10.5
const SEGMENTS = [
  [20, 26, 46, 50],
  [46, 50, 20, 74],
  [54.5, 74, 80, 74],
]

const field = hexToRgb(CANVAS_DARK)
const accent = hexToRgb(ACCENT)

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

function render() {
  const SS = 4 // samples per axis
  const halfStroke = STROKE / 2
  const originX = (WIDTH - MARK) / 2
  const originY = (HEIGHT - MARK) / 2
  const pxToViewBox = 100 / MARK

  // The mark's reach in canvas pixels (endpoints padded by the round caps'
  // half stroke, plus a pixel for the antialiased edge). Outside this box
  // every pixel is plain field, written without sampling.
  const xs = SEGMENTS.flatMap(([ax, , bx]) => [ax, bx])
  const ys = SEGMENTS.flatMap(([, ay, , by]) => [ay, by])
  const pad = halfStroke + pxToViewBox
  const minX = Math.floor(originX + ((Math.min(...xs) - pad) / 100) * MARK)
  const maxX = Math.ceil(originX + ((Math.max(...xs) + pad) / 100) * MARK)
  const minY = Math.floor(originY + ((Math.min(...ys) - pad) / 100) * MARK)
  const maxY = Math.ceil(originY + ((Math.max(...ys) + pad) / 100) * MARK)

  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4)

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4

      if (x < minX || x > maxX || y < minY || y > maxY) {
        rgba[i] = field[0]
        rgba[i + 1] = field[1]
        rgba[i + 2] = field[2]
        rgba[i + 3] = 255
        continue
      }

      let sr = 0
      let sg = 0
      let sb = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS - originX) * pxToViewBox
          const v = (y + (sy + 0.5) / SS - originY) * pxToViewBox

          let d = Infinity
          for (const [ax, ay, bx, by] of SEGMENTS) {
            d = Math.min(d, sdSegment(u, v, ax, ay, bx, by))
          }
          const colour = d <= halfStroke ? accent : field

          sr += colour[0]
          sg += colour[1]
          sb += colour[2]
        }
      }

      const n = SS * SS
      rgba[i] = Math.round(sr / n)
      rgba[i + 1] = Math.round(sg / n)
      rgba[i + 2] = Math.round(sb / n)
      rgba[i + 3] = 255
    }
  }

  return encodePng(WIDTH, HEIGHT, rgba)
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

const png = render()
const path = join(OUT, 'og.png')
writeFileSync(path, png)
console.log(`og.png  ${WIDTH}x${HEIGHT}  ${png.length} bytes`)
