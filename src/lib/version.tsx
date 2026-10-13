import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

const TRIED = 'snapnote.autoUpdated'   // sessionStorage: the version we already tried to auto-update to (never loop)
const DONE = 'snapnote.justUpdated'    // localStorage: show "Updated" once after the reload

const settle = (w: ServiceWorker, ms: number) => new Promise<void>((res) => {
  if (w.state === 'installed' || w.state === 'activated') return res()
  const t = setTimeout(res, ms)
  w.addEventListener('statechange', () => { if (w.state === 'installed' || w.state === 'activated') { clearTimeout(t); res() } })
})

/**
 * Load the newest version. The background worker is UPGRADED IN PLACE (never unregistered): a phone's call-notification
 * subscription lives inside it, so removing it would make people allow notifications again after every update.
 */
export async function updateNow(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? []
    await Promise.all(regs.map(async (r) => {
      await r.update().catch(() => undefined)
      if (r.installing) await settle(r.installing, 6000)
      r.waiting?.postMessage({ type: 'SKIP_WAITING' })
    }))
    // old page copies go; the new version's own file cache (precache) stays
    if ('caches' in window) await Promise.all((await caches.keys()).filter((k) => !/precache/i.test(k)).map((k) => caches.delete(k)))
    if (regs.length) await new Promise<void>((res) => { const t = setTimeout(res, 1500); navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); res() }, { once: true }) })
  } catch { /* reload anyway */ }
  window.location.reload()
}

async function latestId(): Promise<string | null> {
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) return null
    const j = (await r.json()) as { id?: string }
    return typeof j.id === 'string' ? j.id : null
  } catch { return null }
}

type Phase = 'idle' | 'updating' | 'ask' | 'done'

/**
 * Keeps the app current (the website and the installed app both run this, so they update together).
 *  - not in a call: updates by itself with a quiet "Updating…" sweep, then shows a small "Updated" check
 *  - in a call: never reloads on its own; shows a card with "Update now" / "Later"
 * Checks at start, every minute, whenever the app comes to the front, and when a call ends.
 */
export function UpdateManager() {
  const { pathname } = useLocation()
  const inCall = pathname.startsWith('/r/')
  const inCallRef = useRef(inCall)
  const [phase, setPhase] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const snoozed = useRef(0)
  const go = (p: Phase) => { phaseRef.current = p; setPhase(p) }

  const check = useRef<() => Promise<void>>(async () => undefined)
  useEffect(() => {
    inCallRef.current = inCall
    check.current = async () => {
      if (typeof __BUILD_ID__ === 'undefined' || phaseRef.current === 'updating') return
      const id = await latestId()
      if (!id || id === __BUILD_ID__) { try { sessionStorage.removeItem(TRIED) } catch { /* ignore */ } return }
      if (inCallRef.current) { if (Date.now() > snoozed.current && phaseRef.current !== 'ask') go('ask'); return }
      let tried = false
      try { tried = sessionStorage.getItem(TRIED) === id } catch { /* ignore */ }
      if (tried) { if (Date.now() > snoozed.current && phaseRef.current !== 'ask') go('ask'); return } // auto-update didn't stick: let the person press the button
      try { sessionStorage.setItem(TRIED, id); localStorage.setItem(DONE, '1') } catch { /* ignore */ }
      go('updating')
      setTimeout(() => void updateNow(), 1400) // let the animation be seen
    }
    // the call ended while an update was waiting: apply it now
    if (!inCall && phaseRef.current === 'ask') { go('idle'); void check.current() }
  }, [inCall])

  useEffect(() => {
    const first = setTimeout(() => void check.current(), 1500)
    const every = setInterval(() => void check.current(), 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') void check.current() }
    document.addEventListener('visibilitychange', onVisible)
    // just updated? say so quietly
    try {
      if (localStorage.getItem(DONE)) { localStorage.removeItem(DONE); go('done'); setTimeout(() => { if (phaseRef.current === 'done') go('idle') }, 2600) }
    } catch { /* ignore */ }
    return () => { clearTimeout(first); clearInterval(every); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  if (phase === 'idle') return null
  if (phase === 'ask') {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[94] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+10px)]" role="alertdialog" aria-label="Update available">
        <div className="rise pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[24px] bg-white p-3 pl-4 shadow-glass">
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[15px] font-semibold text-ink">Update available</div>
            <div className="text-[12.5px] text-mute">{inCall ? "Your call won't change until you tap Update now." : 'A new version of Snapnote is ready.'}</div>
          </div>
          <button onClick={() => { snoozed.current = Date.now() + 5 * 60_000; go('idle') }} className="rounded-full px-3 py-2 text-[13px] font-medium text-mute">Later</button>
          <button onClick={() => { try { localStorage.setItem(DONE, '1') } catch { /* ignore */ } go('updating'); setTimeout(() => void updateNow(), 900) }}
            className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white transition active:scale-95">Update now</button>
        </div>
      </div>
    )
  }
  if (phase === 'updating') {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[94] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+10px)]" role="status">
        <div className="rise relative flex items-center gap-2.5 overflow-hidden rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white shadow-glass">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          Updating Snapnote…
          <span className="upd-sweep absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        </div>
      </div>
    )
  }
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[94] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+10px)]" role="status">
      <div className="upd-pop flex items-center gap-2 rounded-full bg-white px-4 py-2 text-[13px] font-medium text-ink shadow-glass">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#34c759] text-[11px] text-white">✓</span>
        Updated to the latest version
      </div>
    </div>
  )
}
