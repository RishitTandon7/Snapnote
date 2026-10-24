/**
 * Peer-to-peer video + voice for a room (WebRTC, full mesh).
 *
 *  - Signalling (hello / offer / answer / ICE / "camera / mic on" flags) goes over the room's private Realtime channel.
 *    It is injected as a `transport`, so this class has no Supabase dependency and can be tested on its own.
 *  - Media flows directly between phones (encrypted DTLS-SRTP); it never touches the server.
 *  - Each pair gets ONE video and ONE audio transceiver. Switching the camera or mic on/off is `replaceTrack()` –
 *    no renegotiation, no glare. The peer with the smaller id is the "initiator" that sends the first offer.
 */
/** Opus tuned for music / movie sound: stereo and up to 128 kbps (the default is mono voice at a low bitrate) */
function tuneOpus(d: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  if (!d.sdp) return d
  const pt = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(d.sdp)?.[1]
  if (!pt) return d
  const sdp = d.sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (_m, params: string) => {
    let p = params
    for (const kv of ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000']) if (!p.includes(kv.split('=')[0] + '=')) p += `;${kv}`
    return `a=fmtp:${pt} ${p}`
  })
  return { type: d.type, sdp }
}

export interface RtcTransport {
  send: (event: 'hello' | 'sig' | 'media' | 'ping' | 'bye', payload: Record<string, unknown>) => void
}

/** something happened to someone in the call */
export interface PresenceEvent {
  /** joined: first time we see them · left: they pressed Leave · dropped: went quiet (closed the tab / lost signal) · back: returned after dropping/leaving */
  type: 'joined' | 'left' | 'dropped' | 'back'
  userId: string
  /** for "back": how long they were gone */
  offlineMs?: number
}

/** one person who is in the call right now, and what they are sending */
export interface RemoteMedia { peerId: string; userId: string; video: MediaStream | null; audio: MediaStream | null; /** the video is their SCREEN (presenting), not their camera */ screen: boolean }

interface Peer {
  id: string
  userId: string
  pc: RTCPeerConnection
  initiator: boolean
  videoT: RTCRtpTransceiver | null
  audioT: RTCRtpTransceiver | null
  videoStream: MediaStream | null
  audioStream: MediaStream | null
  videoOn: boolean
  audioOn: boolean
  screenOn: boolean
  queued: RTCIceCandidateInit[]
  remoteSet: boolean
  retried: boolean
  /** last time we heard anything from them (a ping every few seconds) */
  lastSeen: number
  /** side channel for HD stills (null until it opens) */
  dc: RTCDataChannel | null
  /** the still that is arriving from them right now */
  rx: { id: string; chunks: ArrayBuffer[]; mime: string } | null
}

type Waiter = { resolve: (b: Blob) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
const CHUNK = 16 * 1024

/** what one connection to one other person is doing right now (shown in Room details → Connection) */
export interface PeerStatus {
  userId: string
  connection: RTCPeerConnectionState
  ice: RTCIceConnectionState
  videoOn: boolean
  audioOn: boolean
  /** their video is actually arriving (not just announced) */
  videoFlowing: boolean
  audioFlowing: boolean
}

export interface RoomRtcOptions {
  userId: string
  transport: RtcTransport
  /** called whenever what remote people are sending changes */
  onChange: (remotes: RemoteMedia[]) => void
  /** joined / left / went offline / came back */
  onEvent?: (e: PresenceEvent) => void
  iceServers?: RTCIceServer[]
  maxPeers?: number
  /** how often we tell the room we're still here (default 4 s) */
  pingMs?: number
  /** someone we haven't heard from for this long has left (default 11 s) */
  peerTimeoutMs?: number
}

const uuid = () =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`

/** public STUN always; TURN only if you configure one (VITE_TURN_URL / _USERNAME / _CREDENTIAL) for strict networks */
export function defaultIceServers(): RTCIceServer[] {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
  if (env.VITE_TURN_URL) servers.push({ urls: env.VITE_TURN_URL, username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL })
  return servers
}

export class RoomRtc {
  readonly peerId = uuid()
  private peers = new Map<string, Peer>()
  private localVideo: MediaStreamTrack | null = null
  private localAudio: MediaStreamTrack | null = null
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null
  private localScreen = false
  private stillProvider: (() => Promise<Blob>) | null = null
  private waiters = new Map<string, Waiter>()
  /** people who were here and are gone (when, and whether they said goodbye) */
  private gone = new Map<string, { at: number; how: 'left' | 'dropped' }>()
  private announced = new Set<string>()

  constructor(private opts: RoomRtcOptions) {}

  /** announce ourselves; everyone already in the room answers with their own hello */
  start(): void {
    this.opts.transport.send('hello', { from: this.peerId, userId: this.opts.userId, ...this.flags() })
    // presence: say "still here" every few seconds, and forget anyone who has gone quiet (closed the tab, lost signal…)
    this.timer = setInterval(() => {
      if (this.stopped) return
      this.opts.transport.send('ping', { from: this.peerId, userId: this.opts.userId, ...this.flags() })
      const limit = this.opts.peerTimeoutMs ?? 11_000
      const now = Date.now()
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { for (const p of this.peers.values()) p.lastSeen = now; return } // I am the one offline: don't mark anyone as gone
      for (const p of [...this.peers.values()]) if (now - p.lastSeen > limit) this.closePeer(p.id, true, 'dropped')
    }, this.opts.pingMs ?? 4_000)
  }

  /** how I take a full-resolution still of my own camera when someone asks (set by the app) */
  setStillProvider(fn: (() => Promise<Blob>) | null): void { this.stillProvider = fn }

  /** can I ask this person for an HD still? */
  canRequestStill(userId: string): boolean {
    for (const p of this.peers.values()) if (p.userId === userId && p.dc?.readyState === 'open') return true
    return false
  }

  /** ask someone's phone for a full-resolution photo from its camera (arrives over the side channel in small pieces) */
  requestStill(userId: string, timeoutMs = 15_000): Promise<Blob> {
    const peer = [...this.peers.values()].find((p) => p.userId === userId && p.dc?.readyState === 'open')
    if (!peer?.dc) return Promise.reject(new Error('no-channel'))
    const id = Math.random().toString(36).slice(2, 10)
    return new Promise<Blob>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error('timeout')) }, timeoutMs)
      this.waiters.set(id, { resolve, reject, timer })
      try { peer.dc!.send(JSON.stringify({ t: 'shot', id })) } catch { clearTimeout(timer); this.waiters.delete(id); reject(new Error('send-failed')) }
    })
  }

  private setupDc(peer: Peer, dc: RTCDataChannel): void {
    peer.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = 512 * 1024
    dc.onclose = () => { if (peer.dc === dc) peer.dc = null }
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') { peer.rx?.chunks.push(e.data as ArrayBuffer); return }
      let m: { t?: string; id?: string; mime?: string; why?: string }
      try { m = JSON.parse(e.data) } catch { return }
      if (m.t === 'shot' && m.id) void this.sendStill(dc, m.id)
      else if (m.t === 'shot-begin' && m.id) peer.rx = { id: m.id, chunks: [], mime: m.mime ?? 'image/jpeg' }
      else if (m.t === 'shot-end' && m.id && peer.rx?.id === m.id) {
        const w = this.waiters.get(m.id)
        const blob = new Blob(peer.rx.chunks, { type: peer.rx.mime })
        peer.rx = null
        if (w) { clearTimeout(w.timer); this.waiters.delete(m.id); w.resolve(blob) }
      } else if (m.t === 'shot-fail' && m.id) {
        const w = this.waiters.get(m.id)
        if (w) { clearTimeout(w.timer); this.waiters.delete(m.id); w.reject(new Error(m.why ?? 'failed')) }
      }
    }
  }

  private async sendStill(dc: RTCDataChannel, id: string): Promise<void> {
    try {
      if (!this.stillProvider) throw new Error('no-camera')
      const blob = await this.stillProvider()
      const buf = await blob.arrayBuffer()
      dc.send(JSON.stringify({ t: 'shot-begin', id, mime: blob.type || 'image/jpeg', size: buf.byteLength }))
      for (let off = 0; off < buf.byteLength; off += CHUNK) {
        if (dc.readyState !== 'open') return
        if (dc.bufferedAmount > 1024 * 1024) await new Promise<void>((r) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r() } })
        dc.send(buf.slice(off, off + CHUNK))
      }
      dc.send(JSON.stringify({ t: 'shot-end', id }))
    } catch (e) {
      try { dc.send(JSON.stringify({ t: 'shot-fail', id, why: (e as Error).message })) } catch { /* channel gone */ }
    }
  }

  /** my camera, or my screen when `screen` is true (null = off). Pushed to every peer with replaceTrack – no renegotiation. */
  setLocalVideo(stream: MediaStream | null, screen = false): void {
    this.localVideo = stream?.getVideoTracks()[0] ?? null
    this.localScreen = !!this.localVideo && screen
    try { if (this.localVideo) (this.localVideo as MediaStreamTrack & { contentHint: string }).contentHint = screen ? 'text' : 'detail' } catch { /* optional */ } // sharp text for screens, sharp detail for cameras
    for (const p of this.peers.values()) this.applyTracks(p)
    this.sendMedia()
  }

  /** my microphone (null = muted) */
  setLocalAudio(stream: MediaStream | null, music = false): void {
    this.localAudio = stream?.getAudioTracks()[0] ?? null
    try { if (this.localAudio) (this.localAudio as MediaStreamTrack & { contentHint: string }).contentHint = music ? 'music' : 'speech' } catch { /* optional */ }
    for (const p of this.peers.values()) this.applyTracks(p)
    this.sendMedia()
  }

  /** a snapshot of every connection, for troubleshooting */
  status(): PeerStatus[] {
    const flowing = (st: MediaStream | null) => !!st && st.getTracks().some((t) => t.readyState === 'live' && !t.muted)
    return [...this.peers.values()].map((p) => ({
      userId: p.userId,
      connection: p.pc.connectionState,
      ice: p.pc.iceConnectionState,
      videoOn: p.videoOn,
      audioOn: p.audioOn,
      videoFlowing: flowing(p.videoStream),
      audioFlowing: flowing(p.audioStream),
    }))
  }

  /** feed every message received on the room channel in here */
  handle(event: string, payload: unknown): void {
    if (this.stopped) return
    const p = (payload ?? {}) as Record<string, unknown>
    const from = p.from as string | undefined
    if (!from || from === this.peerId) return

    const seen = this.peers.get(from)
    if (seen) seen.lastSeen = Date.now()

    if (event === 'hello' || event === 'ping') {
      const known = this.peers.get(from)
      if (known) {
        const uid = String(p.userId ?? '')
        const changed = known.videoOn !== !!p.video || known.audioOn !== !!p.audio || known.screenOn !== !!p.screen || (!known.userId && !!uid)
        known.videoOn = !!p.video
        known.audioOn = !!p.audio
        known.screenOn = !!p.screen
        if (!known.userId) { known.userId = uid; this.announce(uid) }
        if (changed) this.emit()
        return
      }
      const peer = this.createPeer(from, String(p.userId ?? ''), this.peerId < from)
      peer.videoOn = !!p.video
      peer.audioOn = !!p.audio
      peer.screenOn = !!p.screen
      this.announce(peer.userId)
      // they don't know about us yet (they just joined, or missed our hello): introduce ourselves
      if (!(event === 'hello' && p.reply)) this.opts.transport.send('hello', { from: this.peerId, userId: this.opts.userId, ...this.flags(), reply: true })
      if (peer.initiator) void this.offer(peer)
      this.emit()
    } else if (event === 'media') {
      const peer = this.peers.get(from)
      if (peer) { peer.videoOn = !!p.video; peer.audioOn = !!p.audio; peer.screenOn = !!p.screen; this.emit() }
    } else if (event === 'sig') {
      if (p.to !== this.peerId) return
      void this.onSignal(from, p.kind as string, p.data)
    } else if (event === 'bye') {
      this.closePeer(from, true, 'left')
    }
  }

  stop(): void {
    if (this.stopped) return
    this.opts.transport.send('bye', { from: this.peerId })
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    for (const id of [...this.peers.keys()]) this.closePeer(id, false)
    this.opts.onChange([])
  }

  /* ───────────────────────── internals ───────────────────────── */

  private flags(): { video: boolean; audio: boolean; screen: boolean } {
    return { video: !!this.localVideo, audio: !!this.localAudio, screen: this.localScreen }
  }

  private sendMedia(): void {
    this.opts.transport.send('media', { from: this.peerId, ...this.flags() })
  }

  /** tell the app about a person the first time we know who they are (or when they come back) */
  private announce(userId: string): void {
    if (!userId || this.announced.has(userId)) return
    this.announced.add(userId)
    const was = this.gone.get(userId)
    if (was) { this.gone.delete(userId); this.opts.onEvent?.({ type: 'back', userId, offlineMs: Date.now() - was.at }) }
    else this.opts.onEvent?.({ type: 'joined', userId })
  }

  /** forget who was "gone" (used after MY connection returns, so nobody is blamed for my gap) */
  clearGone(): void { this.gone.clear() }

  private createPeer(id: string, userId: string, initiator: boolean): Peer {
    if (this.peers.size >= (this.opts.maxPeers ?? 7)) throw new Error('room is full')
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? defaultIceServers(), iceCandidatePoolSize: 2 })
    const peer: Peer = {
      id, userId, pc, initiator, videoT: null, audioT: null, videoStream: null, audioStream: null,
      videoOn: false, audioOn: false, screenOn: false, queued: [], remoteSet: false, retried: false, lastSeen: Date.now(), dc: null, rx: null,
    }
    this.peers.set(id, peer)
    pc.ondatachannel = (e) => this.setupDc(peer, e.channel)
    if (initiator) this.setupDc(peer, pc.createDataChannel('snap', { ordered: true })) // created before the offer so it is part of it

    pc.onicecandidate = (e) => {
      if (e.candidate) this.opts.transport.send('sig', { from: this.peerId, to: id, kind: 'ice', data: e.candidate.toJSON() })
    }
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') { if (!peer.audioStream) peer.audioStream = new MediaStream(); peer.audioStream.addTrack(e.track) }
      else { if (!peer.videoStream) peer.videoStream = new MediaStream(); peer.videoStream.addTrack(e.track) }
      this.emit()
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // one automatic retry (new network paths) before giving up on this person
        if (peer.initiator && !peer.retried) { peer.retried = true; try { pc.restartIce() } catch { /* ignore */ } void this.offer(peer, true) }
        else this.closePeer(id, true, 'dropped')
      } else if (pc.connectionState === 'closed') this.closePeer(id, true, 'dropped')
    }

    if (initiator) {
      try { peer.videoT = pc.addTransceiver('video', { direction: 'sendrecv', sendEncodings: [{ maxBitrate: 6_000_000, maxFramerate: 30 }] }) }
      catch { peer.videoT = pc.addTransceiver('video', { direction: 'sendrecv' }) }
      peer.audioT = pc.addTransceiver('audio', { direction: 'sendrecv' })
      this.applyTracks(peer)
    }
    return peer
  }

  /** one stream id for everything I send, so the receiver keeps my picture and my sound in lip-sync (matters for movies) */
  private syncStream = new MediaStream()

  private applyTracks(peer: Peer): void {
    try { (peer.videoT?.sender as RTCRtpSender & { setStreams?: (...s: MediaStream[]) => void })?.setStreams?.(this.syncStream) } catch { /* older browsers */ }
    try { (peer.audioT?.sender as RTCRtpSender & { setStreams?: (...s: MediaStream[]) => void })?.setStreams?.(this.syncStream) } catch { /* older browsers */ }
    void peer.videoT?.sender.replaceTrack(this.localVideo).catch(() => undefined)
    void peer.audioT?.sender.replaceTrack(this.localAudio).catch(() => undefined)
  }

  private async offer(peer: Peer, iceRestart = false): Promise<void> {
    try {
      await peer.pc.setLocalDescription(tuneOpus(await peer.pc.createOffer({ iceRestart })))
      this.opts.transport.send('sig', { from: this.peerId, to: peer.id, kind: 'offer', data: peer.pc.localDescription?.toJSON() })
    } catch { this.closePeer(peer.id) }
  }

  private async onSignal(from: string, kind: string, data: unknown): Promise<void> {
    let peer = this.peers.get(from)
    try {
      if (kind === 'offer') {
        if (!peer) peer = this.createPeer(from, '', false) // their hello may have been missed
        await peer.pc.setRemoteDescription(data as RTCSessionDescriptionInit)
        peer.remoteSet = true
        // the offer created receive-only transceivers for us; make them send-and-receive so we can send back
        for (const t of peer.pc.getTransceivers()) {
          const kindOf = t.receiver.track.kind
          if (kindOf === 'video') peer.videoT = t
          else if (kindOf === 'audio') peer.audioT = t
          else continue
          t.direction = 'sendrecv'
        }
        this.applyTracks(peer)
        await peer.pc.setLocalDescription(tuneOpus(await peer.pc.createAnswer()))
        this.opts.transport.send('sig', { from: this.peerId, to: from, kind: 'answer', data: peer.pc.localDescription?.toJSON() })
        await this.flush(peer)
      } else if (kind === 'answer' && peer) {
        await peer.pc.setRemoteDescription(data as RTCSessionDescriptionInit)
        peer.remoteSet = true
        await this.flush(peer)
      } else if (kind === 'ice' && peer) {
        if (peer.remoteSet) await peer.pc.addIceCandidate(data as RTCIceCandidateInit)
        else peer.queued.push(data as RTCIceCandidateInit)
      }
    } catch { /* a bad or late message must never take the call down */ }
  }

  private async flush(peer: Peer): Promise<void> {
    const q = peer.queued.splice(0)
    for (const c of q) { try { await peer.pc.addIceCandidate(c) } catch { /* ignore */ } }
  }

  private closePeer(id: string, emit = true, how: 'left' | 'dropped' | null = null): void {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.delete(id)
    if (how && peer.userId && !this.stopped) {
      this.gone.set(peer.userId, { at: Date.now(), how })
      this.announced.delete(peer.userId)
      this.opts.onEvent?.({ type: how, userId: peer.userId })
    }
    peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = peer.pc.ondatachannel = null
    try { peer.dc?.close() } catch { /* ignore */ }
    try { peer.pc.close() } catch { /* ignore */ }
    if (emit) this.emit()
  }

  /** everyone currently in the call (video/audio are null while they are off) */
  private emit(): void {
    const list: RemoteMedia[] = []
    for (const p of this.peers.values()) {
      if (!p.userId) continue
      list.push({ peerId: p.id, userId: p.userId, video: p.videoOn ? p.videoStream : null, audio: p.audioOn ? p.audioStream : null, screen: p.videoOn && p.screenOn })
    }
    this.opts.onChange(list)
  }
}
