// THE CALL / SESSION SCREEN – simplified (approved redesign): tiles with live video, tap a tile to maximise it,
// four buttons at the bottom (mic · camera · message · leave), room details in the top-right menu.
// Pure view: all logic (WebRTC, snapshot, sending) comes in through props. Its look is pinned by call-scope.css.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Avatar, Icon, RoundBtn, Sheet, type IconName } from './primitives'
import { useBackToClose } from '../../lib/nav'
import { useSpeaking } from '../../lib/speaking'
import { useMediaQuery } from '../../lib/media'

export interface RoomTile {
  id: string
  name: string
  color: string
  /** the person's Google profile picture (shown instead of the initial when their camera is off) */
  avatarUrl?: string | null
  isMe: boolean
  /** this person's live camera (null = camera off). For "me" it is my own camera. */
  stream: MediaStream | null
  /** the video is a shared screen (shown whole, not cropped, and never mirrored) */
  screen?: boolean
  /** this person's microphone while they are unmuted (null = muted). Only used to show who is speaking. */
  audio: MediaStream | null
}

export interface RoomViewProps {
  name: string
  code: string
  link: string
  expires: string
  tiles: RoomTile[]
  isHost: boolean
  /** a call to a friend: no "share this link" card */
  hideInvite?: boolean
  facing: 'user' | 'environment'
  onToggleMic: () => void
  onToggleCamera: () => void
  /** screen sharing: undefined = this device can't share (phones); otherwise start / stop */
  onToggleShare?: () => void
  sharing?: boolean
  /** a watch party room: show the "start streaming" helper */
  party?: boolean
  /** someone (not me) is presenting right now */
  someonePresenting?: boolean
  /** open the "watch together" (sync playback) panel */
  onSync?: () => void
  onFlip: () => void
  onMinimize: () => void
  onMore: () => void
  onCopy: () => void
  onShare: () => void
  /** opens the "text everyone" sheet */
  onChat: () => void
  /** copy the current frame of the maximised video; called straight from the click so the clipboard is allowed */
  onSnapshot: (video: HTMLVideoElement, who: string, view: { rotate: number; zoom: number; panX: number; panY: number }, userId: string) => void
  /** ask someone else's phone to zoom its real camera (clear, not blurry); they answer with how far it can go (zoomCaps) */
  onRemoteZoom: (userId: string, zoom: number) => void
  /** how far each person's real camera zoom goes (1 = it can't) */
  zoomCaps: Record<string, { min: number; max: number }>
  /** my phone's rear cameras (wide / main / tele): how many, which one is on, and switch to the next */
  lensCount: number
  lensIndex: number
  onLens: () => void
  onLeave: () => void
  /** how the tiles are arranged: auto (Meet-style), everyone equal, or one big tile */
  layout: Layout
  onLayout: (l: Layout) => void
  /** the tile that is pinned (big) right now, and who decided that */
  pinId: string | null
  pinScope: 'me' | 'all' | null
  /** pin a person for just me / for everyone in the call, or unpin (id = null) */
  onPin: (id: string | null, scope: 'me' | 'all') => void
}

export type Layout = 'auto' | 'grid' | 'spotlight'

type VideoRef = { current: HTMLVideoElement | null }

/** a live camera filling its box (mine or a remote one) */
export function StreamVideo({ stream, mirror, contain, innerRef, box }: { stream: MediaStream; mirror: boolean; contain?: boolean; innerRef?: VideoRef; box?: CSSProperties }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    v.srcObject = stream
    void v.play().catch(() => undefined)
    // iPhone Safari freezes/blackens a video when tracks arrive late, the page was hidden, or another media element took over:
    // nudge it back to life whenever that happens.
    const revive = () => {
      if (document.visibilityState === 'hidden') return
      const live = stream.getVideoTracks().some((t) => t.readyState === 'live')
      if (!live) return
      if (v.paused) void v.play().catch(() => undefined)
    }
    stream.addEventListener('addtrack', revive)
    const tracks = stream.getVideoTracks()
    tracks.forEach((t) => t.addEventListener('unmute', revive))
    v.addEventListener('pause', revive)
    document.addEventListener('visibilitychange', revive)
    window.addEventListener('pageshow', revive)
    const timer = setInterval(revive, 3000)
    return () => {
      stream.removeEventListener('addtrack', revive)
      tracks.forEach((t) => t.removeEventListener('unmute', revive))
      v.removeEventListener('pause', revive)
        document.removeEventListener('visibilitychange', revive)
      window.removeEventListener('pageshow', revive)
      clearInterval(timer)
    }
  }, [stream])
  return (
    <video ref={(el) => { ref.current = el; if (innerRef) innerRef.current = el }} autoPlay muted playsInline
      style={box} className={`${box ? 'absolute left-1/2 top-1/2' : 'absolute inset-0 h-full w-full'} ${contain ? 'object-contain' : 'object-cover'} ${mirror && !box ? '-scale-x-100' : ''}`} />
  )
}

export function RoomView(p: RoomViewProps) {
  const [inviteOpen, setInviteOpen] = useState(true)
  const [partyOpen, setPartyOpen] = useState(true)
  const [maxId, setMaxId] = useState<string | null>(null)
  const maxVideo = useRef<HTMLVideoElement | null>(null)
  const [view, setView] = useState<Record<string, { rot: number; zoom: number; px: number; py: number }>>({}) // per person: how I'm looking at them
  const [zoomOpen, setZoomOpen] = useState(false)                                  // the zoom panel is tucked away until you want it
  const [hwZoom, setHwZoom] = useState<{ min: number; max: number } | null>(null)    // the real camera's own zoom range (my camera only)
  const me = p.tiles.find((t) => t.isMe)
  const cameraOn = !!me?.stream
  const micOn = !!me?.audio
  const maxTile = p.tiles.find((t) => t.id === maxId) ?? null
  useBackToClose(!!maxTile, () => setMaxId(null)) // Back closes the maximised view
  const v = (maxTile && view[maxTile.id]) || { rot: 0, zoom: 1, px: 0, py: 0 }
  const setV = (patch: Partial<{ rot: number; zoom: number; px: number; py: number }>) => { if (maxTile) setView((m) => ({ ...m, [maxTile.id]: { ...v, ...patch } })) }
  // my own camera may have a real zoom (phones with 1x / 2x / 5x lenses); use it when it exists
  useEffect(() => {
    setHwZoom(null)
    const track = maxTile?.isMe ? maxTile.stream?.getVideoTracks()[0] : undefined
    const z = (track?.getCapabilities?.() as { zoom?: { min: number; max: number } } | undefined)?.zoom
    if (z && z.max > z.min) setHwZoom({ min: z.min, max: z.max })
  }, [maxTile?.id, maxTile?.stream]) // eslint-disable-line react-hooks/exhaustive-deps
  // the camera's own zoom does the first part (sharp, like the phone's camera app); anything beyond it is a digital crop you can drag around
  const hwRange = !maxTile ? null : maxTile.isMe ? hwZoom : p.zoomCaps[maxTile.id] ?? null
  const hwMin = hwRange?.min ?? 1, hwMax = hwRange?.max ?? 1
  const lowest = Math.min(1, hwMin)                             // zoom OUT is possible when the camera allows it (e.g. 0.5x wide angle)
  const hwNow = Math.min(hwMax, Math.max(hwMin, v.zoom))
  const digitalZoom = Math.max(1, v.zoom / hwNow)
  const sideways = v.rot % 180 !== 0
  const setZoom = (raw: number) => {
    if (!maxTile) return
    const z = Math.round(Math.min(8, Math.max(lowest, raw)) * 10) / 10
    if (maxTile.isMe && hwZoom) {
      const c = Math.min(hwZoom.max, Math.max(hwZoom.min, z))
      void maxTile.stream?.getVideoTracks()[0]?.applyConstraints({ advanced: [{ zoom: c } as MediaTrackConstraintSet] }).catch(() => undefined)
    } else if (!maxTile.isMe) p.onRemoteZoom(maxTile.id, z)
    setV({ zoom: z, px: 0, py: 0 })
  }
  /** size of the picture as it appears on screen (it is letter-boxed), to keep panning inside it */
  const shown = () => {
    const vw = maxVideo.current?.videoWidth || 16, vh = maxVideo.current?.videoHeight || 9
    const ar = sideways ? vh / vw : vw / vh
    const W = Math.min(window.innerWidth, window.innerHeight * ar)
    return { W, H: W / ar }
  }
  const dragPan = (e: React.PointerEvent) => {
    if (digitalZoom <= 1.001 || (e.target as HTMLElement).closest('button, input')) return
    let lx = e.clientX, ly = e.clientY, cur = { px: v.px, py: v.py }
    const { W, H } = shown()
    const mx = ((digitalZoom - 1) * W) / 2, my = ((digitalZoom - 1) * H) / 2
    const move = (ev: PointerEvent) => {
      cur = { px: Math.min(mx, Math.max(-mx, cur.px + ev.clientX - lx)), py: Math.min(my, Math.max(-my, cur.py + ev.clientY - ly)) }
      lx = ev.clientX; ly = ev.clientY
      setV(cur)
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const n = p.tiles.length
  const wide = useMediaQuery('(min-width: 768px)')
  // phones: 1 → one big tile, 2 → stacked, 3 → wide + 2, 4+ → 2 columns
  // tablets / desktops: tiles sit side by side and fill the screen (1 → one, 2 → two, 3 → three, 4 → 2×2, 5–6 → 3×2, 7–8 → 4×2)
  const cols = wide ? (n <= 3 ? Math.max(1, n) : n === 4 ? 2 : n <= 6 ? 3 : 4) : n <= 2 ? 1 : 2
  const rows = wide ? Math.ceil(n / cols) : n <= 2 ? n : n === 3 ? 2 : Math.ceil(n / 2)
  const avatar = wide ? (n === 1 ? 190 : n <= 4 ? 140 : 100) : n === 1 ? 128 : n === 2 ? 104 : n <= 4 ? 84 : 64
  const alone = n <= 1
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [pinFor, setPinFor] = useState<string | null>(null)
  const [split, setSplit] = useState(0.28)            // share of the screen the small tiles get in spotlight
  const [pip, setPip] = useState({ w: 112, r: 0, b: 0 }) // the small floating tile in a two-person call
  const areaRef = useRef<HTMLDivElement | null>(null)
  const pinned = p.pinId ? p.tiles.find((t) => t.id === p.pinId) ?? null : null
  const others = p.tiles.filter((t) => !t.isMe)
  const main = n <= 1 ? null : pinned ?? (n === 2 && p.layout !== 'grid' ? others[0] : p.layout === 'spotlight' ? others[0] ?? null : null)
  const rest = main ? p.tiles.filter((t) => t.id !== main.id) : []
  const pipTile = main && n === 2 ? rest[0] : null
  const pinTile = pinFor ? p.tiles.find((t) => t.id === pinFor) ?? null : null
  const tileProps = (t: RoomTile, i: number, extra?: { compact?: boolean; cls?: string }) => ({
    t, i, n, wide, avatar: extra?.compact ? 56 : avatar, mirror: t.isMe && p.facing === 'user', compact: !!extra?.compact, cls: extra?.cls ?? '',
    pinned: p.pinId === t.id, onPin: () => setPinFor(t.id), onOpen: () => setMaxId(t.id), onToggleMic: p.onToggleMic,
  })

  /** drag the divider between the big tile and the small ones */
  const dragSplit = (e: React.PointerEvent) => {
    const box = areaRef.current?.getBoundingClientRect()
    if (!box) return
    const vertical = wide
    const move = (ev: PointerEvent) => {
      const f = vertical ? (box.right - ev.clientX) / box.width : (box.bottom - 112 - ev.clientY) / (box.height - 112)
      setSplit(Math.min(0.5, Math.max(0.16, f)))
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    e.preventDefault()
  }
  /** drag the floating tile around / resize it from its corner; a plain tap swaps it with the big one */
  const dragPip = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
    const box = areaRef.current?.getBoundingClientRect()
    if (!box) return
    e.stopPropagation()
    const sx = e.clientX, sy = e.clientY, start = pip
    let moved = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true
      if (mode === 'move') setPip({ ...start, r: Math.min(box.width - start.w - 20, Math.max(0, start.r - dx)), b: Math.min(box.height - 112 - start.w * 1.33 - 20, Math.max(-100, start.b - dy)) })
      else setPip({ ...start, w: Math.min(Math.min(box.width * 0.7, 420), Math.max(84, start.w - dx)) })
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (mode === 'move' && !moved && pipTile) p.onPin(pipTile.id, 'me') }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    e.preventDefault()
  }

  return (
    <div className="safe-top mx-auto flex h-full max-w-lg flex-col px-4 pt-3 md:max-w-3xl md:px-6 lg:max-w-6xl">
      {/* top bar */}
      <div className="mb-3 flex items-center gap-3">
        <RoundBtn icon="minimize" label="Minimize" onClick={p.onMinimize} />
        <div className="min-w-0 flex-1 text-center leading-tight">
          <h1 className="truncate text-[17px] font-semibold">{p.name}</h1>
          <p className="text-[13px] text-mute">{p.code} · {p.expires}</p>
        </div>
        {n > 1 && <RoundBtn icon="expand" label="Layout and pin" onClick={() => setLayoutOpen(true)} />}
        <RoundBtn icon="dots" label="Room details" onClick={p.onMore} />
      </div>

      {/* tiles – tap one to maximise it */}
      <div ref={areaRef} className="relative min-h-0 flex-1 pb-[112px]">
        {!main ? (
          <div className="grid h-full gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
            {p.tiles.map((t, i) => <TileButton key={t.id} {...tileProps(t, i, { cls: !wide && n === 3 && i === 0 ? 'col-span-2' : '' })} />)}
          </div>
        ) : pipTile ? (
          /* two people: the other person big, me small and movable (like WhatsApp / Meet) */
          <div className="relative h-full">
            <TileButton key={main.id} {...tileProps(main, 0, { cls: 'h-full w-full' })} />
            <div className="absolute z-20 touch-none select-none" style={{ right: pip.r + 10, bottom: pip.b + 10, width: pip.w, height: pip.w * 1.33 }}>
              <div onPointerDown={dragPip('move')} className="relative h-full w-full cursor-grab overflow-hidden rounded-[20px] shadow-glass ring-2 ring-white">
                <TileButton key={pipTile.id} {...tileProps(pipTile, 1, { compact: true, cls: 'h-full w-full pointer-events-none' })} />
              </div>
              <span onPointerDown={dragPip('size')} role="slider" aria-label="Resize small video" aria-valuenow={Math.round(pip.w)}
                className="absolute -left-2 -top-2 z-30 flex h-7 w-7 cursor-nwse-resize items-center justify-center rounded-full bg-white text-[11px] shadow-soft">⤡</span>
            </div>
          </div>
        ) : (
          /* three or more: one big tile, the rest in a strip you can resize by dragging the divider */
          <div className={`flex h-full ${wide ? 'flex-row' : 'flex-col'}`}>
            <div className="min-h-0 min-w-0 flex-1"><TileButton key={main.id} {...tileProps(main, 0, { cls: 'h-full w-full' })} /></div>
            <div onPointerDown={dragSplit} role="separator" aria-label="Drag to resize" className={`group flex shrink-0 touch-none items-center justify-center ${wide ? 'w-4 cursor-col-resize' : 'h-4 cursor-row-resize'}`}>
              <span className={`rounded-full bg-ink/25 transition group-hover:bg-ink/50 ${wide ? 'h-12 w-1' : 'h-1 w-12'}`} />
            </div>
            <div className={`flex shrink-0 gap-2.5 overflow-auto ${wide ? 'flex-col' : 'flex-row'}`} style={wide ? { width: `${split * 100}%` } : { height: `${split * 100}%` }}>
              {rest.map((t, i) => (
                <div key={t.id} className={wide ? 'min-h-[120px] flex-1' : 'h-full min-w-[110px] flex-1'}>
                  <TileButton {...tileProps(t, i + 1, { compact: true, cls: 'h-full w-full' })} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* maximised tile: full-screen video (or avatar if their camera is off) + Snapshot */}
      {maxTile && (
        <div className={`keep-light fixed inset-0 z-[60] touch-none bg-black ${digitalZoom > 1.001 ? 'cursor-grab' : ''}`} onPointerDown={dragPan}
          onWheel={(e) => setZoom(v.zoom - e.deltaY / 400)}>
          {maxTile.stream
            ? <StreamVideo stream={maxTile.stream} mirror={maxTile.isMe && p.facing === 'user' && !maxTile.screen} contain innerRef={maxVideo}
                box={{ width: sideways ? '100dvh' : '100vw', height: sideways ? '100vw' : '100dvh', transform: `translate(-50%,-50%) translate(${v.px}px,${v.py}px) rotate(${v.rot}deg) scale(${digitalZoom}) ${maxTile.isMe && p.facing === 'user' && !maxTile.screen ? 'scaleX(-1)' : ''}` }} />
            : (
              <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: `radial-gradient(80% 60% at 50% 40%, ${maxTile.color}66, #0b0c12 78%)` }}>
                <Avatar name={maxTile.name} color={maxTile.color} url={maxTile.avatarUrl} size={140} />
                <p className="mt-5 text-[14px] text-white/70">{maxTile.isMe ? 'Your camera is off' : 'Their camera is off'}</p>
              </div>
            )}
          <div className="safe-top absolute inset-x-0 top-0 flex items-center justify-between p-4">
            <button aria-label="Close" onClick={() => setMaxId(null)} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur"><Icon name="shrink" size={20} /></button>
            <span className="rounded-full bg-black/45 px-3.5 py-1.5 text-[13px] font-medium text-white backdrop-blur">{maxTile.isMe ? 'You' : maxTile.name}</span>
            <span className="flex gap-2">
              {maxTile.isMe && maxTile.stream && p.lensCount > 1 && <button aria-label="Switch lens" title="Switch lens (wide / main / tele)" onClick={p.onLens} className="flex h-11 items-center justify-center rounded-full bg-black/45 px-3.5 text-[13px] font-semibold text-white backdrop-blur">Lens {p.lensIndex + 1}/{p.lensCount}</button>}
              {maxTile.stream && <button aria-label="Rotate video" title="Rotate" onClick={() => setV({ rot: (v.rot + 90) % 360 })} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-[19px] text-white backdrop-blur">⟳</button>}
              {maxTile.isMe && maxTile.stream && <button aria-label="Flip camera" onClick={p.onFlip} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur"><Icon name="flip" size={20} /></button>}
            </span>
          </div>
          <div className="safe-bottom absolute inset-x-0 bottom-0 flex flex-col items-center gap-4 p-6">
            {maxTile.stream && !zoomOpen && (
              <button onClick={() => setZoomOpen(true)} aria-label="Show zoom" className="flex h-9 items-center gap-1.5 rounded-full bg-black/45 px-4 text-[13px] font-semibold text-white backdrop-blur">
                {v.zoom.toFixed(1)}× <span className="text-[10px] text-white/60">▲ zoom</span>
              </button>
            )}
            {maxTile.stream && zoomOpen && (
              <div className="flex w-full max-w-sm flex-col items-center gap-2 rounded-[22px] bg-black/55 p-2 backdrop-blur" role="group" aria-label="Zoom">
                <div className="flex w-full items-center justify-between gap-1">
                  <div className="flex gap-1">
                    {[0.5, 1, 2, 5].filter((z) => z >= lowest - 0.01).map((z) => (
                      <button key={z} onClick={() => setZoom(z)} aria-label={`${z}x zoom`}
                        className={`h-9 min-w-[42px] rounded-full px-2.5 text-[13px] font-semibold transition ${Math.abs(v.zoom - z) < 0.05 ? 'bg-white text-[#14161f]' : 'text-white'}`}>{z}×</button>
                    ))}
                  </div>
                  <span className="min-w-[44px] text-center text-[13px] font-semibold text-white/80">{v.zoom.toFixed(1)}×</span>
                  <button onClick={() => setZoomOpen(false)} aria-label="Hide zoom" className="flex h-9 w-9 items-center justify-center rounded-full text-[14px] text-white/80">▼</button>
                </div>
                <input type="range" min={lowest} max={8} step={0.1} value={v.zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom amount" className="h-2 w-full accent-white" />
                <span className="text-[11px] text-white/60">{hwNow !== 1 ? 'Using the real camera zoom · ' : ''}{digitalZoom > 1.001 ? 'drag the picture to move around' : lowest < 1 ? 'wide angle available: slide left to zoom out' : 'slide right to zoom in'}</span>
              </div>
            )}
            <button aria-label="Take snapshot" title={maxTile.stream ? 'Snapshot – copies the picture' : 'No picture to capture'} disabled={!maxTile.stream}
              onClick={() => { if (maxVideo.current) p.onSnapshot(maxVideo.current, maxTile.isMe ? 'You' : maxTile.name, { rotate: v.rot, zoom: digitalZoom, panX: v.px / shown().W, panY: v.py / shown().H }, maxTile.id) }}
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white/90 bg-white/15 text-white backdrop-blur transition active:scale-90 disabled:opacity-30">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-ink"><Icon name="camera" size={24} /></span>
            </button>
          </div>
        </div>
      )}

      {/* "Your room's ready" – only while you're alone, like Meet */}
      {/* watch party: how to start streaming */}
      {p.party && partyOpen && !p.sharing && !p.someonePresenting && (
        <div className="rise pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+104px)] z-30 flex justify-center px-4">
          <div className="pointer-events-auto w-full max-w-lg rounded-[24px] bg-white p-4 shadow-glass">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[16px] font-semibold">🍿 Watch party</div>
                <p className="mt-0.5 text-[13px] text-mute"><b>Netflix, Prime, Hotstar:</b> everyone plays it on their own account and Snapnote keeps you in sync (tap <b>Sync playback</b>). <b>Anything else:</b> one person streams their screen, with sound.</p>
              </div>
              <button aria-label="Dismiss" onClick={() => setPartyOpen(false)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink/5 text-[15px]">✕</button>
            </div>
            <p className="mt-2 rounded-2xl bg-card2 px-3 py-2 text-[12px] text-mute">Streaming a screen? Use headphones so the movie doesn't echo through the microphone. Netflix and Prime block screen capture (black picture), which is why they use Sync.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {p.onSync && <button onClick={p.onSync} className="flex items-center justify-center gap-2 rounded-full bg-ink py-3 text-[14px] font-semibold text-white transition active:scale-[.98]">▶ Sync playback</button>}
              {p.onToggleShare
                ? <button onClick={p.onToggleShare} className="flex items-center justify-center gap-2 rounded-full bg-card2 py-3 text-[14px] font-semibold transition active:scale-[.98]"><Icon name="screen" size={17} />Stream screen</button>
                : <div className="rounded-full bg-card2 px-3 py-3 text-center text-[12px] text-mute">Streaming: computers only</div>}
              <button onClick={p.onShare} className="col-span-2 flex items-center justify-center gap-2 rounded-full bg-card2 py-3 text-[14px] font-semibold transition active:scale-[.98]"><Icon name="link" size={17} />Invite friends</button>
            </div>
          </div>
        </div>
      )}

      {alone && inviteOpen && !p.hideInvite && !p.party && (
        <div className="rise pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+104px)] z-30 flex justify-center px-4">
          <div className="pointer-events-auto w-full max-w-lg rounded-[24px] bg-white p-4 shadow-glass">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[16px] font-semibold">Your room's ready</div>
                <p className="mt-0.5 text-[13px] text-mute">Share this link with people you want in the room. Up to 8 can join.</p>
              </div>
              <button aria-label="Dismiss" onClick={() => setInviteOpen(false)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink/5 text-[15px]">✕</button>
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-2xl bg-card2 py-1.5 pl-3.5 pr-1.5">
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{p.link.replace(/^https?:\/\//, '')}</span>
              <button aria-label="Copy link" onClick={p.onCopy} className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-soft transition active:scale-90"><Icon name="copy" size={18} /></button>
            </div>
            <button onClick={p.onShare} className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-full bg-ink py-3 text-[14px] font-semibold text-white transition active:scale-[.98]">
              <Icon name="link" size={17} />Share link
            </button>
          </div>
        </div>
      )}

      <Sheet open={layoutOpen} onClose={() => setLayoutOpen(false)} title="Layout">
        <div className="grid grid-cols-3 gap-2">
          {([['auto', 'Auto', 'Meet-style'], ['grid', 'Grid', 'Everyone equal'], ['spotlight', 'Spotlight', 'One big tile']] as const).map(([k, label, sub]) => (
            <button key={k} onClick={() => { p.onLayout(k); setLayoutOpen(false) }}
              className={`rounded-2xl px-2 py-3 text-center transition active:scale-95 ${p.layout === k ? 'bg-ink text-white' : 'bg-card2'}`}>
              <div className="text-[14px] font-semibold">{label}</div>
              <div className={`text-[11px] ${p.layout === k ? 'text-white/70' : 'text-mute'}`}>{sub}</div>
            </button>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-mute">Tip: drag the small video to move it, drag its corner to resize it, drag the divider to resize the strip. Tap the pin on anyone's tile to pin them.</p>
        {p.pinId && <button className="btn-ghost mt-3 w-full" onClick={() => { p.onPin(null, 'me'); setLayoutOpen(false) }}>{p.pinScope === 'all' ? 'Unpin (for me)' : 'Unpin'}</button>}
      </Sheet>
      <Sheet open={!!pinTile} onClose={() => setPinFor(null)} title={pinTile ? `Pin ${pinTile.isMe ? 'yourself' : pinTile.name}` : 'Pin'}>
        <div className="space-y-2">
          <button className="btn-primary w-full" onClick={() => { p.onPin(pinFor, 'me'); setPinFor(null) }}>Pin for me</button>
          <button className="btn-ghost w-full" onClick={() => { p.onPin(pinFor, 'all'); setPinFor(null) }}>Pin for everyone</button>
          {p.pinId === pinFor && <button className="btn-ghost w-full" onClick={() => { p.onPin(null, 'all'); setPinFor(null) }}>Unpin</button>}
        </div>
      </Sheet>

      {/* the three buttons */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+14px)]">
        <div className="glass pointer-events-auto flex items-center gap-2.5 rounded-full p-2">
          <Ctl icon={micOn ? 'mic' : 'micOff'} label={micOn ? 'Mute microphone' : 'Unmute microphone'} onClick={p.onToggleMic} active={micOn} />
          <Ctl icon={cameraOn ? 'room' : 'videoOff'} label={cameraOn ? 'Turn camera off' : 'Turn camera on'} onClick={p.onToggleCamera} active={cameraOn} />
          {p.onToggleShare && <Ctl icon={p.sharing ? 'screenOff' : 'screen'} label={p.sharing ? 'Stop presenting' : 'Present your screen'} onClick={p.onToggleShare} active={p.sharing} />}
          <Ctl icon="chat" label="Send text to everyone" onClick={p.onChat} />
          <button aria-label={p.isHost ? 'End room' : 'Leave room'} title={p.isHost ? 'End room' : 'Leave room'} onClick={p.onLeave}
            className="flex h-14 w-[68px] items-center justify-center rounded-full bg-danger text-white shadow-lg shadow-danger/30 transition active:scale-90">
            <Icon name="phoneOff" size={24} />
          </button>
        </div>
      </div>
    </div>
  )
}

/** one participant's tile: live video (or avatar), their name, a pin button, and a green ring while they speak */
function TileButton({ t, i, avatar, mirror, compact, cls, pinned, onPin, onOpen, onToggleMic }: { t: RoomTile; i: number; n: number; wide: boolean; avatar: number; mirror: boolean; compact: boolean; cls: string; pinned: boolean; onPin: () => void; onOpen: () => void; onToggleMic: () => void }) {
  const speaking = useSpeaking(t.audio)
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }} aria-label={`Maximise ${t.isMe ? 'your' : t.name + "'s"} tile`}
      className={`rise relative cursor-pointer overflow-hidden ${compact ? 'rounded-[18px]' : 'rounded-[26px]'} text-left shadow-soft transition active:scale-[.985] ${cls} ${speaking ? 'ring-[3px] ring-[#4cd964]' : ''}`}
      style={{ background: `radial-gradient(85% 70% at 30% 20%, ${t.color}45, transparent 70%), linear-gradient(160deg,#f3f4fa,#e0e3f1)`, animationDelay: `${i * 40}ms` }}>
      {t.stream && t.isMe && t.screen
        ? <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center"><span className={compact ? 'text-2xl' : 'text-4xl'}>🖥️</span><span className={`font-semibold ${compact ? 'text-[11px]' : 'text-[15px]'}`}>You're presenting</span>{!compact && <span className="text-[12px] text-mute">Everyone can see your screen</span>}</div>
        : t.stream
        ? <StreamVideo stream={t.stream} mirror={mirror && !t.screen} contain={!!t.screen} />
        : <div className={`flex h-full items-center justify-center ${compact ? '' : 'pb-6'}`}><Avatar name={t.name} color={t.color} url={t.avatarUrl} size={avatar} /></div>}
      {/* mic status for everyone; on your own tile it is also a button */}
      {!compact && (t.isMe ? (
        <span role="button" tabIndex={0} aria-label={t.audio ? 'Mute microphone' : 'Unmute microphone'}
          onClick={(e) => { e.stopPropagation(); onToggleMic() }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onToggleMic() } }}
          className={`absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full backdrop-blur transition active:scale-90 ${t.audio ? 'bg-[#cfe9d6]' : 'bg-white/65'}`}>
          <Icon name={t.audio ? 'mic' : 'micOff'} size={19} />
        </span>
      ) : (
        <span aria-label={t.audio ? `${t.name}'s microphone is on` : `${t.name} is muted`}
          className={`absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full backdrop-blur ${t.audio ? 'bg-[#cfe9d6]' : 'bg-white/65 opacity-70'}`}>
          <Icon name={t.audio ? 'mic' : 'micOff'} size={19} />
        </span>
      ))}
      {compact && !t.audio && <span className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-white/70"><Icon name="micOff" size={13} /></span>}
      {!compact && (
        <button aria-label={pinned ? 'Pinned – change' : 'Pin this person'} title="Pin" onClick={(e) => { e.stopPropagation(); onPin() }}
          className={`absolute left-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full text-[17px] backdrop-blur transition active:scale-90 ${pinned ? 'bg-ink' : 'bg-white/65'}`}>📌</button>
      )}
      <span className={`absolute z-10 max-w-[80%] truncate rounded-full bg-white/65 font-medium backdrop-blur ${compact ? 'bottom-2 left-2 px-2 py-0.5 text-[11px]' : 'bottom-3 left-3 px-3 py-1.5 text-[14px]'}`}>{t.isMe ? 'You' : t.name}{t.screen && !t.isMe ? ' · presenting' : ''}</span>
    </div>
  )
}

function Ctl({ icon, label, onClick, active }: { icon: IconName; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button aria-label={label} title={label} onClick={onClick}
      className={`flex h-14 w-14 items-center justify-center rounded-full shadow-soft transition active:scale-90 ${active ? 'bg-[#cfe9d6] text-ink' : 'bg-white text-ink'}`}>
      <Icon name={icon} size={23} />
    </button>
  )
}

export const CallScreen = RoomView
