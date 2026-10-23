/** "12 sec", "5 min", "1 h 20 min", "2 days" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} sec`
  const m = Math.floor(s / 60)
  if (m < 60) { const r = s % 60; return r && m < 10 ? `${m} min ${r} sec` : `${m} min` }
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`
  const d = Math.floor(h / 24)
  return `${d} day${d > 1 ? 's' : ''}`
}

/** "Offline for 12 min", based on the last heartbeat we saw (falls back to plain "Offline") */
export function offlineFor(lastSeen: string | null | undefined, now: number): string {
  if (!lastSeen) return 'Offline'
  return `Offline for ${formatDuration(now - Date.parse(lastSeen))}`
}

/** the most recent heartbeat among several devices */
export function latestSeen(list: { last_seen: string | null }[] | undefined): string | null {
  const times = (list ?? []).map((d) => d.last_seen).filter((t): t is string => !!t)
  return times.length ? times.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null
}
