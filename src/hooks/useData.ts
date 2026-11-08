import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Device, Friendship, Profile } from '../types'

/** re-render every `ms` so "online" badges expire without any data change */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

const bus = new EventTarget()
/** call after a local write so every live list refetches immediately (Realtime still covers other devices) */
export const notifyChanged = () => bus.dispatchEvent(new Event('changed'))

/**
 * Load data, then keep it fresh: refetch (debounced) whenever Realtime reports a change on any of `tables`
 * (RLS filters what each user receives), plus an optional poll as a safety net.
 */
export function useLive<T>(key: string | undefined, load: () => Promise<T>, tables: string[], pollMs?: number): T | null {
  const [data, setData] = useState<T | null>(null)
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load })
  const tableKey = tables.join(',')

  useEffect(() => {
    if (!key) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try { const d = await loadRef.current(); if (alive) setData(d) } catch { /* keep last data */ }
    }
    void run()
    let channel = supabase.channel(`live-${key}-${Math.random().toString(36).slice(2, 8)}`)
    for (const table of tableKey.split(',')) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        clearTimeout(timer)
        timer = setTimeout(run, 250)
      })
    }
    channel.subscribe()
    const onBus = () => void run()
    bus.addEventListener('changed', onBus)
    const poll = pollMs ? setInterval(run, pollMs) : undefined
    return () => {
      bus.removeEventListener('changed', onBus)
      alive = false
      clearTimeout(timer)
      if (poll) clearInterval(poll)
      void supabase.removeChannel(channel)
    }
  }, [key, tableKey, pollMs])

  return data
}

export function useMyDevices(uid: string | undefined) {
  return useLive<Device[]>(
    uid ? `my-devices-${uid}` : undefined,
    async () => {
      const { data, error } = await supabase.from('devices').select('*').eq('user_id', uid!)
      if (error) throw error
      return data as Device[]
    },
    ['devices'],
  )
}

export interface FriendRow extends Friendship { id: string; otherUid: string }

export function useFriendships(uid: string | undefined) {
  return useLive<FriendRow[]>(
    uid ? `friendships-${uid}` : undefined,
    async () => {
      const { data, error } = await supabase.from('friendships').select('*')
      if (error) throw error
      return (data as Friendship[]).map((f) => ({ ...f, id: `${f.user_a}_${f.user_b}`, otherUid: f.user_a === uid ? f.user_b : f.user_a }))
    },
    ['friendships'],
  )
}

/** Profiles of other users (visible via friendship), fetched once and cached for the session. */
const profileCache = new Map<string, Profile>()
export function useProfiles(uids: string[]) {
  const key = [...new Set(uids)].sort().join(',')
  const [, bump] = useState(0)
  useEffect(() => {
    let alive = true
    const missing = key.split(',').filter((u) => u && !profileCache.has(u))
    if (!missing.length) return
    supabase.from('profiles').select('*').in('id', missing).then(({ data }) => {
      ;(data as Profile[] | null)?.forEach((p) => profileCache.set(p.id, p))
      if (alive) bump((n) => n + 1)
    })
    return () => { alive = false }
  }, [key])
  return profileCache
}

export function clearProfileCache() { profileCache.clear() }

/** Display devices of friends that have explicitly allowed me (RLS only returns those). */
export function useFriendDevices(uid: string | undefined) {
  const list = useLive<Device[]>(
    uid ? `friend-devices-${uid}` : undefined,
    async () => {
      const { data, error } = await supabase.from('devices').select('*').neq('user_id', uid!).eq('is_display', true)
      if (error) throw error
      return data as Device[]
    },
    ['devices', 'device_allowed'],
    15_000,
  )
  const byOwner = useMemo(() => {
    const m: Record<string, Device[]> = {}
    for (const d of list ?? []) (m[d.user_id] ??= []).push(d)
    return m
  }, [list])
  return { byOwner, loading: list === null }
}

/** how many snaps (texts / capture requests) I sent since local midnight */
export function useSnapsToday(uid: string | undefined) {
  return useLive<number>(
    uid ? `snaps-${uid}` : undefined,
    async () => {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const { count, error } = await supabase
        .from('messages').select('id', { count: 'exact', head: true })
        .eq('from_user', uid!).in('type', ['text', 'clear']).gte('created_at', start.toISOString())
      if (error) throw error
      return count ?? 0
    },
    ['messages'],
    60_000,
  )
}
