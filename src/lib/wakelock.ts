import { useEffect } from 'react'

/**
 * Keeps the phone screen from dimming/locking while `active` (e.g. during a call).
 * Browsers release the lock whenever the page is hidden, so it is re-acquired when the page is visible again.
 * (No hidden-video trick for old iPhones: a second playing video can switch the camera off.)
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false
    const acquire = async () => {
      try {
        const l = await navigator.wakeLock.request('screen')
        if (cancelled) { void l.release().catch(() => undefined); return }
        lock = l
        l.addEventListener('release', () => { if (lock === l) lock = null })
      } catch { /* not allowed right now (low battery, background) – retried on the next visibility change */ }
    }
    void acquire()
    const onVisible = () => { if (document.visibilityState === 'visible' && !lock) void acquire() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => undefined)
    }
  }, [active])
}
