/**
 * Generate the Windows app icon from the DeepSeek logo the user supplied at the
 * project root (`deepseek-color.png`), so the desktop app + installer carry the
 * exact colour whale mark. Run with Electron:
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/make-icon.mjs
 *
 * Loads the source PNG via nativeImage, resizes, and writes both:
 *   - resources/icon.png  (512x512, for dev/taskbar and as a high-res source)
 *   - resources/icon.ico  (multi-size PNG-compressed ICO, for electron-builder)
 */

import { app, nativeImage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const SOURCE = join(root, 'deepseek-color.png')
const SIZE = 512
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** ICO container: 6-byte header + 16-byte directory entry per image + PNG payloads. */
function packIco(pngs, sizes) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  pngs.forEach((png, i) => {
    const size = png.length
    const dim = sizes[i]
    dir.writeUInt8(dim >= 256 ? 0 : dim, 16 * i) // width (0 => 256)
    dir.writeUInt8(dim >= 256 ? 0 : dim, 16 * i + 1) // height
    dir.writeUInt8(0, 16 * i + 2) // palette
    dir.writeUInt8(0, 16 * i + 3) // reserved
    dir.writeUInt16LE(1, 16 * i + 4) // color planes
    dir.writeUInt16LE(32, 16 * i + 6) // bpp
    dir.writeUInt32LE(size, 16 * i + 8) // bytes in resource
    dir.writeUInt32LE(offset, 16 * i + 12) // offset
    offset += size
  })

  return Buffer.concat([header, dir, ...pngs])
}

async function main() {
  await app.whenReady()
  const src = nativeImage.createFromBuffer(readFileSync(SOURCE))
  if (src.isEmpty()) throw new Error(`failed to load ${SOURCE}`)
  const srcSize = src.getSize()
  if (srcSize.width === 0) throw new Error(`empty image: ${SOURCE}`)

  const full = src.resize({ width: SIZE, height: SIZE, quality: 'best' })
  const pngs = ICO_SIZES.map((s) => full.resize({ width: s, height: s, quality: 'best' }).toPNG())
  writeFileSync(join(root, 'resources', 'icon.png'), full.toPNG())
  writeFileSync(join(root, 'resources', 'icon.ico'), packIco(pngs, ICO_SIZES))
  console.log(
    `[make-icon] ${srcSize.width}x${srcSize.height} -> resources/icon.png (${SIZE}px) + resources/icon.ico (${ICO_SIZES.length} sizes)`,
  )

  // Sanity-check the render: transparent corners (no white box), blue whale field.
  const bmp = full.toBitmap() // BGRA
  const w = full.getSize().width
  const px = (x, y) => {
    const o = (y * w + x) * 4
    return [bmp[o + 2], bmp[o + 1], bmp[o], bmp[o + 3]] // -> RGBA
  }
  const corner = px(4, 4)
  const center = px(Math.floor(w / 2), Math.floor(w / 2))
  let blues = 0
  let whites = 0
  for (let y = 0; y < w; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const [r, g, b, a] = px(x, y)
      if (a > 200 && b > 120 && b > r + 40 && b > g + 40) blues++
      if (a > 200 && r > 230 && g > 230 && b > 230) whites++
    }
  }
  console.log(`[make-icon] corner=${corner} center=${center} bluePx=${blues} whitePx=${whites}`)
  app.quit()
}

main().catch((error) => {
  console.error('[make-icon] failed:', error)
  app.exit(1)
})
