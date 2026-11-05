import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Watch-together sync. Everyone plays the same title on their OWN Netflix / YouTube / Prime account; the "Snapnote Sync"
 * browser extension reports play / pause / seek from the video tab to this page, and this page passes them to the other
 * people in the room (over the room's private channel) and applies theirs.
 *
 *   extension → page : window message { snapnoteExt: true, payload }
 *   page → extension : window message { snapnoteApp: true, payload }
 */
export interface PlayerInfo { found: boolean; host?: string; title?: string; playing?: boolean; time?: number }
export interface SyncMsg { from: string; kind: 'play' | 'pause' | 'seek' | 'tick' | 'start' | 'resync'; playing: boolean; time: number }

const toExt = (payload: Record<string, unknown>) => window.postMessage({ snapnoteApp: true, payload }, '*')

export function useWatchSync(opts: {
  uid: string
  enabled: boolean
  /** send a sync message to everyone else in the room */
  send: (m: SyncMsg) => void
  toast: (msg: string) => void
}) {
  const [extension, setExtension] = useState(false)
  const [player, setPlayer] = useState<PlayerInfo>({ found: false })
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts })
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const playerRef = useRef<PlayerInfo>({ found: false })
  /** ask the video tab where it is right now, then use the answer */
  const fresh = useCallback((use: (p: PlayerInfo) => void) => { toExt({ t: 'probe' }); timers.current.push(setTimeout(() => use(playerRef.current), 300)) }, [])

  // messages from the extension
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window || !e.data || !e.data.snapnoteExt) return
      const p = e.data.payload as { t?: string; kind?: SyncMsg['kind'] | 'found'; playing?: boolean; time?: number; host?: string; title?: string; found?: boolean }
      if (p.t === 'present') setExtension(true)
      else if (p.t === 'player') { playerRef.current = { found: !!p.found }; setPlayer({ found: !!p.found }) }
      else if (p.t === 'state') {
        setExtension(true)
        playerRef.current = { found: true, host: p.host, title: p.title, playing: p.playing, time: p.time }
        setPlayer(playerRef.current)
        // something I did in my video tab (not a sync I applied): tell the room
        if (optsRef.current.enabled && (p.kind === 'play' || p.kind === 'pause' || p.kind === 'seek' || p.kind === 'tick'))
          optsRef.current.send({ from: optsRef.current.uid, kind: p.kind, playing: !!p.playing, time: p.time ?? 0 })
      }
    }
    const pending = timers.current
    window.addEventListener('message', onMsg)
    toExt({ t: 'ping' })
    toExt({ t: 'probe' })
    const again = setInterval(() => toExt({ t: 'probe' }), 8000) // notice a video tab opened later
    return () => { window.removeEventListener('message', onMsg); clearInterval(again); pending.forEach(clearTimeout) }
  }, [])

  /** a sync message from someone else in the room */
  const incoming = useCallback((m: SyncMsg) => {
    if (!optsRef.current.enabled || m.from === optsRef.current.uid) return
    if (m.kind === 'start') { toExt({ t: 'apply', kind: 'start', time: m.time, delay: 3000 }); return } // the 3-2-1 runs in the video tab
    toExt({ t: 'apply', kind: m.kind === 'resync' ? 'seek' : m.kind, playing: m.playing, time: m.time })
  }, [])

  /** everyone pauses at my position, counts down 3-2-1, and presses play together */
  const startTogether = useCallback(() => {
    fresh((pl) => {
      const t = pl.time ?? 0
      optsRef.current.send({ from: optsRef.current.uid, kind: 'start', playing: false, time: t })
      toExt({ t: 'apply', kind: 'start', time: t, delay: 3000 })
      optsRef.current.toast('Starting together — switch to your video tab')
    })
  }, [fresh])

  /** put everyone at my current moment */
  const resync = useCallback(() => {
    fresh((pl) => {
      optsRef.current.send({ from: optsRef.current.uid, kind: 'resync', playing: !!pl.playing, time: pl.time ?? 0 })
      optsRef.current.toast('Everyone jumped to your moment')
    })
  }, [fresh])

  return { extension, player, incoming, startTogether, resync }
}
