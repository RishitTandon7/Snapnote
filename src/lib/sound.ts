/**
 * Short "ping" sounds, synthesised with the Web Audio API (no audio files to download).
 *   join    someone joined the room
 *   request someone is asking to be let in (host) – three rising notes, more insistent
 *   message a text arrived
 *   welcome you were let in
 * The user can switch sounds off (stored on this device).
 */
export type PingKind = 'join' | 'request' | 'message' | 'welcome' | 'ring'

const KEY = 'snapnote.sounds'
export const soundsOn = (): boolean => { try { return localStorage.getItem(KEY) !== 'off' } catch { return true } }
export const setSoundsOn = (on: boolean): void => { try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* ignore */ } }

const NOTES: Record<PingKind, number[]> = {
  join: [1047, 1319],
  request: [784, 988, 1319],
  message: [880],
  welcome: [659, 988, 1319],
  ring: [988, 784, 988, 784],
}

let ctx: AudioContext | null = null

export function playPing(kind: PingKind = 'join'): void {
  if (!soundsOn()) return
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    ctx ??= new AC()
    void ctx.resume().catch(() => undefined)
    const t0 = ctx.currentTime + 0.01
    NOTES[kind].forEach((freq, i) => {
      const t = t0 + i * 0.13
      for (const [mult, peak, type] of [[1, 0.22, 'sine'], [2, 0.05, 'triangle']] as const) {
        const osc = ctx!.createOscillator()
        const gain = ctx!.createGain()
        osc.type = type
        osc.frequency.value = freq * mult
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.linearRampToValueAtTime(peak, t + 0.008)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
        osc.connect(gain)
        gain.connect(ctx!.destination)
        osc.start(t)
        osc.stop(t + 0.55)
      }
    })
    navigator.vibrate?.(kind === 'request' ? [60, 50, 60] : kind === 'ring' ? [200, 100, 200] : 40)
  } catch { /* sound is a nicety, never an error */ }
}

let ringTimer: ReturnType<typeof setInterval> | null = null
/** ring like a phone until stopRinging() */
export function startRinging(): void {
  if (ringTimer) return
  playPing('ring')
  ringTimer = setInterval(() => playPing('ring'), 2200)
}
export function stopRinging(): void {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null }
}
