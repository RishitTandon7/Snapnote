import { supabase } from './supabase'

/**
 * Remote capture, two-stage:
 *   controller ──Broadcast "capture"──▶ viewer            (channel cap:<viewerDevice>)
 *   viewer ──Broadcast "preview" (~480px, <60KB)──▶ controller   (channel res:<controllerDevice>)
 *   viewer ──Storage upload full-res JPEG──▶ bucket ──Broadcast "full" {path}──▶ controller
 * Channels are PRIVATE (Realtime Authorization policies in supabase/schema.sql decide who may talk):
 * only the owner of the device LISTENS (openChannel); everyone else only SENDS over HTTPS (openSender).
 */
export const BUCKET = 'captures'
export const PREVIEW_MAX_PX = 480
export const PREVIEW_MAX_BYTES = 60_000

export interface CaptureRequest { captureId: string; fromUid: string; fromName: string; fromDeviceId: string; sentAt: number }
export interface PreviewEvt { captureId: string; dataUrl: string; w: number; h: number; viewerMs: number }
export interface FullEvt { captureId: string; path: string; bytes: number; w: number; h: number; viewerMs: number; method: string }
export interface FailEvt { captureId: string; message: string }

export interface Chan {
  /** resolves once SUBSCRIBED – keep the channel open so sends are instant */
  ready: Promise<void>
  send: (event: string, payload: unknown) => Promise<void>
  stop: () => void
}

export function openChannel(topic: string, on: Record<string, (payload: unknown) => void> = {}): Chan {
  type Ch = ReturnType<typeof supabase.channel>
  let channel: Ch | null = null
  let stopped = false
  const ready = (async () => {
    await supabase.realtime.setAuth() // private channels need the user's JWT on the socket
    // supabase-js hands back an existing channel for the same topic. If one is still being torn down (leaving a room and
    // coming straight back), reusing it would fail ("cannot add callbacks after subscribe"), so wait until it is gone first.
    const stale = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`)
    if (stale) await supabase.removeChannel(stale)
    if (stopped) return
    let ch: Ch = supabase.channel(topic, { config: { private: true, broadcast: { self: false } } })
    for (const [event, fn] of Object.entries(on)) ch = ch.on('broadcast', { event }, (m) => fn(m.payload))
    channel = ch
    await new Promise<void>((resolve, reject) => {
      ch.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err ?? new Error(`channel ${status}`))
      })
    })
  })()
  ready.catch(() => undefined) // surfaced by send()
  return {
    ready,
    send: async (event, payload) => {
      await ready
      if (!channel) throw new Error('channel closed')
      const r = await channel.send({ type: 'broadcast', event, payload })
      if (r !== 'ok') throw new Error(`Broadcast ${r}`)
    },
    stop: () => { stopped = true; if (channel) void supabase.removeChannel(channel) },
  }
}

/**
 * Send-only handle. Subscribing to a private channel needs READ permission, which only the device's owner has.
 * Senders (who only have WRITE permission) therefore post over HTTPS (`httpSend`) and never subscribe.
 */
export interface Sender {
  send: (event: string, payload: unknown) => Promise<void>
  stop: () => void
}

export function openSender(topic: string): Sender {
  const channel = supabase.channel(topic, { config: { private: true } })
  return {
    send: async (event, payload) => {
      await supabase.realtime.setAuth() // make sure the REST call carries the current login token
      await channel.httpSend(event, payload) // rejects with the server's message if the policy denies it
    },
    stop: () => { void supabase.removeChannel(channel) },
  }
}

export const newCaptureId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : '30000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0')

/* ─────────────────────────── viewer: real photo ─────────────────────────── */

interface ImageCaptureLike {
  getPhotoCapabilities(): Promise<{ imageWidth?: { max: number }; imageHeight?: { max: number } }>
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike

export interface PhotoRig { ic: ImageCaptureLike | null; settings?: { imageWidth: number; imageHeight: number } }

/** Pre-warm: read the camera's max still size once, when the stream starts (Android Chrome). */
export async function warmPhotoRig(track: MediaStreamTrack | undefined): Promise<PhotoRig> {
  const Ctor = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture
  if (!Ctor || !track) return { ic: null }
  try {
    const ic = new Ctor(track)
    const caps = await ic.getPhotoCapabilities()
    const w = caps.imageWidth?.max
    const h = caps.imageHeight?.max
    return { ic, settings: w && h ? { imageWidth: w, imageHeight: h } : undefined }
  } catch { return { ic: null } }
}

/** Camera's full-quality still. takePhoto() where supported, else the video frame at native size (JPEG 0.95). */
export async function grabFull(video: HTMLVideoElement, rig: PhotoRig): Promise<{ blob: Blob; w: number; h: number; method: 'takePhoto' | 'frame' }> {
  if (rig.ic) {
    try {
      const blob = await rig.ic.takePhoto(rig.settings)
      if (blob.size > 0) return { blob, w: rig.settings?.imageWidth ?? video.videoWidth, h: rig.settings?.imageHeight ?? video.videoHeight, method: 'takePhoto' }
    } catch { /* fall through to the frame grab */ }
  }
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) throw new Error('Camera not ready')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(video, 0, 0, w, h)
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Encode failed'))), 'image/jpeg', 0.95))
  return { blob, w, h, method: 'frame' }
}

/** ~480px JPEG under 60KB, made synchronously from the live frame so the first preview goes out at once. */
export function previewFromVideo(video: HTMLVideoElement): { dataUrl: string; w: number; h: number } {
  const sw = video.videoWidth
  const sh = video.videoHeight
  if (!sw || !sh) throw new Error('Camera not ready')
  const scale = Math.min(1, PREVIEW_MAX_PX / Math.max(sw, sh))
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(video, 0, 0, w, h)
  let q = 0.6
  let url = canvas.toDataURL('image/jpeg', q)
  while (url.length * 0.75 > PREVIEW_MAX_BYTES && q > 0.25) { q -= 0.1; url = canvas.toDataURL('image/jpeg', q) }
  return { dataUrl: url, w, h }
}

export async function uploadFull(path: string, blob: Blob): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false, cacheControl: '60' })
  if (error) throw new Error(error.message)
}

/** fallback TTL: the viewer deletes its own files older than 1h (the controller deletes on receipt) */
export async function cleanupOldCaptures(uid: string, maxAgeMs = 3_600_000): Promise<void> {
  try {
    const { data } = await supabase.storage.from(BUCKET).list(uid, { limit: 100 })
    const old = (data ?? []).filter((f) => f.created_at && Date.now() - Date.parse(f.created_at) > maxAgeMs).map((f) => `${uid}/${f.name}`)
    if (old.length) await supabase.storage.from(BUCKET).remove(old)
  } catch { /* best effort */ }
}

/* ───────────────────────── controller: receive + copy ───────────────────────── */

/**
 * One authenticated GET against the private bucket (one round trip fewer than signing a URL first).
 * Retries briefly in case the object isn't visible the instant the "full" event lands.
 */
export async function downloadFull(path: string): Promise<Blob> {
  let last: unknown
  for (let i = 0; i < 4; i++) {
    const { data, error } = await supabase.storage.from(BUCKET).download(path)
    if (data) return data
    last = error
    await new Promise((r) => setTimeout(r, 120 * (i + 1)))
  }
  throw new Error((last as { message?: string } | null)?.message ?? 'Download failed')
}

/** receipt confirmed → delete so the free-tier bucket never fills up */
export const removeCapture = (path: string) => supabase.storage.from(BUCKET).remove([path])

export const dataUrlToBlob = async (url: string): Promise<Blob> => (await fetch(url)).blob()

/* ───────────────────────────── debug timings ───────────────────────────── */

export function isDebug(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('debug')
    if (q === '1') localStorage.setItem('snapnote.debug', '1')
    if (q === '0') localStorage.removeItem('snapnote.debug')
    return localStorage.getItem('snapnote.debug') === '1'
  } catch { return false }
}
