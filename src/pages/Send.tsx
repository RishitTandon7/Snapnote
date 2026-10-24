import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { useFriendDevices, useMyDevices, useNow, useProfiles } from '../hooks/useData'
import { sendLiveText, sendMessage } from '../lib/messages'
import {
  dataUrlToBlob, downloadFull, isDebug, newCaptureId, openChannel, openSender, removeCapture,
  type CaptureRequest, type FailEvt, type FullEvt, type PreviewEvt, type Sender,
} from '../lib/capture'
import { composeImage, downloadBlob, toPngBlob } from '../lib/image'
import { useGoBack } from '../lib/nav'
import { offlineFor } from '../lib/duration'
import { createRateLimiter, friendlyError, getDeviceId, isOnline, MAX_TEXT } from '../lib/util'
import { Toggle, TextOverlay } from '../components/ui'
import type { Device } from '../types'

interface Photo { url: string; text: string; hd: boolean }
interface HistItem { id: string; url: string; blob: Blob; text: string; hd: boolean }
interface Pending {
  captureId: string
  t0: number
  from: string
  overlay?: { text: string; from: string }
  resolveFull: (b: Blob) => void
  rejectFull: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  previewUrl?: string
  fullBlob?: Blob
}
interface Timing { preview?: number; fullEvent?: number; downloaded?: number; copied?: number; viewer?: string }

const COPY_TIMEOUT_MS = 15_000
const HISTORY = 5
const canCopyImages = () => typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

export function SendPage() {
  const { uid: targetParam = '' } = useParams()
  const [sp] = useSearchParams()
  const goBack = useGoBack()
  const toast = useToast()
  const { user, profile } = useAuth()
  const me = user!.id
  const myDeviceId = getDeviceId()
  const isSelf = targetParam === 'me'
  const targetUid = isSelf ? me : targetParam
  const now = useNow()
  const debug = isDebug()

  const myDevices = useMyDevices(isSelf ? me : undefined)
  const { byOwner } = useFriendDevices(isSelf ? undefined : me)
  const devices: Device[] = useMemo(
    () => (isSelf ? (myDevices ?? []).filter((d) => d.is_display && d.id !== myDeviceId) : byOwner[targetUid] ?? []),
    [isSelf, myDevices, byOwner, targetUid, myDeviceId],
  )
  const profiles = useProfiles(isSelf ? [] : [targetUid])
  const targetName = isSelf ? 'My devices' : profiles.get(targetUid)?.display_name ?? '…'

  const [picked, setPicked] = useState<string | null>(sp.get('device'))
  const device = devices.find((d) => d.id === picked) ?? devices.find((d) => isOnline(d.last_seen, now)) ?? devices[0]
  const online = isOnline(device?.last_seen, now)

  const [text, setText] = useState('')
  const [live, setLive] = useState(false)
  const [shown, setShown] = useState('')      // what's currently on their screen (as far as we know)
  const [shownKey, setShownKey] = useState(0)
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [copying, setCopying] = useState(false)
  const [includeText, setIncludeText] = useState(false)
  const [history, setHistory] = useState<HistItem[]>([])
  const [timing, setTiming] = useState<Timing>({})
  const limiter = useRef(createRateLimiter(5, 1000)).current
  const shownRef = useRef('')
  const pending = useRef<Pending | null>(null)
  const trigger = useRef<Sender | null>(null)

  const base = useMemo(
    () => device ? { fromDeviceId: myDeviceId, toUid: targetUid, toDeviceId: device.id } : null,
    [device, myDeviceId, targetUid],
  )
  const deviceId = device?.id

  const show = (t: string) => { shownRef.current = t; setShown(t); setShownKey((k) => k + 1) }
  const mark = (patch: Partial<Timing>) => setTiming((t) => ({ ...t, ...patch }))

  /* ── clipboard (must be called synchronously from a click) ── */
  const copyPromise = useCallback((src: Promise<Blob>, overlay?: { text: string; from: string }): Promise<void> => {
    try {
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': src.then((b) => toPngBlob(b, overlay)) })])
    } catch (e) { return Promise.reject(e) }
  }, [])

  /** tap-to-copy fallback: best image we have right now (full if it arrived, else the preview) */
  const copyBest = () => {
    const p = pending.current
    const src = p?.fullBlob ? Promise.resolve(p.fullBlob) : p?.previewUrl ? dataUrlToBlob(p.previewUrl) : null
    if (!src) { toast('Nothing to copy yet', 'error'); return }
    copyPromise(src, p?.overlay).then(() => toast('Copied to clipboard ✓', 'success')).catch(() => toast('Copy failed — use Save', 'error'))
  }

  const copyItem = (it: HistItem) => {
    if (!canCopyImages()) { toast('This browser can\'t copy images — use Save', 'error'); return }
    const ov = includeText && it.text ? { text: it.text, from: profile?.display_name ?? '' } : undefined
    copyPromise(Promise.resolve(it.blob), ov)
      .then(() => toast('Copied to clipboard ✓', 'success', { thumb: it.url }))
      .catch(() => toast('Copy failed — use Save', 'error'))
  }

  /* ── results coming back from the Viewer (Broadcast, kept subscribed) ── */
  const onPreview = (e: PreviewEvt) => {
    const p = pending.current
    if (!p || p.captureId !== e.captureId) return
    p.previewUrl = e.dataUrl
    setPhoto({ url: e.dataUrl, text: p.overlay?.text ?? shownRef.current, hd: false })
    mark({ preview: Math.round(performance.now() - p.t0) })
  }
  const onFull = async (e: FullEvt) => {
    const p = pending.current
    if (!p || p.captureId !== e.captureId) return
    mark({ fullEvent: Math.round(performance.now() - p.t0), viewer: `${e.method} ${e.w}×${e.h} ${(e.bytes / 1e6).toFixed(2)}MB · viewer ${e.viewerMs}ms` })
    try {
      const blob = await downloadFull(e.path)
      p.fullBlob = blob
      mark({ downloaded: Math.round(performance.now() - p.t0) })
      const url = URL.createObjectURL(blob)
      const t = p.overlay?.text ?? shownRef.current
      setPhoto({ url, text: t, hd: true })
      setHistory((h) => {
        const next = [{ id: p.captureId, url, blob, text: t, hd: true }, ...h]
        next.slice(HISTORY).forEach((old) => URL.revokeObjectURL(old.url))
        return next.slice(0, HISTORY)
      })
      p.resolveFull(blob)              // → completes the clipboard write that was started on the click
      void removeCapture(e.path)       // receipt confirmed → free the bucket
    } catch (err) {
      p.rejectFull(err instanceof Error ? err : new Error('download failed'))
    } finally {
      clearTimeout(p.timer)
      setWaiting(false)
    }
  }
  const onFail = (e: FailEvt) => {
    const p = pending.current
    if (!p || p.captureId !== e.captureId) return
    clearTimeout(p.timer)
    p.rejectFull(new Error(e.message))
    setWaiting(false)
    toast(e.message, 'error')
  }
  const handlers = useRef({ onPreview, onFull, onFail })
  useEffect(() => { handlers.current = { onPreview, onFull, onFail } })

  useEffect(() => {
    const chan = openChannel(`res:${myDeviceId}`, {
      preview: (p) => handlers.current.onPreview(p as PreviewEvt),
      full: (p) => void handlers.current.onFull(p as FullEvt),
      fail: (p) => handlers.current.onFail(p as FailEvt),
    })
    return () => chan.stop()
  }, [myDeviceId])

  // trigger channel to the selected device (send-only: only the device's owner may listen)
  useEffect(() => {
    if (!deviceId) return
    const c = openSender(`cap:${deviceId}`)
    trigger.current = c
    return () => { c.stop(); if (trigger.current === c) trigger.current = null }
  }, [deviceId])

  useEffect(() => () => { clearTimeout(pending.current?.timer) }, [])

  // debounced "show as I type" → one live row, overwritten
  useEffect(() => {
    if (!live || !base) return
    const t = setTimeout(() => {
      if (!limiter()) return
      sendLiveText({ ...base, body: text }).then(() => show(text)).catch((e) => toast(friendlyError(e), 'error'))
    }, 150)
    return () => clearTimeout(t)
  }, [text, live, base, limiter, toast])

  const guard = (): boolean => {
    if (!base) { toast('Pick a device first', 'error'); return false }
    if (!limiter()) { toast('Slow down a little 🙂'); return false }
    return true
  }

  const send = async () => {
    if (!guard() || !base || !text.trim()) return
    try { await sendMessage({ ...base, type: 'text', body: text }); show(text); if (!live) setText('') }
    catch (e) { toast(friendlyError(e), 'error') }
  }
  const clear = async () => {
    if (!guard() || !base) return
    try { await sendMessage({ ...base, type: 'clear' }); show(''); setText('') } catch (e) { toast(friendlyError(e), 'error') }
  }

  /**
   * CAPTURE. Everything up to the clipboard.write() call is synchronous inside the click, because browsers only
   * allow clipboard writes during a user gesture. The ClipboardItem holds a *promise* that resolves when the
   * full-resolution image arrives, so the copy completes by itself a moment later.
   */
  const capture = () => {
    if (!guard() || !base || !trigger.current) return
    const captureId = newCaptureId()
    const t0 = performance.now()
    const overlay = includeText && shownRef.current ? { text: shownRef.current, from: profile?.display_name ?? '' } : undefined

    let resolveFull!: (b: Blob) => void
    let rejectFull!: (e: Error) => void
    const fullP = new Promise<Blob>((res, rej) => { resolveFull = res; rejectFull = rej })
    const timer = setTimeout(() => rejectFull(new Error('timeout')), COPY_TIMEOUT_MS)
    pending.current = { captureId, t0, from: profile?.display_name ?? '', overlay, resolveFull, rejectFull, timer }
    setTiming({})
    setWaiting(true)

    if (canCopyImages()) {
      setCopying(true)
      copyPromise(fullP, overlay)                                         // ← synchronous, inside the gesture
        .then(() => {
          mark({ copied: Math.round(performance.now() - t0) })
          toast('Copied to clipboard ✓', 'success', { thumb: pending.current?.fullBlob ? URL.createObjectURL(pending.current.fullBlob) : undefined })
        })
        .catch((err: unknown) => {
          setWaiting(false)
          const p = pending.current
          if (p?.previewUrl || p?.fullBlob) toast('Couldn\'t copy automatically', 'info', { action: { label: 'Tap to copy', run: copyBest } })
          else if (err instanceof Error && err.message === 'timeout') toast('No photo came back — is their display open?', 'error')
          // any other failure was already reported (viewer error / send failed)
        })
        .finally(() => setCopying(false))
    } else {
      fullP.catch(() => undefined)
      toast('This browser can\'t copy images — use Save', 'info')
    }

    const req: CaptureRequest = { captureId, fromUid: me, fromName: profile?.display_name ?? '', fromDeviceId: myDeviceId, sentAt: Date.now() }
    trigger.current.send('capture', req).catch((e) => {
      clearTimeout(timer)
      rejectFull(e instanceof Error ? e : new Error('send failed'))
      setWaiting(false)
      toast(friendlyError(e), 'error')
    })
  }

  const save = async () => {
    if (!photo) return
    try { downloadBlob(await composeImage(photo.url, photo.text, targetName), `snapnote-${Date.now()}.jpg`) } catch (e) { toast(friendlyError(e), 'error') }
  }

  return (
    <div className="safe-top safe-bottom mx-auto flex h-full max-w-[430px] flex-col md:max-w-xl px-5 pb-4 pt-4">
      <div className="mb-3 flex items-center gap-3">
        <button className="ui-btn-light !px-3 !py-2" onClick={() => goBack('/')} aria-label="Back">←</button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold">{targetName}</div>
          <div className="flex items-center gap-1.5 text-xs text-ink/50">
            <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            {device ? `${device.name} · ${online ? 'online' : `${offlineFor(device.last_seen, now).toLowerCase()} — it will show when it opens`}` : 'No device available'}
          </div>
        </div>
      </div>

      {devices.length > 1 && (
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {devices.map((d) => (
            <button key={d.id} onClick={() => setPicked(d.id)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${d.id === device?.id ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>
              {isOnline(d.last_seen, now) ? '● ' : '○ '}{d.name}
            </button>
          ))}
        </div>
      )}

      {/* live preview of their screen / the captured photo */}
      <div className="relative mx-auto mb-2 aspect-[3/4] max-h-[40vh] min-h-0 w-auto flex-1 overflow-hidden rounded-3xl border border-line bg-card">
        {photo ? <img src={photo.url} alt="Captured" className="h-full w-full object-cover" />
          : <div className="flex h-full items-center justify-center text-sm text-ink/30">{waiting ? 'Waiting for photo…' : 'Their screen'}</div>}
        {waiting && <div className="absolute inset-x-0 top-0 h-1 animate-pulse bg-brand" />}
        <TextOverlay text={photo ? photo.text : shown} msgKey={shownKey} compact />
        {photo && (
          <span className={`absolute right-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-bold ${photo.hd ? 'bg-ink text-white' : 'bg-white/80 text-ink/60 backdrop-blur'}`}>
            {photo.hd ? 'HD' : 'preview…'}
          </span>
        )}
        {photo && (
          <div className="absolute inset-x-3 bottom-3 flex gap-2">
            <button className="ui-btn-dark flex-1 !py-2" onClick={save}>Save image</button>
            <button className="ui-btn-light !py-2" onClick={() => setPhoto(null)}>Dismiss</button>
          </div>
        )}
      </div>

      {/* last captures (memory only) – tap to copy */}
      {history.length > 0 && (
        <div className="mb-2 flex items-center gap-2 overflow-x-auto">
          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-ink/40">Tap to copy</span>
          {history.map((h) => (
            <button key={h.id} aria-label="Copy this capture" onClick={() => copyItem(h)} className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-line active:scale-90">
              <img src={h.url} alt="" className="h-full w-full object-cover" />
              <span className="absolute bottom-0 right-0 rounded-tl-md bg-ink px-1 text-[8px] font-bold text-white">HD</span>
            </button>
          ))}
        </div>
      )}

      <div className="mb-2 grid grid-cols-2 gap-2">
        <div className="flex items-center justify-between rounded-2xl border border-line bg-card px-3.5 py-2.5">
          <span className="text-[13px]">Show as I type</span>
          <Toggle on={live} onChange={setLive} label="Show as I type" />
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-line bg-card px-3.5 py-2.5">
          <span className="text-[13px]">Text on copied photo</span>
          <Toggle on={includeText} onChange={setIncludeText} label="Include text overlay" />
        </div>
      </div>
      <div className="mb-2 flex gap-2">
        <button className="ui-btn-light flex-1 !py-2.5 text-sm" disabled={!device || waiting} onClick={capture}>
          {copying ? '⏳ Copying…' : waiting ? '⏳ Capturing…' : '📷 Capture on their device'}
        </button>
        <button className="ui-btn-light !py-2.5 text-sm" disabled={!device} onClick={clear}>Clear text</button>
      </div>
      <div className="flex items-end gap-2">
        <textarea className="ui-field max-h-32 min-h-[3.25rem] flex-1 resize-none !rounded-3xl" rows={1} maxLength={MAX_TEXT} placeholder="Type something…" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} />
        <button className="ui-btn-dark h-[3.25rem] w-[3.25rem] !rounded-full !p-0 text-xl" disabled={!device || !text.trim()} onClick={send} aria-label="Send">➤</button>
      </div>
      <div className="mt-1 text-right text-[11px] text-ink/30">{text.length}/{MAX_TEXT}</div>

      {debug && (
        <div className="pointer-events-none fixed bottom-2 left-2 z-[95] rounded-lg bg-black/75 px-2.5 py-1.5 font-mono text-[10px] leading-snug text-emerald-300">
          <div>trigger→preview: {timing.preview ?? '–'} ms</div>
          <div>trigger→full event: {timing.fullEvent ?? '–'} ms</div>
          <div>trigger→downloaded: {timing.downloaded ?? '–'} ms</div>
          <div>trigger→clipboard: {timing.copied ?? '–'} ms</div>
          {timing.viewer && <div className="text-white/70">{timing.viewer}</div>}
        </div>
      )}
    </div>
  )
}
