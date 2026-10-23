export const MAX_DIM = 900
/** Base64 data-URL length budget. Firestore docs are capped at 1 MiB; stay well under. */
export const MAX_DATAURL_CHARS = 700_000

type Source = HTMLVideoElement | HTMLImageElement | ImageBitmap

function dims(src: Source): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight]
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight]
  return [src.width, src.height]
}

/** Downscale to max 900px and JPEG-encode at ~0.6, lowering quality / size until it fits the budget. */
export function compressToDataUrl(src: Source, mirror = false): string {
  const [sw, sh] = dims(src)
  if (!sw || !sh) throw new Error('Camera not ready yet')
  let scale = Math.min(1, MAX_DIM / Math.max(sw, sh))
  let quality = 0.6
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unsupported')
  for (let i = 0; i < 12; i++) {
    canvas.width = Math.round(sw * scale)
    canvas.height = Math.round(sh * scale)
    ctx.save()
    if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1) }
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
    ctx.restore()
    const url = canvas.toDataURL('image/jpeg', quality)
    if (url.length <= MAX_DATAURL_CHARS) return url
    if (quality > 0.3) quality -= 0.1
    else scale *= 0.8
  }
  throw new Error('Could not shrink photo enough')
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load image'))
    img.src = url
  })
}

export async function fileToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    return compressToDataUrl(img)
  } finally {
    URL.revokeObjectURL(url)
  }
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function wrapLines(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width <= maxWidth || !line) line = test
      else { lines.push(line); line = word }
    }
    lines.push(line)
  }
  return lines
}

/** The same overlay as the live display: soft dark gradient, centred auto-fit white text, sender above. */
export function drawOverlay(ctx: Ctx2D, w: number, h: number, text: string, from: string): void {
  if (!text.trim()) return
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7)
  g.addColorStop(0, 'rgba(0,0,0,0.55)')
  g.addColorStop(1, 'rgba(0,0,0,0.15)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const maxW = w * 0.82
  const maxH = h * 0.6
  let size = Math.round(w * 0.12)
  let lines: string[] = []
  ctx.font = `700 ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`
  for (; size > 14; size -= 2) {
    ctx.font = `700 ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`
    lines = wrapLines(ctx, text, maxW)
    if (lines.length * size * 1.2 <= maxH) break
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = size * 0.2
  const total = lines.length * size * 1.2
  lines.forEach((l, i) => ctx.fillText(l, w / 2, h / 2 - total / 2 + size * 1.2 * (i + 0.5)))
  if (from) {
    ctx.shadowBlur = 0
    ctx.font = `600 ${Math.round(w * 0.035)}px system-ui, sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.fillText(from, w / 2, h / 2 - total / 2 - w * 0.04)
  }
}

/** Draws photo + overlay text and returns a JPEG blob (manual "Save"). */
export async function composeImage(photoUrl: string, text: string, from: string): Promise<Blob> {
  const img = await loadImage(photoUrl)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  drawOverlay(ctx, w, h, text, from)
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), 'image/jpeg', 0.92),
  )
}

/** Clipboards only accept image/png. Full size, optionally with the text overlay burned in. */
export async function toPngBlob(src: Blob, overlay?: { text: string; from: string }): Promise<Blob> {
  const bmp = await createImageBitmap(src)
  const w = bmp.width
  const h = bmp.height
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      if (overlay) drawOverlay(ctx, w, h, overlay.text, overlay.from)
      return await c.convertToBlob({ type: 'image/png' })
    }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    if (overlay) drawOverlay(ctx, w, h, overlay.text, overlay.from)
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG export failed'))), 'image/png'))
  } finally {
    bmp.close()
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
