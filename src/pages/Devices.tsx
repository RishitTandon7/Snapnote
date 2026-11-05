import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { supabase } from '../lib/supabase'
import { notifyChanged, useFriendships, useLive, useMyDevices, useNow, useProfiles } from '../hooks/useData'
import { friendlyError, getDeviceId, isOnline } from '../lib/util'
import { offlineFor } from '../lib/duration'
import { Avatar, Empty, ListSkeleton, Toggle } from '../components/ui'
import type { Device } from '../types'

function Permissions({ uid, deviceId }: { uid: string; deviceId: string }) {
  const toast = useToast()
  const rows = useFriendships(uid)
  const friends = (rows ?? []).filter((r) => r.status === 'accepted')
  const profiles = useProfiles(friends.map((f) => f.otherUid))
  const allowedRows = useLive<string[]>(
    `allowed-${deviceId}`,
    async () => {
      const { data, error } = await supabase.from('device_allowed').select('friend_id').eq('device_id', deviceId)
      if (error) throw error
      return (data ?? []).map((r) => r.friend_id as string)
    },
    ['device_allowed'],
  )
  // optimistic overrides so the toggle feels instant
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const allowed = new Set(allowedRows ?? [])
  const isOn = (f: string) => pending[f] ?? allowed.has(f)

  const set = async (friendUid: string, on: boolean) => {
    setPending((p) => ({ ...p, [friendUid]: on }))
    try {
      const res = on
        ? await supabase.from('device_allowed').insert({ device_id: deviceId, owner_id: uid, friend_id: friendUid })
        : await supabase.from('device_allowed').delete().eq('device_id', deviceId).eq('friend_id', friendUid)
      if (res.error && res.error.code !== '23505') throw res.error
    } catch (e) { toast(friendlyError(e), 'error') }
    notifyChanged()
    setPending((p) => { const n = { ...p }; delete n[friendUid]; return n })
  }
  if (!friends.length) return <p className="py-2 text-sm text-ink/40">Add friends first, then choose who may show text here.</p>
  return (
    <div className="space-y-3 pt-2">
      {friends.map((f) => {
        const name = profiles.get(f.otherUid)?.display_name ?? '…'
        return (
          <div key={f.id} className="flex items-center gap-3">
            <Avatar name={name} color={profiles.get(f.otherUid)?.avatar_color ?? '#7c5cff'} url={profiles.get(f.otherUid)?.avatar_url} size={32} />
            <div className="flex-1 text-sm">Let <b>{name}</b> show text on this device</div>
            <Toggle on={isOn(f.otherUid)} onChange={(v) => set(f.otherUid, v)} label={`Allow ${name}`} />
          </div>
        )
      })}
    </div>
  )
}

export function DeviceCard({ d, isThis, now, onChanged }: { d: Device; isThis: boolean; now: number; onChanged: () => void }) {
  const toast = useToast()
  const nav = useNavigate()
  const { user } = useAuth()
  const [name, setName] = useState(d.name)
  const [open, setOpen] = useState(false)
  useEffect(() => setName(d.name), [d.name])
  const online = isOnline(d.last_seen, now)

  const safe = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    try { const { error } = await fn(); if (error) throw error; onChanged() } catch (e) { toast(friendlyError(e), 'error') }
  }
  const rename = () => {
    const n = name.trim().slice(0, 40)
    if (n && n !== d.name) void safe(() => supabase.from('devices').update({ name: n }).eq('id', d.id))
    else setName(d.name)
  }
  const remove = () => {
    if (!confirm(`Remove "${d.name}"?`)) return
    void safe(() => supabase.from('devices').delete().eq('id', d.id)) // permissions cascade
  }

  return (
    <div className="ui-card p-4">
      <div className="flex items-center gap-3">
        <span className={`h-3 w-3 shrink-0 rounded-full ${online ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
        <input className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none focus:text-pink" value={name} maxLength={40}
          onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Device name" />
        {isThis ? <span className="rounded-full bg-ink text-white px-2 py-0.5 text-[10px] font-bold">THIS DEVICE</span>
          : <button className="text-sm text-danger" onClick={remove}>Remove</button>}
      </div>
      <div className="mt-1 pl-6 text-[12px] text-mute">{online ? 'Online now' : offlineFor(d.last_seen, now)}</div>
      <div className="mt-3 flex items-center justify-between">
        <div><div className="text-sm font-medium">Use as display</div><div className="text-xs text-ink/40">Friends you allow can show text here</div></div>
        <Toggle on={d.is_display} onChange={(v) => safe(() => supabase.from('devices').update({ is_display: v }).eq('id', d.id))} label="Use as display" />
      </div>
      {isThis && d.is_display && <button className="ui-btn-dark mt-3 w-full" onClick={() => nav('/display')}>Open display mode</button>}
      <button className="mt-3 text-sm text-accent" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Who can show text on this device?'}</button>
      {open && user && <Permissions uid={user.id} deviceId={d.id} />}
    </div>
  )
}

export function DevicesPage() {
  const { user } = useAuth()
  const uid = user!.id
  const devices = useMyDevices(uid)
  const now = useNow()
  const me = getDeviceId()
  const sorted = [...(devices ?? [])].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name)))
  return (
    <div className="safe-top px-5 pb-28 pt-6 md:px-8 md:pt-8">
      <h1 className="mb-1 text-[26px] font-semibold">Devices</h1>
      <p className="mb-5 text-sm text-ink/50">Every browser you sign in on shows up here.</p>
      {devices === null ? <ListSkeleton rows={2} /> : sorted.length === 0 ? (
        <Empty emoji="📱" title="Registering this device…">It'll appear here in a moment.</Empty>
      ) : (
        <div className="space-y-3 md:grid md:grid-cols-2 md:items-start md:gap-4 md:space-y-0 lg:grid-cols-3">{sorted.map((d) => <DeviceCard key={d.id} d={d} isThis={d.id === me} now={now} onChanged={notifyChanged} />)}</div>
      )}
    </div>
  )
}
