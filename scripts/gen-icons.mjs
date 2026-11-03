// Builds every icon from the brand mark in design/logo-source.png (the black "S").   Run: npm run icons
// Outputs (in public/): logo-1024.png, icon-192.png, icon-512.png, icon-maskable-512.png,
//                       apple-touch-icon.png, favicon-32.png, favicon-48.png, logo.svg, s-mark.png (transparent S for the hero)
import sharp from 'sharp'
import { writeFileSync } from 'node:fs'

const SRC = 'design/logo-source.png'
const BG = { r: 254, g: 254, b: 254 } // the source image's own background, so there is no visible seam

// 1) find the S (dark pixels) inside the source and cut it out with a small margin
const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
let x0 = info.width, y0 = info.height, x1 = 0, y1 = 0
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
  const i = (y * info.width + x) * 4
  if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 150) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
}
const m = 6
x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(info.width - 1, x1 + m); y1 = Math.min(info.height - 1, y1 + m)
const mark = await sharp(SRC).removeAlpha().extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toBuffer()
const markMeta = await sharp(mark).metadata()

/** the mark centred on a square canvas; `fill` = how much of the height the S takes up */
async function tile(size, fill, rounded) {
  const h = Math.round(size * fill)
  const w = Math.round(h * (markMeta.width / markMeta.height))
  const inner = await sharp(mark).resize(w, h, { fit: 'fill' }).png().toBuffer()
  let img = sharp({ create: { width: size, height: size, channels: 3, background: BG } })
    .composite([{ input: inner, left: Math.round((size - w) / 2), top: Math.round((size - h) / 2) }])
  if (rounded) {
    const r = Math.round(size * 0.22)
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="#fff"/></svg>`)
    img = sharp(await img.png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }])
  }
  return img.png({ compressionLevel: 9 }).toBuffer()
}
const out = (name, buf) => { writeFileSync(`public/${name}`, buf); console.log(name.padEnd(24), `${(buf.length / 1024).toFixed(1)} KB`) }

out('logo-1024.png', await tile(1024, 0.66, false))
out('icon-512.png', await tile(512, 0.66, true))
out('icon-192.png', await tile(192, 0.66, true))
out('icon-maskable-512.png', await tile(512, 0.5, false))   // full-bleed, S inside the 80% safe zone
out('apple-touch-icon.png', await tile(180, 0.66, false))   // iOS rounds the corners itself
out('favicon-32.png', await tile(32, 0.74, true))
out('favicon-48.png', await tile(48, 0.74, true))


// s-mark.png: the S with a TRANSPARENT background (alpha taken from darkness), for placing on coloured backgrounds like the Home hero
{
  const { data: px, info: pi } = await sharp(mark).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const rgba = Buffer.alloc(pi.width * pi.height * 4)
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    const lum = (px[i] + px[i + 1] + px[i + 2]) / 3
    let a = Math.pow(Math.max(0, 254 - lum) / 254, 0.8) * 1.12   // darker = more opaque
    a = a < 0.035 ? 0 : Math.min(1, a)
    rgba[j] = 14; rgba[j + 1] = 16; rgba[j + 2] = 30; rgba[j + 3] = Math.round(a * 255)
  }
  const buf = await sharp(rgba, { raw: { width: pi.width, height: pi.height, channels: 4 } }).resize({ height: 720 }).png({ compressionLevel: 9 }).toBuffer()
  out('s-mark.png', buf)
}

// logo.svg: the same mark as a scalable wrapper
const b64 = (await tile(512, 0.66, false)).toString('base64')
writeFileSync('public/logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><clipPath id="r"><rect width="512" height="512" rx="113"/></clipPath><image clip-path="url(#r)" width="512" height="512" xlink:href="data:image/png;base64,${b64}"/></svg>\n`)
console.log('logo.svg'.padEnd(24), 'ok')
