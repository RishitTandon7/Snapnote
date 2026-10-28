import { useLayoutEffect, type ReactNode } from 'react'
import './call-scope.css'

/**
 * Wraps the call screen (and its sheet) so it keeps its ORIGINAL look no matter how the app's
 * design tokens / page background change: it re-pins the old token values and, while mounted,
 * restores the original page background on <html> (so nothing is layered or re-rasterised).
 */
export function CallScope({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const el = document.documentElement
    el.classList.add('call-active')
    return () => el.classList.remove('call-active')
  }, [])
  return <div className="call-scope">{children}</div>
}
