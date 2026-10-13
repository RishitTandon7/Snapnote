import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { initials } from '../lib/util'
import { SIGNATURE } from '../lib/signature'
import { useBackToClose } from '../lib/nav'

export function Avatar({ name, color, size = 44, online, url }: { name: string; color: string; size?: number; online?: boolean; url?: string | null }) {
  const [bad, setBad] = useState(false) // photo failed to load → fall back to the initial
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full font-bold text-white"
        style={{ background: `linear-gradient(135deg, ${color}, ${color}aa)`, fontSize: size * 0.42 }}
      >
        {url && !bad
          ? <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(true)} className="h-full w-full object-cover" />
          : initials(name)}
      </div>
      {online !== undefined && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-paper ${online ? 'bg-emerald-400' : 'bg-zinc-600'}`}
        />
      )}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ui-card flex items-center gap-3 p-4">
          <Skeleton className="h-11 w-11 !rounded-full" />
          <div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>
        </div>
      ))}
    </div>
  )
}

export function Empty({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="rise flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 text-5xl">{emoji}</div>
      <div className="text-lg font-semibold">{title}</div>
      <div className="mt-1 max-w-xs text-sm text-ink/50">{children}</div>
    </div>
  )
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useBackToClose(open, onClose) // the phone's Back button closes the sheet first
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center scrim bg-ink/35 backdrop-blur-sm" onClick={onClose}>
      <div
        className="rise safe-bottom w-full max-w-[430px] rounded-t-[32px] bg-white/95 p-5 shadow-glass backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink/20" />
        <h2 className="mb-4 text-[21px] font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? 'bg-ink' : 'bg-ink/15'} disabled:opacity-40`}
    >
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  )
}

/**
 * Loading screen: just the name, handwritten. The glyph outlines (src/lib/signature.ts, generated from a
 * handwriting font) are drawn letter by letter, then filled in like ink; then the screen fades away.
 */
export function Splash({ ready }: { ready: boolean }) {
  const svg = useRef<SVGSVGElement>(null)
  const [armed, setArmed] = useState(false)
  const [minDone, setMinDone] = useState(false)
  const [gone, setGone] = useState(false)

  // measure every letter once, before first paint, and stagger them left to right
  const [writeMs, setWriteMs] = useState(1500)
  useLayoutEffect(() => {
    let t = 0.05
    let end = 0
    svg.current?.querySelectorAll<SVGPathElement>('path').forEach((p) => {
      const len = Math.ceil(p.getTotalLength())
      const d = Math.min(0.42, Math.max(0.16, len / 2200))
      p.style.setProperty('--len', String(len))
      p.style.setProperty('--d', `${d.toFixed(2)}s`)
      p.style.setProperty('--delay', `${t.toFixed(2)}s`)
      end = t + d * 0.6 + 0.35            // when this letter's ink has finished filling
      t += d * 0.5
    })
    setWriteMs(Math.ceil(end * 1000))
    setArmed(true)
  }, [])

  // never leave mid-stroke: wait until the last letter is inked, plus a short beat, then go as soon as the app is ready
  useEffect(() => { const t = setTimeout(() => setMinDone(true), writeMs + 250); return () => clearTimeout(t) }, [writeMs])
  const hide = ready && minDone
  useEffect(() => {
    if (!hide) return
    const t = setTimeout(() => setGone(true), 750)
    return () => clearTimeout(t)
  }, [hide])
  if (gone) return null

  return (
    <div className={`splash fixed inset-0 z-[100] flex flex-col items-center justify-center bg-page ${hide ? 'splash-out' : ''}`} role="status" aria-label="Snapnote">
      <svg ref={svg} viewBox={SIGNATURE.viewBox} className={`w-[min(78vw,340px)] overflow-visible ${armed ? '' : 'opacity-0'}`} aria-hidden>
        {SIGNATURE.glyphs.map((g, i) => <path key={i} d={g.d} className="sig-path" />)}
      </svg>
    </div>
  )
}

/** Centered text that shrinks until it fits its box (auto-fit). */
export function FitText({ text, max = 72, min = 18 }: { text: string; max?: number; min?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const b = box.current
    const i = inner.current
    if (!b || !i) return
    let size = max
    i.style.fontSize = `${size}px`
    while (size > min && (i.scrollHeight > b.clientHeight || i.scrollWidth > b.clientWidth)) {
      size -= 2
      i.style.fontSize = `${size}px`
    }
  }, [text, max, min])
  return (
    <div ref={box} className="flex h-full w-full items-center justify-center overflow-hidden">
      <div ref={inner} className="text-shadow w-full whitespace-pre-wrap break-words text-center font-bold leading-tight text-white">
        {text}
      </div>
    </div>
  )
}

/** The look of an incoming message, shared by Display mode and the sender's preview. */
export function TextOverlay({ text, from, msgKey, compact }: { text: string; from?: string; msgKey: string | number; compact?: boolean }) {
  if (!text.trim()) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center p-6"
      style={{ background: 'radial-gradient(ellipse at center, rgba(0,0,0,.55), rgba(0,0,0,.12) 75%)', backdropFilter: 'blur(2px)' }}
    >
      <div key={msgKey} className="msg-in flex max-h-[62%] w-full max-w-3xl flex-col items-center" style={{ height: '62%' }}>
        {from && <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/70">{from}</div>}
        <div className="min-h-0 w-full flex-1">
          <FitText text={text} max={compact ? 26 : 72} min={compact ? 10 : 18} />
        </div>
      </div>
    </div>
  )
}
