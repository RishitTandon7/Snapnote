export const AVATAR_COLORS = [
  '#7c5cff', '#ff7ac6', '#ff8a5c', '#ffc65c', '#5cd6a0', '#5cc8ff', '#a05cff', '#ff5c7c',
]

export const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
export const ONLINE_WINDOW_MS = 60_000
export const HEARTBEAT_MS = 30_000
export const MAX_TEXT = 500

export function isFriendCode(s: string): boolean {
  return /^[A-Z0-9]{2,4}-[0-9]{4}$/.test(s)
}

export function addLink(code: string): string {
  return `${window.location.origin}/j/${code}`
}

export function isOnline(lastSeen: string | null | undefined, now: number): boolean {
  if (!lastSeen) return false
  return now - Date.parse(lastSeen) < ONLINE_WINDOW_MS
}

export function initials(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

export function defaultDeviceName(username?: string): string {
  return username || deviceKind()
}

/** true for names this app generated itself (so we may safely rename them to the username) */
export function isAutoDeviceName(name: string, username?: string): boolean {
  const generic = ['iPhone', 'iPad', 'Android phone', 'Windows PC', 'Mac', 'Linux PC', 'Browser']
  return generic.includes(name) || (!!username && name.startsWith(`${username}'s `))
}

function deviceKind(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Mac/.test(ua)) return 'Mac'
  if (/Linux/.test(ua)) return 'Linux PC'
  return 'Browser'
}

const DEVICE_KEY = 'snapnote.deviceId'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Generated once per browser and kept in localStorage. */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id || !UUID_RE.test(id)) {
      id = uuid()
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return uuid()
  }
}
export function resetDeviceId(): void {
  try { localStorage.removeItem(DEVICE_KEY) } catch { /* ignore */ }
}

/** Sliding-window limiter: at most `max` calls per `windowMs`. */
export function createRateLimiter(max = 5, windowMs = 1000) {
  const stamps: number[] = []
  return function tryAcquire(): boolean {
    const now = Date.now()
    while (stamps.length && now - stamps[0] > windowMs) stamps.shift()
    if (stamps.length >= max) return false
    stamps.push(now)
    return true
  }
}

export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? ''
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'You appear to be offline.'
  if (/row-level security|permission denied/i.test(msg)) return 'Not allowed — check friendship or device permission.'
  if (/provider is not enabled/i.test(msg)) return 'Google sign-in is not enabled for this project yet. Use the email link, or enable Google in Supabase → Authentication → Providers.'
  if (/jwt|not signed in/i.test(msg)) return 'Please sign in again.'
  return msg || 'Something went wrong.'
}
