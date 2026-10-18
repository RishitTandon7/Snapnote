import { useCallback, useEffect, useRef, useState } from 'react'
import { useGoBack } from '../lib/nav'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { supabase } from '../lib/supabase'
import { watchMessages } from '../lib/messages'
import {
  cleanupOldCaptures, grabFull, isDebug, openChannel, openSender, previewFromVideo, uploadFull, warmPhotoRig,
  type CaptureRequest, type Sender, type FailEvt, type FullEvt, type PhotoRig, type PreviewEvt,
} from '../lib/capture'
import { compressToDataUrl, composeImage, downloadBlob, fileToDataUrl } from '../lib/image'
import { openCamera } from '../lib/camera'
import { friendlyError, getDeviceId } from '../lib/util'
import { TextOverlay } from '../components/ui'

type Cam = 'starting' | 'ready' | 'denied'
interface Incoming { text: string; from: string; key: number }

export function DisplayPage() {
  const { user } = useAuth()
  const toast = useToast()
  const goBack = useGoBack()
  const uid = user!.id
  const deviceId = getDeviceId()
  const debug = isDebug()

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [cam, setCam] = useState<Cam>('starting')
  const [frozen, setFrozen] = useState<string | null>(null)
  const [msg, setMsg] = useState<Incoming>({ text: '', from: '', key: 0 })
  const [flash, setFlash] = useState(0)
  const [dnd, setDnd] = useState(false)
  const [connected, setConnected] = useState(navigator.onLine)
  const [log, setLog] = useState('')
  const [camError, setCamError] = useState('')

  // refs let long-lived listeners see fresh state
  const dndRef = useRef(false)
  const camRef = useRef<Cam>('starting')
  const rigRef = useRef<PhotoRig>({ ic: null })
  const resChans = useRef(new Map<string, Sender>())
  useEffect(() => { dndRef.current = dnd }, [dnd])
  useEffect(() => { camRef.current = cam }, [cam])

  // entering display mode makes this device a display
  useEffect(() => { void supabase.from('devices').update({ is_display: true }).eq('id', deviceId).then(() => undefined) }, [deviceId])

  // camera: highest resolution, kept running ("warm") so a capture starts instantly
  useEffect(() => {
    let cancelled = false
    streamRef.current?.getTracks().forEach((t) => t.stop())
    setCam('starting')
    setCamError('')
    openCamera({ facingMode: { ideal: facing }, width: { ideal: 4096 }, height: { ideal: 2160 } })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = s
        const v = videoRef.current
        if (v) { v.srcObject = s; void v.play().catch(() => undefined) }
        setCam('ready')
        void warmPhotoRig(s.getVideoTracks()[0]).then((r) => { if (!cancelled) rigRef.current = r }) // cache max still size
      })
      .catch((e: Error) => { if (!cancelled) { setCamError(e.message); setCam('denied') } })
    return () => { cancelled = true; streamRef.current?.getTracks().forEach((t) => t.stop()) }
  }, [facing])

  // keep screen awake (best effort)
  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    const get = () => navigator.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => undefined)
    void get()
    const onVis = () => document.visibilityState === 'visible' && void get()
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); void lock?.release().catch(() => undefined) }
  }, [])

  useEffect(() => {
    const on = () => setConnected(true), off = () => setConnected(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const doFlash = () => { setFlash((n) => n + 1); navigator.vibrate?.(60) }

  /** result channels are opened on first use and kept warm for the rest of the session */
  const getRes = useCallback((controllerDeviceId: string): Sender => {
    let c = resChans.current.get(controllerDeviceId)
    if (!c) { c = openSender(`res:${controllerDeviceId}`); resChans.current.set(controllerDeviceId, c) }
    return c
  }, [])

  /**
   * Remote capture. Stage 1: tiny preview goes out immediately from the live frame.
   * Stage 2 (started in parallel): the camera's real still → private Storage → broadcast the path.
   */
  const handleCapture = useCallback(async (req: CaptureRequest) => {
    const t0 = performance.now()
    const res = getRes(req.fromDeviceId)
    const fail = (message: string) => void res.send('fail', { captureId: req.captureId, message } satisfies FailEvt).catch(() => undefined)
    if (dndRef.current) return fail('Do not disturb is on')
    const video = videoRef.current
    if (!video || camRef.current !== 'ready' || !video.videoWidth) return fail('Their camera is not ready')

    doFlash()
    let preview: ReturnType<typeof previewFromVideo>
    try { preview = previewFromVideo(video) } catch { return fail('Could not read the camera') }
    setFrozen(preview.dataUrl)
    const previewSent = res.send('preview', { captureId: req.captureId, dataUrl: preview.dataUrl, w: preview.w, h: preview.h, viewerMs: Math.round(performance.now() - t0) } satisfies PreviewEvt)

    try {
      const full = await grabFull(video, rigRef.current)           // runs while the preview is in flight
      const tPhoto = performance.now() - t0
      const path = `${uid}/${req.fromUid}_${req.captureId}.jpg`
      await uploadFull(path, full.blob)
      const tUp = performance.now() - t0
      await res.send('full', { captureId: req.captureId, path, bytes: full.blob.size, w: full.w, h: full.h, viewerMs: Math.round(tUp), method: full.method } satisfies FullEvt)
      if (debug) setLog(`${full.method} ${full.w}×${full.h} ${(full.blob.size / 1e6).toFixed(2)}MB · photo ${Math.round(tPhoto)}ms · uploaded ${Math.round(tUp)}ms`)
    } catch (e) {
      fail(friendlyError(e))
    }
    void previewSent.catch(() => undefined)
    void cleanupOldCaptures(uid)
  }, [getRes, uid, debug])

  // low-latency trigger channel for THIS device, subscribed the whole time Display mode is open
  const handleRef = useRef(handleCapture)
  useEffect(() => { handleRef.current = handleCapture }, [handleCapture])
  useEffect(() => {
    const chan = openChannel(`cap:${deviceId}`, { capture: (p) => void handleRef.current(p as CaptureRequest) })
    chan.ready.then(() => setConnected(navigator.onLine)).catch(() => setConnected(false))
    const chans = resChans.current
    return () => { chan.stop(); chans.forEach((c) => c.stop()); chans.clear() }
  }, [deviceId])

  // local shutter: freeze a frame on this device
  const localCapture = () => {
    const v = videoRef.current
    if (!v || camRef.current !== 'ready') return
    try { const url = compressToDataUrl(v, facing === 'user'); doFlash(); setFrozen(url) } catch (e) { toast(friendlyError(e), 'error') }
  }

  // gallery fallback
  const onPick = async (file: File | undefined) => {
    if (!file) return
    try { setFrozen(await fileToDataUrl(file)) } catch (e) { toast(friendlyError(e), 'error') }
  }

  // text / clear messages for THIS device (stored, so they replay when Display opens)
  useEffect(() => {
    const w = watchMessages(deviceId, (m) => {
      if (dndRef.current) return
      if (m.type === 'text') setMsg((p) => ({ text: m.body, from: m.from_name, key: p.key + 1 }))
      else if (m.type === 'clear') setMsg((p) => ({ text: '', from: '', key: p.key + 1 }))
    }, (ok) => setConnected(ok && navigator.onLine))
    return () => w.stop()
  }, [deviceId])

  const save = async () => {
    if (!frozen) return
    try { downloadBlob(await composeImage(frozen, msg.text, msg.from), `snapnote-${Date.now()}.jpg`) } catch (e) { toast(friendlyError(e), 'error') }
  }

  const fileInput = <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onPick(e.target.files?.[0]); e.target.value = '' }} />

  if (cam === 'denied' && !frozen) {
    return (
      <div className="safe-top safe-bottom flex h-full flex-col items-center justify-center px-8 text-center">
        <div className="mb-4 text-6xl">🙈</div>
        <h1 className="text-2xl font-bold">Camera is off-limits</h1>
        <p className="mt-2 max-w-xs text-ink/60">{camError || 'Allow camera access in your browser settings and reload.'}</p>
        <p className="mt-2 max-w-xs text-[13px] text-ink/40">You can still pick a photo from your gallery. Remote capture needs the camera.</p>
        <div className="mt-6 flex w-full max-w-xs flex-col gap-3">
          <button className="ui-btn-dark" onClick={() => fileRef.current?.click()}>Choose a photo</button>
          <button className="ui-btn-light" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}>Try camera again</button>
          <button className="ui-btn-light" onClick={() => goBack('/')}>Exit</button>
        </div>
        {fileInput}
        {/* text still shows even without a camera */}
        {msg.text && <div className="fixed inset-0"><TextOverlay text={msg.text} from={msg.from} msgKey={msg.key} /></div>}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-white">
      <video ref={videoRef} playsInline muted autoPlay className={`h-full w-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`} />
      {frozen && <img src={frozen} alt="Captured" className="absolute inset-0 h-full w-full object-cover" />}
      {!dnd && <TextOverlay text={msg.text} from={msg.from} msgKey={msg.key} />}
      {flash > 0 && <div key={flash} className="flash pointer-events-none absolute inset-0 bg-white" />}

      <div className="safe-top absolute inset-x-0 top-0 flex items-center justify-between p-4">
        <button className="rounded-full bg-black/40 px-4 py-2 text-sm backdrop-blur" onClick={() => goBack('/')}>✕ Exit</button>
        <div className="flex items-center gap-2">
          <span className={`h-3 w-3 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} title={connected ? 'Connected' : 'Offline'} />
          <button className={`rounded-full px-4 py-2 text-sm backdrop-blur ${dnd ? 'bg-pink/80' : 'bg-black/40'}`} onClick={() => setDnd((v) => !v)}>
            {dnd ? '🔕 DND on' : '🔔 DND'}
          </button>
        </div>
      </div>

      {debug && log && <div className="absolute left-3 top-20 rounded-lg bg-black/60 px-2 py-1 font-mono text-[10px] text-emerald-300">{log}</div>}

      <div className="safe-bottom absolute inset-x-0 bottom-0 flex items-center justify-around p-6">
        {frozen ? (
          <>
            <button className="rounded-full bg-black/50 px-5 py-3 backdrop-blur" onClick={save}>Save</button>
            <button className="btn !bg-white !text-ink !px-8 !py-4 text-lg" onClick={() => setFrozen(null)}>Retake</button>
            <span className="w-16" />
          </>
        ) : (
          <>
            <button className="flex h-12 w-12 items-center justify-center rounded-full bg-black/40 text-xl backdrop-blur" aria-label="Pick from gallery" onClick={() => fileRef.current?.click()}>🖼</button>
            <button className="shutter flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/10 backdrop-blur" aria-label="Take photo" onClick={localCapture}>
              <span className="h-14 w-14 rounded-full bg-white" />
            </button>
            <button className="flex h-12 w-12 items-center justify-center rounded-full bg-black/40 text-xl backdrop-blur" aria-label="Flip camera" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}>⟲</button>
          </>
        )}
      </div>
      {fileInput}
    </div>
  )
}
