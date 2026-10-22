import { useEffect, useState } from 'react'

/** true while the given stream's audio is loud enough to count as someone speaking (used for the green ring on a tile) */
export function useSpeaking(stream: MediaStream | null): boolean {
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) { setSpeaking(false); return }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    void ctx.resume().catch(() => undefined)
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser) // never connected to the speakers: this only measures loudness
    const buf = new Uint8Array(analyser.fftSize)
    let raf = 0
    let lastLoud = 0
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x }
      const now = performance.now()
      if (Math.sqrt(sum / buf.length) > 0.035) lastLoud = now
      setSpeaking(now - lastLoud < 450)
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => { cancelAnimationFrame(raf); try { src.disconnect() } catch { /* ignore */ } void ctx.close().catch(() => undefined); setSpeaking(false) }
  }, [stream])
  return speaking
}
