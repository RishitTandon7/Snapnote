import { useSyncExternalStore } from 'react'

/**
 * "Install the app" support.
 *  - Chrome / Edge / Android / desktop: the browser fires `beforeinstallprompt`; we keep it and show our own Install button.
 *  - iPhone / iPad (Safari): there is no install API, so we show the manual "Share → Add to Home Screen" steps.
 * Registered at import time (see main.tsx) so the event is never missed.
 */
interface BIPEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: BIPEvent | null = null
let installed = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export const isStandalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true

export const isIOS = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)

installed = isStandalone()
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BIPEvent; emit() })
window.addEventListener('appinstalled', () => { installed = true; deferred = null; emit() })

export interface InstallState {
  /** already running as an installed app */
  installed: boolean
  /** the browser can show its install dialog right now */
  canPrompt: boolean
  /** iPhone/iPad Safari: needs the manual steps */
  ios: boolean
}

let snapshot: InstallState = { installed, canPrompt: false, ios: isIOS() }
const getSnapshot = (): InstallState => {
  const canPrompt = !!deferred
  if (snapshot.installed !== installed || snapshot.canPrompt !== canPrompt) snapshot = { installed, canPrompt, ios: snapshot.ios }
  return snapshot
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export const useInstall = (): InstallState & { install: () => Promise<boolean> } => {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  return {
    ...s,
    install: async () => {
      if (!deferred) return false
      const e = deferred
      await e.prompt()
      const { outcome } = await e.userChoice
      deferred = null
      emit()
      return outcome === 'accepted'
    },
  }
}

const DISMISS_KEY = 'snapnote.installDismissedAt'
export const installDismissed = (days = 14): boolean => {
  try { const t = Number(localStorage.getItem(DISMISS_KEY)); return !!t && Date.now() - t < days * 86_400_000 } catch { return false }
}
export const dismissInstall = (): void => { try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* ignore */ } }
