import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * App-style Back button. In an installed PWA the phone's Back button walks the browser history, and when
 * there is nothing left it closes the whole app. These helpers make sure there is always an in-app step to go back to.
 */
type HState = { idx?: number; __overlay?: string } | null
const historyIdx = () => ((window.history.state as HState)?.idx ?? 0)

/** "Back" that stays inside the app: one step back if there is one, otherwise `fallback` (default Home). */
export function useGoBack() {
  const nav = useNavigate()
  return useCallback((fallback = '/') => {
    if (historyIdx() > 0) nav(-1)
    else nav(fallback, { replace: true })
  }, [nav])
}

/** Opening the app straight on a deep link (/r/…, /friends, a shortcut)? Put Home underneath so Back goes Home, not out. */
export function useEnsureHomeBelow() {
  const nav = useNavigate()
  const loc = useLocation()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    if (historyIdx() === 0 && loc.pathname !== '/') {
      const target = loc.pathname + loc.search + loc.hash
      nav('/', { replace: true })
      setTimeout(() => nav(target), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/**
 * Bottom-nav tabs behave like tabs: Home is the base, other tabs sit one step above it
 * (switching between them replaces, so Back never cycles through tabs), and "Home" pops back down.
 */
export function useTabNav() {
  const nav = useNavigate()
  const { pathname } = useLocation()
  return useCallback((to: string) => {
    if (to === pathname) return
    if (to === '/') { if (historyIdx() > 0) nav(-1); else nav('/', { replace: true }); return }
    nav(to, { replace: pathname !== '/' })
  }, [nav, pathname])
}

/* ───────── overlays (sheets, full-screen views) close on Back instead of leaving the screen ───────── */
let stack: string[] = []
let ignorePop = false

export function useBackToClose(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    if (!open) return
    const token = Math.random().toString(36).slice(2)
    let pushed = false
    let byBack = false
    // deferred a tick so React StrictMode's mount/unmount/mount in development can't leave a stray entry
    const t = setTimeout(() => {
      window.history.pushState({ ...((window.history.state as object | null) ?? {}), __overlay: token }, '')
      stack.push(token)
      pushed = true
    }, 0)
    const onPop = () => {
      if (ignorePop || !pushed || stack[stack.length - 1] !== token) return // only the top-most overlay reacts
      byBack = true
      stack.pop()
      closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      clearTimeout(t)
      window.removeEventListener('popstate', onPop)
      if (pushed && !byBack) {
        stack = stack.filter((x) => x !== token)
        // closed by a button, not by Back: remove the entry we added (unless the app already moved on from it)
        if ((window.history.state as HState)?.__overlay === token) {
          ignorePop = true
          window.history.back()
          setTimeout(() => { ignorePop = false }, 200)
        }
      }
    }
  }, [open])
}
