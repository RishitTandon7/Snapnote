import { useEffect, useState } from 'react'
import { useToast } from '../context/Toast'
import { formatDuration } from '../lib/duration'

/**
 * Tells YOU when your own connection drops ("You're offline · 12 sec") and, when it comes back,
 * how long you were away ("You were offline for 1 min 4 sec").
 */
export function OfflineBanner() {
  const toast = useToast()
  const [since, setSince] = useState<number | null>(() => (navigator.onLine ? null : Date.now()))
  const [, tick] = useState(0)

  useEffect(() => {
    const off = () => setSince((s) => s ?? Date.now())
    const on = () => setSince((s) => {
      if (s !== null) toast(`You were offline for ${formatDuration(Date.now() - s)}`, 'info', { ms: 6000 })
      return null
    })
    window.addEventListener('offline', off)
    window.addEventListener('online', on)
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on) }
  }, [toast])

  // keep the timer moving while offline
  useEffect(() => {
    if (since === null) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [since])

  if (since === null) return null
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[95] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+8px)]">
      <div className="rise flex items-center gap-2.5 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white shadow-glass">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#ff5d7a]" />
        You're offline · {formatDuration(Date.now() - since)}
        <span className="hidden text-white/60 min-[420px]:inline">— calls and messages resume when you're back</span>
      </div>
    </div>
  )
}
