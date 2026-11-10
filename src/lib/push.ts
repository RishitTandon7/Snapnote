import { rpc, supabase } from './supabase'

const PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? ''

const FLAG = 'snapnote.pushOn' // this phone turned call notifications on (survives updates)
// '0' = the person turned it off on purpose; anything else + permission already granted = keep it on across updates
const flagged = (): boolean => { try { return localStorage.getItem(FLAG) !== '0' } catch { return true } }
const setFlag = (on: boolean): void => { try { localStorage.setItem(FLAG, on ? '1' : '0') } catch { /* ignore */ } }

export type PushState = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on' | 'app'

const APP_KEY = 'snapnote.androidApp'
/** this phone has the Snapnote Android app installed and registered (it rings the phone itself) */
export const hasAndroidApp = (): boolean => { try { return !!localStorage.getItem(APP_KEY) } catch { return false } }

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true

function keyBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}
const b64url = (buf: ArrayBuffer | null): string => {
  if (!buf) return ''
  let s = ''
  new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b) })
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** can this phone/browser get notifications while Snapnote is closed, and are they on? */
export async function pushState(): Promise<PushState> {
  if (hasAndroidApp()) return 'app'
  if (!PUBLIC_KEY || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIOS && !standalone ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  try {
    const reg = await navigator.serviceWorker.ready
    if (Notification.permission === 'granted' && flagged() && !(await reg.pushManager.getSubscription())) { await enablePush().catch(() => undefined) } // lost in an update: quietly restore
    return (await reg.pushManager.getSubscription()) && Notification.permission === 'granted' ? 'on' : 'off'
  } catch { return 'off' }
}

/** ask permission (must come from a tap), subscribe this device, and tell the database */
export async function enablePush(): Promise<void> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Notifications were not allowed. You can turn them on in the browser/phone settings.')
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) as unknown as BufferSource }))
  setFlag(true)
  await rpc('save_push', { p_endpoint: sub.endpoint, p_p256dh: b64url(sub.getKey('p256dh')), p_auth: b64url(sub.getKey('auth')) })
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  setFlag(false)
  await rpc('remove_push', { p_endpoint: sub.endpoint }).catch(() => undefined)
  await sub.unsubscribe()
}

/** quietly re-save this device's subscription (browsers rotate them) – only if the person already turned it on */
export async function refreshPush(): Promise<void> {
  if (!PUBLIC_KEY || !('Notification' in window)) return
  // already allowed before (and not turned off by the person): subscribe again silently, no new permission question
  if (Notification.permission === 'granted' && flagged()) { try { await enablePush() } catch { /* ignore */ } return }
  if ((await pushState()) === 'on') { try { await enablePush() } catch { /* ignore */ } }
}

/**
 * The Snapnote Android app opens the website with ?fcm=<token>. Save it, so the server can ring the phone like a real call,
 * and stop the browser-style notification on this phone (otherwise it would ring twice).
 */
export async function registerAndroidApp(token: string): Promise<void> {
  if (!token || token.length < 20) return
  await rpc('save_push', { p_endpoint: `fcm:${token}`, p_p256dh: 'fcm', p_auth: 'fcm' })
  try { localStorage.setItem(APP_KEY, token) } catch { /* ignore */ }
  try {
    setFlag(false)
    const reg = await navigator.serviceWorker?.ready
    const sub = await reg?.pushManager.getSubscription()
    if (sub) { await rpc('remove_push', { p_endpoint: sub.endpoint }).catch(() => undefined); await sub.unsubscribe() }
  } catch { /* ignore */ }
}

/** after ringing someone: ask the server to send the push to their phones */
export async function ringPush(callId: string): Promise<void> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return
  await fetch('/api/ring', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ call: callId }) }).catch(() => undefined)
}
