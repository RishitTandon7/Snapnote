import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { useActiveRoom } from '../context/ActiveRoom'
import { notifyChanged, useProfiles } from '../hooks/useData'
import { useJoinRequests, useRoom } from '../hooks/useRooms'
import { openChannel } from '../lib/capture'
import { openCamera, openMic } from '../lib/camera'
import { sendMessage, watchMessages } from '../lib/messages'
import { useGoBack } from '../lib/nav'
import { RoomRtc, type PeerStatus, type PresenceEvent, type RemoteMedia } from '../lib/rtc'
import { formatDuration } from '../lib/duration'
import { rpc } from '../lib/supabase'
import { useWakeLock } from '../lib/wakelock'
import { admitRequest, cancelJoin, denyRequest, enterRoom, leaveRoom, roomLink, setRoomApproval, setRoomDevice, type EnterResult } from '../lib/rooms'
import { playPing, setSoundsOn, soundsOn } from '../lib/sound'
import { snapshotToClipboard } from '../lib/snapshot'
import { grabFull, warmPhotoRig } from '../lib/capture'
import { friendlyError, getDeviceId } from '../lib/util'
import { applyTheme, setTheme } from '../lib/theme'
import { useWatchSync, type SyncMsg } from '../lib/watchSync'
import { TextOverlay } from '../components/ui'
import { Avatar, Sheet, Skeleton } from '../screens/CallScreen/primitives'
import { CallScreen, StreamVideo, type Layout, type RoomTile } from '../screens/CallScreen/CallScreen'
import { CallScope } from '../screens/CallScreen/CallScope'

const rigs = new WeakMap<MediaStreamTrack, Awaited<ReturnType<typeof warmPhotoRig>>>()

/** a high-resolution photo from a live camera stream (long side capped at 3072 px, about 2 MB, so it travels in a second or two) */
async function takeStill(stream: MediaStream | null): Promise<Blob> {
  const track = stream?.getVideoTracks()[0]
  if (!stream || !track) throw new Error('no-camera')
  let rig = rigs.get(track)
  if (!rig) { rig = await warmPhotoRig(track); rigs.set(track, rig) } // looked up once per camera, not on every snapshot
  if (rig.ic && rig.settings) {
    const { imageWidth: w, imageHeight: h } = rig.settings
    const k = Math.min(1, 3072 / Math.max(w, h))
    try {
      const b = await rig.ic.takePhoto({ imageWidth: Math.round(w * k), imageHeight: Math.round(h * k) })
      if (b.size > 0) return b
    } catch { /* use a video frame instead */ }
  }
  // iPhone (no ImageCapture): read the frame from the picture already on screen. Never open the camera a second time:
  // on iOS a second reader on the camera makes the sent video go black for everyone else after a click or two.
  const onScreen = [...document.querySelectorAll('video')].find((el) => (el.srcObject as MediaStream | null)?.getVideoTracks().includes(track) && el.readyState >= 2 && el.videoWidth > 0)
  if (onScreen) return (await grabFull(onScreen, { ic: null })).blob
  // last resort: a throw-away video. It MUST be released afterwards: on iOS a leftover video
  // that is still attached to the camera stream steals playback from the on-screen picture and turns it black.
  const v = document.createElement('video')
  v.muted = true; v.playsInline = true; v.setAttribute('playsinline', '')
  v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
  v.srcObject = new MediaStream([track]) // its own wrapper, so detaching it can't disturb the shared stream
  document.body.appendChild(v)
  try {
    await v.play()
    await new Promise((r) => setTimeout(r, 120))
    return (await grabFull(v, { ic: null })).blob
  } finally {
    v.pause(); v.srcObject = null; v.remove()
    // iOS can leave the on-screen camera frozen after this; the tile's self-check restarts it, and so do we
    document.querySelectorAll('video').forEach((el) => { if (el.srcObject && el.paused) void el.play().catch(() => undefined) })
  }
}

/** how long incoming text flashes over the call screen */
const FLASH_MS = 5_000

function hoursLeft(iso: string): string {
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return 'ended'
  const h = Math.floor(ms / 3_600_000)
  return h >= 1 ? `${h}h left` : `${Math.max(1, Math.round(ms / 60_000))}m left`
}

/** plays one remote person's voice. Hidden; if the browser blocks autoplay it starts on the next tap. */
function RemoteAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const a = ref.current
    if (!a) return
    a.srcObject = stream
    const start = () => { void a.play().catch(() => document.addEventListener('pointerdown', start, { once: true })) }
    start()
    return () => document.removeEventListener('pointerdown', start)
  }, [stream])
  return <audio ref={ref} autoPlay playsInline />
}

function Notice({ emoji, title, text, onHome }: { emoji: ReactNode; title: string; text?: string; onHome: () => void }) {
  return (
    <div className="safe-top flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="mb-3 text-5xl">{emoji}</div>
      <h1 className="text-xl font-semibold">{title}</h1>
      {text && <p className="mt-1 text-mute">{text}</p>}
      <button className="btn-primary mt-6" onClick={onHome}>Back home</button>
    </div>
  )
}

export function RoomPage() {
  const { code = '' } = useParams()
  const { user } = useAuth()
  const uid = user!.id
  const nav = useNavigate()
  const goBack = useGoBack()
  const toast = useToast()
  const myDeviceId = getDeviceId()
  const [roomId, setRoomId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [entry, setEntry] = useState<EnterResult | null>(null)
  const [sounds, setSounds] = useState(soundsOn)
  const [, bumpTheme] = useState(0)
  const wasWaiting = useRef(false)
  const prevMembers = useRef<number | null>(null)
  const prevRequests = useRef(0)
  const [menu, setMenu] = useState(false)
  const [chat, setChat] = useState(false)
  const [chatText, setChatText] = useState('')
  const [sending, setSending] = useState(false)
  const [flash, setFlash] = useState<{ text: string; from: string; key: number } | null>(null)
  const { setActive } = useActiveRoom()
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [facing, setFacing] = useState<'user' | 'environment'>('user')
  const isCall = new URLSearchParams(window.location.search).has('call')   // opened by calling / answering a friend
  const isParty = new URLSearchParams(window.location.search).has('party')   // a watch party room
  const [wantCamera, setWantCamera] = useState(isCall)
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [shareStream, setShareStream] = useState<MediaStream | null>(null)   // my shared screen (desktop browsers)
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const [wantMic, setWantMic] = useState(isCall || isParty)
  const [remotes, setRemotes] = useState<RemoteMedia[]>([])
  const [callState, setCallState] = useState('connecting…')
  const [peers, setPeers] = useState<PeerStatus[]>([])
  const rtcRef = useRef<RoomRtc | null>(null)
  const nameOf = useRef<(id: string) => string>(() => 'Someone')
  const autoScreen = useRef<string | null>(null)
  const chanRef = useRef<{ send: (event: string, payload: unknown) => Promise<void> } | null>(null)
  const [layout, setLayoutState] = useState<Layout>(() => { try { const v = localStorage.getItem('snapnote.layout'); return v === 'grid' || v === 'spotlight' ? v : 'auto' } catch { return 'auto' } })
  const setLayout = (l: Layout) => { setLayoutState(l); try { localStorage.setItem('snapnote.layout', l) } catch { /* ignore */ } }
  const [localPin, setLocalPin] = useState<string | null>(null)   // pinned just for me
  const [allPin, setAllPin] = useState<string | null>(null)       // pinned for everyone (by anyone in the call)
  const iPinnedAll = useRef<string | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncOn, setSyncOn] = useState(isParty)          // watch-together sync (on by default in a watch party)
  const syncIn = useRef<(m: SyncMsg) => void>(() => undefined)
  const streamRef = useRef<MediaStream | null>(null)
  const [zoomCaps, setZoomCaps] = useState<Record<string, { min: number; max: number }>>({})
  const [lensId, setLensId] = useState<string | null>(null)   // a specific rear camera chosen by the person (wide / main / tele)
  const [lenses, setLenses] = useState<string[]>([])   // how far each person's real camera zoom goes

  // Opening a room link: the host and invited people walk in; strangers wait until the host lets them in.
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending = false
    const run = async () => {
      try {
        const r = await enterRoom(code)
        if (!alive) return
        setEntry(r)
        pending = r.status === 'pending'
        wasWaiting.current = wasWaiting.current || pending
        if (r.status === 'member' && r.room_id) {
          if (wasWaiting.current) { playPing('welcome'); wasWaiting.current = false } // you were just let in
          setRoomId(r.room_id)
          notifyChanged()
        } else if (r.status === 'pending') timer = setTimeout(run, 2000) // keep asking until the host answers
      } catch (e) { if (alive) setError(friendlyError(e)) }
    }
    void run()
    return () => { alive = false; clearTimeout(timer); if (pending) void cancelJoin(code).catch(() => undefined) } // leaving the waiting room withdraws the request
  }, [code])

  // my camera. Stops when I turn it off, flip it, or leave this screen.
  useEffect(() => {
    if (!wantCamera) { setStream(null); return }
    let cancelled = false
    let current: MediaStream | null = null
    openCamera({ ...(lensId ? { deviceId: { exact: lensId } } : { facingMode: { ideal: facing } }), width: { ideal: 1920 }, height: { ideal: 1080 } })
      .then((s) => { if (cancelled) { s.getTracks().forEach((t) => t.stop()); return } current = s; setStream(s) })
      .catch((e: Error) => { if (!cancelled) { toast(e.message, 'error', { ms: 6000 }); setWantCamera(false) } })
    return () => { cancelled = true; current?.getTracks().forEach((t) => t.stop()) }
  }, [wantCamera, facing, lensId, toast])

  // which rear cameras does this phone have? (the names only appear once the camera has been allowed)
  useEffect(() => {
    if (!stream) return
    void navigator.mediaDevices.enumerateDevices().then((all) => {
      const cams = all.filter((d) => d.kind === 'videoinput')
      const side = cams.filter((d) => (facing === 'environment' ? /back|rear|environment/i : /front|user/i).test(d.label))
      setLenses((side.length ? side : cams).map((d) => d.deviceId))
    }).catch(() => undefined)
  }, [stream, facing])

  // my microphone (echo-cancelled). Off by default: nobody hears you until you unmute.
  useEffect(() => {
    if (!wantMic) { setMicStream(null); return }
    let cancelled = false
    let current: MediaStream | null = null
    openMic()
      .then((s) => { if (cancelled) { s.getTracks().forEach((t) => t.stop()); return } current = s; setMicStream(s); toast('Microphone on: people in the room can hear you', 'success') })
      .catch((e: Error) => { if (!cancelled) { toast(e.message, 'error', { ms: 6000 }); setWantMic(false) } })
    return () => { cancelled = true; current?.getTracks().forEach((t) => t.stop()) }
  }, [wantMic, toast])

  // Shared video + voice: peer-to-peer WebRTC between everyone in the room. Signalling goes over the room's private channel.
  useEffect(() => {
    if (!roomId) return
    const h: { rtc: RoomRtc | null } = { rtc: null }
    const chan = openChannel(`room:${roomId}`, {
      hello: (p) => h.rtc?.handle('hello', p),
      sig: (p) => h.rtc?.handle('sig', p),
      media: (p) => h.rtc?.handle('media', p),
      ping: (p) => h.rtc?.handle('ping', p),
      bye: (p) => h.rtc?.handle('bye', p),
      // someone asks MY camera to zoom (it stays sharp because the phone's own lens does it)
      zoomreq: (p) => {
        const m = p as { to?: string; from?: string; z?: number } | null
        if (!m || m.to !== uid || !m.from) return
        const track = streamRef.current?.getVideoTracks()[0]
        const cap = (track?.getCapabilities?.() as { zoom?: { min: number; max: number } } | undefined)?.zoom
        if (track && cap && cap.max > cap.min) {
          const z = Math.min(cap.max, Math.max(cap.min, Number(m.z) || 1))
          void track.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] }).catch(() => undefined)
          void chanRef.current?.send('zoomack', { to: m.from, from: uid, min: cap.min, max: cap.max }).catch(() => undefined)
        } else void chanRef.current?.send('zoomack', { to: m.from, from: uid, min: 1, max: 1 }).catch(() => undefined)
      },
      zoomack: (p) => {
        const m = p as { to?: string; from?: string; min?: number; max?: number } | null
        if (m && m.to === uid && m.from) setZoomCaps((c) => ({ ...c, [m.from!]: { min: Math.min(1, Number(m.min) || 1), max: Math.max(1, Number(m.max) || 1) } }))
      },
      sync: (p) => { const m = p as SyncMsg | null; if (m && typeof m.from === 'string') syncIn.current(m) },
      pin: (p) => { const id = (p as { id?: unknown } | null)?.id; setAllPin(typeof id === 'string' ? id : null) },
    })
    chanRef.current = chan
    const rtc = new RoomRtc({
      userId: uid,
      transport: { send: (event, payload) => { void chan.send(event, payload).catch(() => undefined) } },
      onChange: setRemotes,
      onEvent: (e: PresenceEvent) => {
        if (!navigator.onLine) return // my own connection is down: don't report others
        const who = nameOf.current(e.userId)
        if (e.type === 'left') toast(`${who} left the call`)
        else if (e.type === 'dropped') toast(`${who} went offline`, 'info', { ms: 5000 })
        else if (e.type === 'back') toast(`${who} is back · was offline for ${formatDuration(e.offlineMs ?? 0)}`, 'success', { ms: 5000 })
      },
    })
    h.rtc = rtc
    rtcRef.current = rtc
    // when someone taps Snapshot on MY video, my phone takes a full-resolution still and sends it to them
    rtc.setStillProvider(async () => takeStill(streamRef.current))
    setCallState('connecting…')
    chan.ready.then(() => { setCallState('connected'); rtc.start() }).catch(async (e: Error) => {
      setCallState(`failed: ${e.message}`)
      // work out WHY, instead of showing a vague error
      let why = `Video & voice connection failed (${e.message}).`
      try {
        const ok = await rpc<{ room?: boolean }>('realtime_setup_ok')
        if (!ok.room) why = 'The database is missing the video-call rules. In Supabase open the SQL Editor and run supabase/video-update.sql.'
      } catch (err) {
        if (/could not find the function|realtime_setup_ok/i.test((err as Error).message))
          why = 'The database is out of date. In Supabase open the SQL Editor and run supabase/video-update.sql.'
      }
      toast(why, 'error', { ms: 12_000 })
    })
    const bye = () => rtc.stop()
    iPinnedAll.current = null
    const online = () => rtc.clearGone() // my connection is back: nobody is blamed for MY gap
    window.addEventListener('online', online)
    window.addEventListener('pagehide', bye)
    return () => { window.removeEventListener('pagehide', bye); window.removeEventListener('online', online); rtc.stop(); rtcRef.current = null; setRemotes([]); setTimeout(() => chan.stop(), 500) } // small delay so "bye" gets out
  }, [roomId, uid, toast])

  // live connection read-out while Room details is open
  useEffect(() => {
    if (!menu) return
    const tick = () => setPeers(rtcRef.current?.status() ?? [])
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [menu])

  // my camera and mic → everyone (replaceTrack, no renegotiation)
  // what I send as video: my screen while presenting, otherwise my camera
  const outgoing = shareStream ?? stream
  useEffect(() => { streamRef.current = outgoing }, [outgoing])
  useEffect(() => { rtcRef.current?.setLocalVideo(outgoing, !!shareStream) }, [outgoing, shareStream, roomId])
  // leaving the call ends the share
  useEffect(() => () => { shareStream?.getTracks().forEach((t) => t.stop()) }, [shareStream])
  // what I send as sound: my microphone, plus the sound of the shared tab / computer when presenting (mixed into one track)
  useEffect(() => {
    const shareAudio = shareStream && shareStream.getAudioTracks().length ? new MediaStream(shareStream.getAudioTracks()) : null
    if (!shareAudio) { rtcRef.current?.setLocalAudio(micStream); return }
    if (!micStream) { rtcRef.current?.setLocalAudio(shareAudio, true); return }
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    ctx.createMediaStreamSource(micStream).connect(dest)
    ctx.createMediaStreamSource(shareAudio).connect(dest)
    rtcRef.current?.setLocalAudio(dest.stream, true)
    return () => { void ctx.close() }
  }, [micStream, shareStream, roomId])

  const data = useRoom(roomId ?? undefined)
  const loadedRoom = data?.room ?? null
  useEffect(() => {
    if (loadedRoom) setActive({ id: loadedRoom.id, code: loadedRoom.code, name: loadedRoom.name })
  }, [loadedRoom, setActive])
  useEffect(() => {
    if (error || (data && !data.room)) setActive(null)
  }, [error, data, setActive])

  // Joining a room turns this screen "on" for text: no separate switch to find (it can be turned off in Room details).
  const myScreenOn = !!data?.roomDevices.some((d) => d.device_id === myDeviceId)
  useEffect(() => {
    if (!roomId || !loadedRoom || myScreenOn || autoScreen.current === roomId) return
    autoScreen.current = roomId
    const on = () => setRoomDevice(roomId, myDeviceId, true).then(() => notifyChanged())
    on().catch(() => setTimeout(() => void on().catch(() => undefined), 1500)) // the device row may not exist yet on a first visit
  }, [roomId, loadedRoom, myScreenOn, myDeviceId])

  // While this device is on screen in the room, incoming text flashes over the call screen.
  useEffect(() => {
    if (!myScreenOn) { setFlash(null); return }
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    const w = watchMessages(myDeviceId, (m) => {
      if (m.type === 'clear') { clearTimeout(hideTimer); setFlash(null); return }
      if (m.type !== 'text' || !m.body.trim()) return
      if (Date.now() - Date.parse(m.created_at) > 15_000) return // ignore history replayed on (re)connect
      clearTimeout(hideTimer)
      playPing('message')
      setFlash((p) => ({ text: m.body, from: m.from_name, key: (p?.key ?? 0) + 1 }))
      hideTimer = setTimeout(() => setFlash(null), FLASH_MS)
    })
    return () => { clearTimeout(hideTimer); w.stop() }
  }, [myScreenOn, myDeviceId])

  useWakeLock(!!roomId && !!loadedRoom) // the screen must not sleep during a call
  const isHostNow = !!loadedRoom && loadedRoom.host_id === uid
  const requests = useJoinRequests(roomId ?? undefined, isHostNow)
  const presentIds = [...new Set(remotes.map((r) => r.userId))].filter((id) => id !== uid)
  const watch = useWatchSync({
    uid, enabled: syncOn,
    send: (m) => { void chanRef.current?.send('sync', m).catch(() => undefined) },
    toast: (msg) => toast(msg, 'info', { ms: 1100 }),
  })
  useEffect(() => { syncIn.current = watch.incoming }, [watch.incoming])
  const profiles = useProfiles([uid, ...presentIds, ...(requests ?? []).map((r) => r.user_id)])
  // someone starts presenting → their screen becomes the big tile (unless I pinned somebody myself); it lets go when they stop
  const presenterId = remotes.find((r) => r.screen)?.userId ?? null
  const autoPinned = useRef<string | null>(null)
  useEffect(() => {
    if (presenterId && !localPin) { autoPinned.current = presenterId; setLocalPin(presenterId) }
    else if (!presenterId && autoPinned.current) { setLocalPin((p) => (p === autoPinned.current ? null : p)); autoPinned.current = null }
  }, [presenterId]) // eslint-disable-line react-hooks/exhaustive-deps
  const pinnedLocalOk = localPin && (localPin === uid || presentIds.includes(localPin)) ? localPin : null
  const pinnedAllOk = allPin && (allPin === uid || presentIds.includes(allPin)) ? allPin : null
  const pinId = pinnedLocalOk ?? pinnedAllOk
  const onPin = (id: string | null, scope: 'me' | 'all') => {
    if (scope === 'me') { setLocalPin(id); if (id === null && pinnedAllOk) setAllPin(null) ; return }
    iPinnedAll.current = id
    setAllPin(id); setLocalPin(null)
    void chanRef.current?.send('pin', { id }).catch(() => undefined)
  }
  useEffect(() => { nameOf.current = (id) => profiles.get(id)?.display_name ?? 'Someone' })

  // the host should know when the waiting room can't work yet (database update not run)
  const warnedLegacy = useRef(false)
  useEffect(() => {
    if (!entry?.legacy || !isHostNow || warnedLegacy.current) return
    warnedLegacy.current = true
    toast('Waiting room is not active yet: run supabase/update-waiting-room-avatars.sql in the Supabase SQL Editor.', 'error', { ms: 12_000 })
  }, [entry, isHostNow, toast])

  // pings: someone is asking to join (host), someone joined (everyone)
  const waitingCount = requests?.length ?? 0
  useEffect(() => {
    if (waitingCount > prevRequests.current) playPing('request')
    prevRequests.current = waitingCount
  }, [waitingCount])
  const presentCount = presentIds.length
  useEffect(() => {
    if (prevMembers.current !== null && presentCount > prevMembers.current) playPing('join')
    prevMembers.current = presentCount
    if (iPinnedAll.current) void chanRef.current?.send('pin', { id: iPinnedAll.current }).catch(() => undefined)
  }, [presentCount])
  const link = roomLink(code.toLowerCase())

  if (!roomId && entry?.status === 'pending') {
    return (
      <CallScope>
        <div className="safe-top flex h-full flex-col items-center justify-center px-8 text-center">
          <div className="relative mb-7 flex h-28 w-28 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-[#7c5cff]/20" />
            <span className="absolute inset-3 animate-pulse rounded-full bg-[#ff7ac6]/25" />
            <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-white text-3xl shadow-soft">🚪</span>
          </div>
          <div className="mb-5 w-full max-w-[260px]">
            <div className="relative mx-auto aspect-[3/4] w-full overflow-hidden rounded-[28px] bg-white/70 shadow-soft">
              {stream
                ? <StreamVideo stream={stream} mirror={facing === 'user'} />
                : <div className="flex h-full flex-col items-center justify-center gap-2 text-mute"><Avatar name={profiles.get(uid)?.display_name ?? '?'} color={profiles.get(uid)?.avatar_color ?? '#7c5cff'} url={profiles.get(uid)?.avatar_url} size={84} /><span className="text-[13px]">Camera is off</span></div>}
            </div>
            <div className="mt-3 flex justify-center gap-3">
              <button aria-label={wantMic ? 'Mute microphone' : 'Unmute microphone'} onClick={() => setWantMic((v) => !v)} className={`flex h-12 w-12 items-center justify-center rounded-full shadow-soft transition active:scale-90 ${wantMic ? 'bg-[#cfe9d6]' : 'bg-white'}`}>{wantMic ? '🎙️' : '🔇'}</button>
              <button aria-label={wantCamera ? 'Turn camera off' : 'Turn camera on'} onClick={() => setWantCamera((v) => !v)} className={`flex h-12 w-12 items-center justify-center rounded-full shadow-soft transition active:scale-90 ${wantCamera ? 'bg-[#cfe9d6]' : 'bg-white'}`}>{wantCamera ? '📷' : '🚫'}</button>
              {wantCamera && <button aria-label="Flip camera" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))} className="flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-soft transition active:scale-90">🔄</button>}
            </div>
            <p className="mt-2 text-[12px] text-mute">Check how you look — this is only visible to you until you're let in.</p>
          </div>
          <h1 className="text-[22px] font-semibold">Waiting to be let in…</h1>
          <p className="mt-1.5 max-w-xs text-[14px] text-mute">
            {entry.host_name ? <><b className="text-ink">{entry.host_name}</b> will see your request.</> : 'The host will see your request.'}
            {entry.name ? <> You'll join <b className="text-ink">{entry.name}</b> as soon as they accept.</> : null}
          </p>
          <button className="btn-ghost mt-7" onClick={() => { void cancelJoin(code).catch(() => undefined); goBack('/') }}>Cancel</button>
        </div>
      </CallScope>
    )
  }
  if (!roomId && entry?.status === 'denied') return <CallScope><Notice emoji="✋" title="The host didn't let you in" text={entry.name ? `Your request to join ${entry.name} was declined.` : undefined} onHome={() => nav('/', { replace: true })} /></CallScope>
  if (error) return <CallScope><Notice emoji="🚪" title="Can't open this room" text={error} onHome={() => nav('/', { replace: true })} /></CallScope>
  if (!roomId || !data) {
    return (
      <CallScope>
        <div className="safe-top px-5 pt-6">
          <Skeleton className="mb-4 h-12 w-2/3" /><Skeleton className="mb-3 aspect-square w-full !rounded-[30px]" />
          <div className="grid grid-cols-2 gap-3"><Skeleton className="aspect-[1/1.06] !rounded-[26px]" /><Skeleton className="aspect-[1/1.06] !rounded-[26px]" /></div>
        </div>
      </CallScope>
    )
  }
  if (!data.room) return <CallScope><Notice emoji="👋" title="This room has ended" onHome={() => nav('/', { replace: true })} /></CallScope>

  const room = data.room
  const isHost = room.host_id === uid

  const screenBy = new Set<string>()
  remotes.forEach((r) => { if (r.screen) screenBy.add(r.userId) })
  const videoByUser = new Map<string, MediaStream>()
  const audioByUser = new Map<string, MediaStream>()
  remotes.forEach((r) => { if (r.video) videoByUser.set(r.userId, r.video); if (r.audio) audioByUser.set(r.userId, r.audio) })
  // Only people who are in the call right now (live, from the connection), not everyone who ever joined the room.
  const tiles: RoomTile[] = [uid, ...presentIds].map((id) => ({
    id,
    name: profiles.get(id)?.display_name ?? '…',
    color: profiles.get(id)?.avatar_color ?? '#7c5cff',
    avatarUrl: profiles.get(id)?.avatar_url,
    isMe: id === uid,
    stream: id === uid ? outgoing : videoByUser.get(id) ?? null,
    screen: id === uid ? !!shareStream : screenBy.has(id),
    audio: id === uid ? micStream : audioByUser.get(id) ?? null,
  }))

  const toggleShare = async () => {
    if (shareStream) { shareStream.getTracks().forEach((t) => t.stop()); setShareStream(null); return }
    try {
      // sound too: "Share tab audio" (a browser tab) or the whole computer's sound. Raw quality: no voice filtering on a movie.
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, width: { ideal: 1920 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
        systemAudio: 'include', surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions)
      s.getVideoTracks()[0].addEventListener('ended', () => setShareStream(null)) // the browser's own "Stop sharing" button
      setShareStream(s)
      if (s.getAudioTracks().length) toast('Everyone can see and hear your screen now', 'success')
      else toast('Sharing the picture only. For sound, share again and tick "Share tab audio" (or share the entire screen).', 'info', { ms: 9000 })
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') toast("Couldn't share the screen", 'error')
    }
  }

  const decide = async (userId: string, admit: boolean) => {
    try { await (admit ? admitRequest(room.id, userId) : denyRequest(room.id, userId)); notifyChanged() }
    catch (e) { toast(friendlyError(e), 'error') }
  }
  const toggleApproval = async () => {
    try { await setRoomApproval(room.id, !room.require_approval); notifyChanged(); toast(room.require_approval ? 'Anyone with the link can join now' : 'People now wait for you to let them in', 'success') }
    catch (e) { toast(friendlyError(e), 'error') }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); toast('Room link copied', 'success') } catch { toast('Copy failed', 'error') }
  }
  const share = async () => {
    if (navigator.share) { try { await navigator.share({ title: room.name, text: `Join my Snapnote room: ${room.code}`, url: link }) } catch { /* cancelled */ } }
    else await copy()
  }
  const setScreen = async (on: boolean) => {
    try { await setRoomDevice(room.id, myDeviceId, on); notifyChanged() } catch (e) { toast(friendlyError(e), 'error'); throw e }
  }
  const toggleScreen = async () => {
    try { await setScreen(!myScreenOn); toast(!myScreenOn ? 'Texts will show on this screen' : 'Texts won\'t show on this screen', 'success') } catch { /* toasted */ }
  }
  const openDisplay = async () => {
    try { if (!myScreenOn) await setScreen(true); nav('/display') } catch { /* toasted */ }
  }
  const leave = async () => {
    if (!confirm(isHost ? 'End this room for everyone?' : 'Leave this room?')) return
    try { await leaveRoom(room.id); setActive(null); notifyChanged(); goBack('/') } catch (e) { toast(friendlyError(e), 'error') }
  }

  // "text everyone": the same text goes to every on-screen device in the room (server enforces permission + 5 msgs/s)
  const targets = data.roomDevices
  const sendAll = async (type: 'text' | 'clear') => {
    if (!targets.length) { toast('No screen is on in this room yet', 'error'); return }
    if (type === 'text' && !chatText.trim()) return
    setSending(true)
    let failed = 0
    for (let i = 0; i < targets.length; i++) {
      try { await sendMessage({ fromDeviceId: myDeviceId, toUid: targets[i].user_id, toDeviceId: targets[i].device_id, type, body: type === 'text' ? chatText : '' }) }
      catch { failed++ }
      if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 230)) // stay under the 5/s limit
    }
    setSending(false)
    if (failed === targets.length) toast('Could not send — check your connection', 'error')
    else {
      toast(type === 'text' ? `Sent to ${targets.length - failed} screen${targets.length - failed === 1 ? '' : 's'}` : 'Screens cleared', 'success')
      if (type === 'text') setChatText('')
    }
  }

  return (
    <CallScope>
      {isHost && waitingCount > 0 && (
        <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+72px)] z-[56] flex flex-col items-center gap-2 px-4">
          {(requests ?? []).slice(0, 3).map((r) => {
            const p = profiles.get(r.user_id)
            return (
              <div key={r.user_id} className="rise pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[22px] bg-white p-2.5 pl-3 shadow-glass">
                <Avatar name={p?.display_name ?? '?'} color={p?.avatar_color ?? '#7c5cff'} url={p?.avatar_url} size={40} />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-[15px] font-semibold">{p?.display_name ?? 'Someone'}</div>
                  <div className="text-[12px] text-mute">wants to join</div>
                </div>
                <button className="btn-ghost !px-4 !py-2 text-[13px]" onClick={() => void decide(r.user_id, false)}>Deny</button>
                <button className="btn-primary !px-4 !py-2 text-[13px]" onClick={() => void decide(r.user_id, true)}>Admit</button>
              </div>
            )
          })}
          {waitingCount > 3 && <div className="pointer-events-auto rounded-full bg-white px-3 py-1 text-[12px] text-mute shadow-soft">+{waitingCount - 3} more waiting</div>}
        </div>
      )}
      {remotes.filter((r) => r.audio).map((r) => <RemoteAudio key={r.peerId} stream={r.audio!} />)}
      {flash && (
        <div className="fixed inset-0 z-[55] bg-black/55 backdrop-blur-[2px]" onClick={() => setFlash(null)} role="alert">
          <TextOverlay text={flash.text} from={flash.from} msgKey={flash.key} />
          <div className="safe-bottom pointer-events-none absolute inset-x-0 bottom-6 text-center text-[12px] text-white/60">Tap to dismiss</div>
        </div>
      )}
      <CallScreen
        name={room.name} code={room.code} link={link} expires={hoursLeft(room.expires_at)}
        tiles={tiles} isHost={isHost} facing={facing} hideInvite={isCall}
        sharing={!!shareStream} onToggleShare={canShare ? toggleShare : undefined} party={isParty} someonePresenting={!!presenterId} onSync={() => setSyncOpen(true)}
        layout={layout} onLayout={setLayout} pinId={pinId} pinScope={pinnedLocalOk ? 'me' : pinnedAllOk ? 'all' : null} onPin={onPin}
        onToggleMic={() => { if (wantMic) toast('Microphone muted'); setWantMic((v) => !v) }} onToggleCamera={() => setWantCamera((v) => !v)} onFlip={() => { setLensId(null); setFacing((f) => (f === 'user' ? 'environment' : 'user')) }}
        lensCount={lenses.length} lensIndex={Math.max(0, lenses.indexOf(lensId ?? stream?.getVideoTracks()[0]?.getSettings().deviceId ?? ''))} onLens={() => { const i = lenses.indexOf(lensId ?? stream?.getVideoTracks()[0]?.getSettings().deviceId ?? ''); setLensId(lenses[(i + 1) % lenses.length] ?? null) }}
        onMinimize={() => goBack('/')} onMore={() => setMenu(true)} onCopy={copy} onShare={share} onChat={() => setChat(true)}
        onSnapshot={(video, who, view, id) => {
          const rtc = rtcRef.current
          // my own camera: take the still right here; someone else's: ask their phone over the side channel
          const hd = id === uid ? (streamRef.current ? takeStill(streamRef.current) : null) : rtc?.canRequestStill(id) ? rtc.requestStill(id) : null
          snapshotToClipboard(video, who, toast, view, hd)
        }}
        zoomCaps={zoomCaps} onRemoteZoom={(id, z) => { void chanRef.current?.send('zoomreq', { to: id, from: uid, z }).catch(() => undefined) }} onLeave={leave}
      />
      <Sheet open={chat} onClose={() => setChat(false)} title="Text everyone">
        <p className="mb-3 text-[13px] text-mute">
          {targets.length === 0
            ? 'No screen is on in this room yet.'
            : `Shows on ${targets.length} screen${targets.length === 1 ? '' : 's'} in this room${myScreenOn ? ' (including this one)' : ''}.`}
        </p>
        <textarea className="field min-h-[7rem] w-full resize-none !rounded-3xl" maxLength={500} placeholder="Type something…" value={chatText} autoFocus
          onChange={(e) => setChatText(e.target.value)} />
        <div className="mt-1 text-right text-[11px] text-mute">{chatText.length}/500</div>
        <div className="mt-3 flex gap-2">
          <button className="btn-ghost flex-1" disabled={sending || targets.length === 0} onClick={() => void sendAll('clear')}>Clear screens</button>
          <button className="btn-primary flex-1" disabled={sending || targets.length === 0 || !chatText.trim()} onClick={() => void sendAll('text')}>{sending ? 'Sending…' : 'Send'}</button>
        </div>
      </Sheet>
      <Sheet open={syncOpen} onClose={() => setSyncOpen(false)} title="Watch together">
        <p className="mb-3 text-[13px] text-mute">Everyone plays the same Netflix / YouTube / Prime title on their own account. Snapnote keeps pause, play and seeking in sync, so there is no streaming delay and the quality is the service's own.</p>
        <div className="space-y-2 rounded-2xl bg-card2 px-4 py-3 text-[13px]">
          <div className="flex items-center justify-between gap-3"><span>Snapnote Sync extension</span><b className={watch.extension ? 'text-[#2f9e4f]' : 'text-danger'}>{watch.extension ? 'Installed ✓' : 'Not installed'}</b></div>
          <div className="flex items-center justify-between gap-3"><span>Video tab</span><b className={watch.player.found ? 'text-[#2f9e4f]' : 'text-mute'}>{watch.player.found ? `${watch.player.host?.replace(/^www\./, '')}${watch.player.playing ? ' · playing' : ' · paused'}` : 'Not found'}</b></div>
          <div className="flex items-center justify-between gap-3"><span>Sync with the room</span>
            <button className={`rounded-full px-3 py-1 text-[12px] font-semibold ${syncOn ? 'bg-ink text-white' : 'bg-white'}`} onClick={() => setSyncOn((v) => !v)}>{syncOn ? 'On' : 'Off'}</button></div>
        </div>
        {!watch.extension ? (
          <div className="mt-3 rounded-2xl bg-card2 px-4 py-3 text-[13px]">
            <div className="mb-1 font-semibold">Install it once (computer, Chrome or Edge)</div>
            <ol className="list-decimal space-y-1 pl-5 text-mute">
              <li>Download the zip below and unzip it.</li>
              <li>Open <b>chrome://extensions</b>, turn on <b>Developer mode</b>.</li>
              <li>Click <b>Load unpacked</b> and choose the unzipped folder.</li>
              <li>Come back here and reload this page.</li>
            </ol>
            <a href="/snapnote-sync.zip" download className="btn-primary mt-3 w-full">Download the extension</a>
          </div>
        ) : !watch.player.found ? (
          <p className="mt-3 rounded-2xl bg-card2 px-4 py-3 text-[13px] text-mute">Open Netflix (or YouTube, Prime Video, Disney+ Hotstar…) in another tab and start the same title as your friends. This panel will say "found".</p>
        ) : (
          <div className="mt-3 space-y-2">
            <button className="btn-primary w-full" disabled={!syncOn} onClick={() => watch.startTogether()}>Start together (3-2-1)</button>
            <button className="btn-ghost w-full" disabled={!syncOn} onClick={() => watch.resync()}>Jump everyone to my moment</button>
          </div>
        )}
        <p className="mt-3 text-[12px] text-mute">Tip: use the same episode, then hit “Start together”. Anyone can pause or seek and it follows for everyone.</p>
      </Sheet>
      <Sheet open={menu} onClose={() => setMenu(false)} title="Room details">
        <div className="flex flex-col items-center">
          <div className="text-[12px] font-medium uppercase tracking-[0.14em] text-mute">Room code</div>
          <div className="mt-1 text-[28px] font-semibold tracking-tight">{room.code}</div>
          <div className="mt-3 rounded-2xl bg-white p-2.5 shadow-soft"><QRCodeSVG value={link} size={132} /></div>
          <div className="mt-3 max-w-full truncate text-[13px] text-mute">{link.replace(/^https?:\/\//, '')}</div>
        </div>
        <div className="mt-4 rounded-2xl bg-card2 px-4 py-3 text-[13px]">
          <div className="mb-1 font-semibold">Connection <span className="font-normal text-mute">(for troubleshooting)</span></div>
          <div className="text-mute">Room channel: <b className={callState === 'connected' ? 'text-[#2f9e4f]' : 'text-danger'}>{callState}</b></div>
          {peers.length === 0
            ? <div className="text-mute">Nobody else is connected yet{data.members.length > 1 ? ' — they may still be connecting.' : '.'}</div>
            : peers.map((p, i) => (
              <div key={i} className="text-mute">
                <b className="text-ink">{profiles.get(p.userId)?.display_name ?? p.userId.slice(0, 6)}</b>: {p.connection}
                {' · '}video {p.videoOn ? (p.videoFlowing ? 'flowing' : 'announced, not arriving') : 'off'}
                {' · '}mic {p.audioOn ? (p.audioFlowing ? 'flowing' : 'announced, not arriving') : 'off'}
              </div>
            ))}
        </div>
        <div className="mt-3 space-y-2">
          <button className="btn-ghost w-full" onClick={() => { setMenu(false); void copy() }}>Copy room link</button>
          <button className="btn-ghost w-full" onClick={() => { setMenu(false); void share() }}>Share…</button>
          {isHost && entry?.legacy && (
            <div className="rounded-2xl bg-danger/10 px-4 py-3 text-[13px] text-danger">Waiting room is off because the database update hasn't been run. Run <b>supabase/update-waiting-room-avatars.sql</b> in the Supabase SQL Editor.</div>
          )}
          {isHost && room.require_approval !== undefined && (
            <button className="btn-ghost w-full" onClick={() => void toggleApproval()}>{room.require_approval ? 'Waiting room: ON (tap to let anyone in)' : 'Waiting room: OFF (tap to ask people to wait)'}</button>
          )}
          <button className="btn-ghost w-full" onClick={() => { setMenu(false); setSyncOpen(true) }}>Watch together (sync Netflix)</button>
          <button className="btn-ghost w-full" onClick={() => { const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark'; setTheme(next); applyTheme(next); bumpTheme((n) => n + 1) }}>{document.documentElement.classList.contains('dark') ? 'Switch to light theme' : 'Switch to dark theme'}</button>
          <button className="btn-ghost w-full" onClick={() => { setSoundsOn(!sounds); setSounds(!sounds); if (!sounds) playPing('join') }}>{sounds ? 'Ping sounds: ON' : 'Ping sounds: OFF'}</button>
          <button className="btn-ghost w-full" onClick={() => { setMenu(false); void toggleScreen() }}>{myScreenOn ? 'Stop showing texts on this screen' : 'Show texts on this screen'}</button>
          <button className="btn-ghost w-full" onClick={() => { setMenu(false); void openDisplay() }}>Open display mode</button>
          <button className="btn-danger w-full" onClick={() => { setMenu(false); void leave() }}>{isHost ? 'End room for everyone' : 'Leave room'}</button>
        </div>
      </Sheet>
    </CallScope>
  )
}
