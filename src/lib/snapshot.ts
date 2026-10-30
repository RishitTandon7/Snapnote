import { downloadBlob } from './image'

type ToastFn = (
  msg: string,
  kind?: 'info' | 'error' | 'success',
  opts?: { thumb?: string; action?: { label: string; run: () => void }; ms?: number },
) => void

export interface SnapView { rotate?: number; zoom?: number; panX?: number; panY?: number }

/**
 * Turn a picture into what the person sees on screen: the chosen rotation, zoom and pan.
 * `src` is anything drawable (video frame or full-resolution photo); a lossless PNG comes out.
 */
function render(src: CanvasImageSource, w: number, h: number, view: SnapView): HTMLCanvasElement {
  const rot = (((view.rotate ?? 0) % 360) + 360) % 360
  const zoom = Math.max(1, view.zoom ?? 1)
  const sideways = rot === 90 || rot === 270
  // 1) the whole frame, rotated (unmirrored: the real picture, not the selfie preview)
  const fw = sideways ? h : w, fh = sideways ? w : h
  const full = document.createElement('canvas')
  full.width = fw
  full.height = fh
  const fg = full.getContext('2d')!
  fg.imageSmoothingQuality = 'high'
  fg.translate(fw / 2, fh / 2)
  fg.rotate((rot * Math.PI) / 180)
  fg.drawImage(src, -w / 2, -h / 2, w, h)
  if (zoom === 1) return full
  // 2) the part you are looking at: zoom = crop size, pan = where the crop sits
  const cw = fw / zoom, ch = fh / zoom
  const cx = Math.min(fw - cw, Math.max(0, (0.5 - (view.panX ?? 0) / zoom) * fw - cw / 2))
  const cy = Math.min(fh - ch, Math.max(0, (0.5 - (view.panY ?? 0) / zoom) * fh - ch / 2))
  const out = document.createElement('canvas')
  out.width = Math.round(cw)
  out.height = Math.round(ch)
  const og = out.getContext('2d')!
  og.imageSmoothingQuality = 'high'
  og.drawImage(full, cx, cy, cw, ch, 0, 0, out.width, out.height)
  return out
}

/** the camera's still has more picture around it than the video (4:3 vs 16:9): cut it to the video's shape so zoom/pan line up */
async function stillAsVideoShape(still: Blob, vw: number, vh: number): Promise<{ bmp: ImageBitmap; w: number; h: number }> {
  const bmp = await createImageBitmap(still) // applies the photo's own orientation
  const want = vw / vh
  const have = bmp.width / bmp.height
  if (Math.abs(have - want) / want < 0.02) return { bmp, w: bmp.width, h: bmp.height }
  let w = bmp.width, h = bmp.height
  if (have > want) w = Math.round(h * want); else h = Math.round(w / want)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.drawImage(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h, 0, 0, w, h)
  bmp.close()
  return { bmp: await createImageBitmap(c), w, h }
}

/**
 * Copy a snapshot to the clipboard. Call it straight from a click (browsers only allow clipboard writes then).
 * `hd` (optional) is a promise for the camera's full-resolution photo; if it arrives in time that is used,
 * otherwise the current video frame is (full size of the stream, still lossless PNG).
 */
export function snapshotToClipboard(video: HTMLVideoElement, who: string, toast: ToastFn, view: SnapView = {}, hd?: Promise<Blob> | null): void {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) { toast('No picture to capture yet', 'error'); return }

  // take the video frame NOW (it is the fallback, and the instant thumbnail)
  const frame = document.createElement('canvas')
  frame.width = w
  frame.height = h
  frame.getContext('2d')!.drawImage(video, 0, 0, w, h)
  const quick = render(frame, w, h, view)
  const k = 96 / Math.max(quick.width, quick.height)
  const small = document.createElement('canvas')
  small.width = Math.round(quick.width * k)
  small.height = Math.round(quick.height * k)
  small.getContext('2d')!.drawImage(quick, 0, 0, small.width, small.height)
  const thumb = small.toDataURL('image/jpeg', 0.7)

  const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the picture'))), 'image/png'))
  const clip = (blob: Promise<Blob>, ok: () => void, fail: () => void) => {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(ok).catch(fail)
    else fail()
  }

  // 1) INSTANT: the picture on screen goes to the clipboard right away
  const quickBlob = toBlob(quick)
  const saveQuick = () => void quickBlob.then((b) => downloadBlob(b, `snapnote-${Date.now()}.png`))
  clip(quickBlob,
    () => toast(`Snapshot of ${who} copied ✓${hd ? ' · getting HD…' : ''}`, 'success', { thumb, ms: hd ? 2500 : 3200 }),
    () => toast("Couldn't copy it", 'info', { thumb, action: { label: 'Save', run: saveQuick }, ms: 10_000 }))

  // 2) a moment later: the camera's full-quality photo, ready to copy with one tap
  if (hd) {
    void (async () => {
      try {
        const still = await hd
        const s = await stillAsVideoShape(still, w, h)
        const out = render(s.bmp, s.w, s.h, view)
        s.bmp.close()
        const hdBlob = toBlob(out)
        const saveHd = () => void hdBlob.then((b) => downloadBlob(b, `snapnote-hd-${Date.now()}.png`))
        toast(`HD photo of ${who} is ready`, 'success', {
          thumb, ms: 15_000,
          action: { label: 'Copy HD', run: () => clip(hdBlob, () => toast('HD snapshot copied ✓', 'success'), () => toast("Couldn't copy it", 'info', { action: { label: 'Save', run: saveHd }, ms: 10_000 })) },
        })
      } catch { /* the instant copy above already has the picture */ }
    })()
  }
}
