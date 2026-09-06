// 程序化生成 Noobty 品牌图标 PNG(512×512):青底圆角方块 + 白色"设备-中枢-设备"字形
// 用法:node gen-icon.mjs  输出 ../src-tauri/icons/icon.png(供 `tauri icon` 派生全尺寸)
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const S = 512
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/icons/icon.png')

const TEAL = [16, 114, 138]
const WHITE = [255, 255, 255]

// 有符号距离:圆角矩形(负值在内部)
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const dx = Math.abs(px - cx) - (hw - r)
  const dy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r
}
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r

// 4x 超采样抗锯齿
const cov = (x, y, test) => {
  let hit = 0
  for (const [ox, oy] of [
    [0.125, 0.125],
    [0.625, 0.125],
    [0.125, 0.625],
    [0.625, 0.625],
  ]) {
    if (test(x + ox, y + oy) < 0) hit++
  }
  return hit / 4
}

const rows = []
for (let y = 0; y < S; y++) {
  const row = Buffer.alloc(1 + S * 4)
  row[0] = 0 // filter none
  for (let x = 0; x < S; x++) {
    const bgA = cov(x, y, (px, py) => sdRoundRect(px, py, 256, 256, 256, 256, 112))
    const fgA = cov(x, y, (px, py) => {
      const shapes = [
        sdCircle(px, py, 118, 256, 34),
        sdCircle(px, py, 394, 256, 34),
        sdRoundRect(px, py, 256, 256, 44, 40, 24),
        sdRoundRect(px, py, 176, 256, 22, 9, 9),
        sdRoundRect(px, py, 336, 256, 22, 9, 9),
      ]
      return Math.min(...shapes)
    })
    // 先铺青底,再叠白色字形
    const aBg = bgA
    const aFg = Math.min(fgA, 1)
    let r = TEAL[0]
    let g = TEAL[1]
    let b = TEAL[2]
    let a = aBg
    r = r * (1 - aFg) + WHITE[0] * aFg
    g = g * (1 - aFg) + WHITE[1] * aFg
    b = b * (1 - aFg) + WHITE[2] * aFg
    const i = 1 + x * 4
    row[i] = Math.round(r)
    row[i + 1] = Math.round(g)
    row[i + 2] = Math.round(b)
    row[i + 3] = Math.round(a * 255)
  }
  rows.push(row)
}

const raw = Buffer.concat(rows)
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([len, body, crcBuf])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log('icon written:', out, `${png.length} bytes`)
