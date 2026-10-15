import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { useFriendDevices, useFriendships, useMyDevices, useNow, useProfiles } from '../hooks/useData'
import { useStartRoom } from '../hooks/useRooms'
import { parseRoomCode } from '../lib/rooms'
import { getDeviceId, isOnline } from '../lib/util'
import { Avatar, Sheet } from './ui'
import { offlineFor } from '../lib/duration'
import { Icon } from './Nav'

export interface QSDevice { id: string; name: string; online: boolean; lastSeen?: string | null }
export interface QSFriend { id: string; name: string; color: string; avatarUrl?: string | null; devices: QSDevice[] }

export interface QuickSendViewProps {
  friends: QSFriend[]
  mine: QSDevice[]
  loading: boolean
  onClose: () => void
  onNewRoom: () => void
  onJoinCode: (raw: string) => void
  onSend: (friendId: string, deviceId: string) => void
  onSendMine: (deviceId: string) => void
  onFindFriends: () => void
}

/** Pure view: "+" → pick a friend/device to send to, or start / join a room. */
export function QuickSendView(p: QuickSendViewProps) {
  const [code, setCode] = useState('')
  const empty = !p.loading && p.friends.length === 0 && p.mine.length === 0
  return (
    <Sheet open onClose={p.onClose} title="Start a snap">
      <div className="flex gap-2">
        <button className="ui-btn-dark flex-1" onClick={p.onNewRoom}><Icon name="room" size={19} />New room</button>
        <div className="flex min-w-0 flex-[1.3] items-center gap-1 rounded-full bg-card2 p-1 pl-4">
          <input className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink/35" placeholder="Room code" value={code}
            autoCapitalize="none" autoCorrect="off" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && p.onJoinCode(code)} />
          <button disabled={!code.trim()} onClick={() => p.onJoinCode(code)} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-30">Join</button>
        </div>
      </div>

      <h3 className="mb-2 mt-5 text-[13px] font-semibold uppercase tracking-wider text-mute">Send to</h3>
      <div className="max-h-[42vh] space-y-2 overflow-y-auto pb-1">
        {p.loading && <div className="ui-sub py-6 text-center">Looking for devices…</div>}

        {p.friends.map((f) => (
          <div key={f.id} className="rounded-3xl bg-card2 p-3">
            <div className="mb-2 flex items-center gap-2.5">
              <Avatar name={f.name} color={f.color} url={f.avatarUrl} size={34} />
              <span className="font-semibold">{f.name}</span>
            </div>
            <div className="space-y-1.5">
              {f.devices.map((d) => <DeviceRow key={d.id} d={d} onClick={() => p.onSend(f.id, d.id)} />)}
            </div>
          </div>
        ))}

        {p.mine.length > 0 && (
          <div className="rounded-3xl bg-card2 p-3">
            <div className="mb-2 text-[15px] font-semibold">My other devices</div>
            <div className="space-y-1.5">{p.mine.map((d) => <DeviceRow key={d.id} d={d} hideState onClick={() => p.onSendMine(d.id)} />)}</div>
          </div>
        )}

        {empty && (
          <div className="rounded-3xl bg-card2 px-5 py-7 text-center">
            <div className="font-semibold">Nobody to send to yet</div>
            <p className="ui-sub mt-1">Add a friend and ask them to allow you on one of their devices — or start a room and share the link.</p>
            <button className="ui-btn-light mt-3" onClick={p.onFindFriends}>Find friends</button>
          </div>
        )}
      </div>
    </Sheet>
  )
}

function DeviceRow({ d, onClick, hideState }: { d: QSDevice; onClick: () => void; hideState?: boolean }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl bg-white px-3.5 py-2.5 text-left shadow-soft transition active:scale-[.98]">
      <i className={`h-2.5 w-2.5 rounded-full ${d.online ? 'bg-online' : 'bg-ink/20'}`} />
      <span className="min-w-0 flex-1 truncate text-[15px]">{d.name}</span>
      {!hideState && <span className="text-[12px] text-mute">{d.online ? 'Online' : offlineFor(d.lastSeen, Date.now())}</span>}
      <Icon name="chevron" size={16} />
    </button>
  )
}

/** data wrapper – mounted only while the sheet is open, so its Realtime hooks only run then */
export function QuickSendSheet({ onClose }: { onClose: () => void }) {
  const { user } = useAuth()
  const uid = user!.id
  const nav = useNavigate()
  const toast = useToast()
  const startRoom = useStartRoom()
  const now = useNow()
  const friendships = useFriendships(uid)
  const { byOwner, loading } = useFriendDevices(uid)
  const myDevices = useMyDevices(uid)

  const friendIds = (friendships ?? []).filter((f) => f.status === 'accepted').map((f) => f.otherUid)
  const profiles = useProfiles(friendIds)
  const me = getDeviceId()
  const go = (path: string) => { onClose(); nav(path, { replace: true }) } // replaces the sheet's own history step

  return (
    <QuickSendView
      loading={loading || friendships === null}
      friends={friendIds.filter((id) => (byOwner[id] ?? []).length > 0).map((id) => ({
        id,
        name: profiles.get(id)?.display_name ?? '…',
        color: profiles.get(id)?.avatar_color ?? '#7c5cff',
        avatarUrl: profiles.get(id)?.avatar_url,
        devices: (byOwner[id] ?? []).map((d) => ({ id: d.id, name: d.name, online: isOnline(d.last_seen, now), lastSeen: d.last_seen })),
      }))}
      mine={(myDevices ?? []).filter((d) => d.id !== me && d.is_display).map((d) => ({ id: d.id, name: d.name, online: isOnline(d.last_seen, now) }))}
      onClose={onClose}
      onNewRoom={() => { onClose(); void startRoom() }}
      onJoinCode={(raw) => {
        const c = parseRoomCode(raw)
        if (!c) toast('Enter a room code like abc-defg-hij, or paste the link', 'error')
        else go(`/r/${c}`)
      }}
      onSend={(fid, did) => go(`/send/${fid}?device=${did}`)}
      onSendMine={(did) => go(`/send/me?device=${did}`)}
      onFindFriends={() => go('/friends')}
    />
  )
}
