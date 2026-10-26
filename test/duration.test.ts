import { describe, expect, it } from 'vitest'
import { formatDuration, latestSeen, offlineFor } from '../src/lib/duration'

describe('offline durations', () => {
  it('formats seconds, minutes, hours, days', () => {
    expect(formatDuration(12_000)).toBe('12 sec')
    expect(formatDuration(64_000)).toBe('1 min 4 sec')
    expect(formatDuration(12 * 60_000)).toBe('12 min')
    expect(formatDuration(80 * 60_000)).toBe('1 h 20 min')
    expect(formatDuration(49 * 3600_000)).toBe('2 days')
    expect(formatDuration(-5)).toBe('0 sec')
  })
  it('offlineFor and latestSeen', () => {
    const now = Date.parse('2026-01-01T00:10:00Z')
    expect(offlineFor('2026-01-01T00:00:00Z', now)).toBe('Offline for 10 min')
    expect(offlineFor(null, now)).toBe('Offline')
    expect(latestSeen([{ last_seen: '2026-01-01T00:00:00Z' }, { last_seen: '2026-01-01T00:05:00Z' }, { last_seen: null }])).toBe('2026-01-01T00:05:00Z')
    expect(latestSeen([])).toBeNull()
  })
})
