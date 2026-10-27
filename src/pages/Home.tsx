import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useQuickSend } from '../context/QuickSend'
import { useFriendDevices, useFriendships, useMyDevices, useNow, useProfiles, useSnapsToday } from '../hooks/useData'
import { useRooms, useStartRoom } from '../hooks/useRooms'
import { parseRoomCode } from '../lib/rooms'
import { useCallFriend } from '../components/CallManager'
import { getDeviceId, isOnline } from '../lib/util'
import { latestSeen, formatDuration } from '../lib/duration'
import { Avatar, Skeleton } from '../components/ui'
import { AvatarStack, CountDot, Icon, RoundBtn, type IconName } from '../components/Nav'
import { DeviceCard } from './Devices'
import { InstallCard } from '../components/InstallCard'
import { PushPrompt } from '../components/PushPrompt'
import { ThemeButton } from '../components/ThemeButton'
import type { Profile } from '../types'

const TINTS = ['bg-tint-pink', 'bg-tint-blue', 'bg-tint-green'] as const

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good Morning' : h < 18 ? 'Good Afternoon' : 'Good Evening'
}

export interface HomeFriend { id: string; name: string; color: string; avatarUrl?: string | null; devices: number; online: boolean; /** last heartbeat of their most recent device */ lastSeen?: string | null }
export interface HomeRoom { id: string; code: string; name: string; memberIds: string[]; isHost: boolean }

export interface HomeViewProps {
  name: string
  /** a friend's display device is online right now */
  live: boolean
  hasRequests: boolean
  friends: HomeFriend[] | null
  stats: { friendsOnline: number; devices: number; snaps: number }
  rooms: HomeRoom[] | null
  roomProfiles: Map<string, Profile>
  devicesSection: ReactNode
  onMenu: () => void
  onBell: () => void
  onStart: () => void
  onViewAll: () => void
  onManageDevices: () => void
  onSendTo: (friendId: string) => void
  /** ring a friend (video call) */
  onCall: (friend: HomeFriend) => void
  onNewRoom: () => void
  onWatchParty: () => void
  onJoinCode: (code: string) => void
  onOpenRoom: (code: string) => void
}

/** Pure view of the Home screen (light glassmorphism, pastel cards, no photos). */
export function HomeView(p: HomeViewProps) {
  const [allFriends, setAllFriends] = useState(false)
  return (
    <div className="safe-top px-5 pb-36 pt-5 md:px-8 md:pt-8">
      {/* header */}
      <div className="mb-5 flex items-center gap-3">
        <RoundBtn icon="menu" label="Settings" onClick={p.onMenu} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[19px] font-semibold leading-tight">{greeting()}, {p.name}</h1>
          <p className="ui-sub">Ready to send a snap?</p>
        </div>
        <ThemeButton />
        <RoundBtn icon="bell" label="Friend requests" onClick={p.onBell} dot={p.hasRequests} />
      </div>

      <div className="lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:items-start lg:gap-10 xl:grid-cols-[440px_minmax(0,1fr)]">
      <div>
      <InstallCard />
      <PushPrompt />

      {/* hero – abstract gradient, blurred blobs, lens-ring graphic (no photo) */}
      <div className="relative mb-4 h-[318px] overflow-hidden rounded-[32px] shadow-soft"
        style={{ background: 'linear-gradient(135deg, rgb(var(--violet)) 0%, rgb(var(--blush)) 100%)' }}>
        <div className="absolute -left-10 top-20 h-48 w-48 rounded-full bg-[#4f2fe0]/50 blur-3xl" />
        <div className="absolute -right-8 -top-10 h-56 w-56 rounded-full bg-white/35 blur-3xl" />
        <div className="absolute -bottom-16 right-10 h-52 w-52 rounded-full bg-[#ff9ad5]/60 blur-3xl" />
        {/* depth like the reference: soft bokeh + a floor shadow, and the brand S as the "subject" */}
        <div className="absolute right-[22%] top-[9%] h-16 w-16 rounded-full bg-white/25 blur-[6px]" />
        <div className="absolute right-[3%] top-[30%] h-10 w-10 rounded-full bg-white/20 blur-[4px]" />
        <div className="absolute bottom-[14%] right-[40%] h-24 w-24 rounded-full bg-[#ffb3e0]/30 blur-[10px]" />
        <div className="absolute -right-4 bottom-1 h-10 w-[56%] rounded-[100%] bg-[#1b1146]/45 blur-xl" />
        <img src="/s-mark.png" alt="" draggable={false}
          className="pointer-events-none absolute -bottom-3 -right-2 w-[52%] select-none drop-shadow-[0_22px_26px_rgba(20,10,70,.5)]" />
        {/* darken the text side for contrast, like the reference's photo overlay */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#1b1146]/60 via-[#1b1146]/10 to-transparent" />
        <div className="relative flex h-full flex-col p-5">
          <div className="h-[34px]">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/85 px-3.5 py-1.5 text-[14px] font-medium text-ink backdrop-blur">
              <span className={`h-2.5 w-2.5 rounded-full ${p.live ? 'bg-online' : 'bg-ink/30'}`} />{p.live ? 'Live Now' : 'Ready'}
            </span>
          </div>
          <h2 className="mt-4 text-[30px] font-semibold leading-[1.12] text-white">
            Snap.<br /><span className="text-coral">Send.</span><br />Show.
          </h2>
          <p className="mt-2.5 max-w-[10.5rem] text-[14.5px] leading-snug text-white/90 min-[400px]:max-w-[13rem]">Your words, live on their screen.</p>
          <button onClick={p.onStart} className="mt-auto flex w-fit items-center gap-3 rounded-full bg-white py-2 pl-2 pr-8 text-[16.5px] font-semibold text-ink shadow-lg transition active:scale-95">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink text-white"><Icon name="camera" size={22} /></span>
            Start a Snap
          </button>
        </div>
      </div>

      {/* stat chips */}
      <div className="grid grid-cols-3 gap-3">
        <Stat icon="users" color="text-[#3fbf6b]" value={p.stats.friendsOnline} label="Friends Online" />
        <Stat icon="device" color="text-[#ee4b5e]" value={p.stats.devices} label="Devices" />
        <Stat icon="star" color="text-[#f2b01e]" value={p.stats.snaps} label="Snaps Today" />
      </div>

      {/* quick actions: so Home is never empty */}
      <div className="ui-section"><h2 className="ui-h2">Quick Actions</h2></div>
      <button onClick={p.onWatchParty} className="rise relative mb-3 flex w-full items-center gap-4 overflow-hidden rounded-[26px] p-4 text-left text-white shadow-soft transition active:scale-[.98]"
        style={{ background: 'linear-gradient(135deg, rgb(var(--violet)) 0%, rgb(var(--blush)) 100%)' }}>
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/25 text-3xl backdrop-blur" aria-hidden>🍿</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[19px] font-semibold leading-tight">Watch party</span>
          <span className="mt-0.5 block text-[13.5px] leading-snug text-white/90">Stream a movie or a match to your friends, live, with sound.</span>
        </span>
        <span className="flex h-10 shrink-0 items-center rounded-full bg-white px-4 text-[14px] font-semibold text-[#14161f]">Start</span>
      </button>
      <div className="grid grid-cols-2 gap-3">
        <button onClick={p.onNewRoom} className="rise flex flex-col items-start gap-3 rounded-[22px] bg-tint-blue p-4 text-left transition active:scale-[.97]">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-soft"><Icon name="room" size={20} /></span>
          <span><span className="block text-[16px] font-semibold leading-tight">New room</span><span className="text-[13px] text-mute">Start a video call</span></span>
        </button>
        <button onClick={p.onViewAll} className="rise flex flex-col items-start gap-3 rounded-[22px] bg-tint-green p-4 text-left transition active:scale-[.97]">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-soft"><Icon name="users" size={20} /></span>
          <span><span className="block text-[16px] font-semibold leading-tight">Call a friend</span><span className="text-[13px] text-mute">Tap the camera on a card</span></span>
        </button>
      </div>
      <JoinByCode onJoin={p.onJoinCode} />

      </div>
      <div>
      {/* friends */}
      <div className="ui-section">
        <h2 className="ui-h2">Your Friends</h2>
        {(p.friends?.length ?? 0) > 2 && <button className="ui-link md:hidden" onClick={() => setAllFriends((v) => !v)}>{allFriends ? 'Show Less' : 'View All'}</button>}
      </div>
      {p.friends === null ? (
        <div className="flex gap-3"><Skeleton className="h-[200px] w-40 shrink-0 !rounded-[26px]" /><Skeleton className="h-[200px] w-40 shrink-0 !rounded-[26px]" /></div>
      ) : p.friends.length === 0 ? (
        <div className="rise rounded-[26px] bg-white/60 p-6 text-center backdrop-blur">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-soft"><Icon name="users" /></div>
          <div className="font-semibold">No friends yet</div>
          <p className="ui-sub mt-1">Add someone by username, friend code or QR to start sending snaps.</p>
          <button className="ui-btn-dark mt-3" onClick={p.onViewAll}>Add a friend</button>
        </div>
      ) : (
        <div className={allFriends ? 'grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3' : '-mx-5 flex snap-x scroll-pl-5 gap-3 overflow-x-auto px-5 pb-2 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0 lg:grid-cols-2 xl:grid-cols-3'}>
          {p.friends.map((f, i) => (
            <div key={f.id} role="button" tabIndex={0} aria-label={`Send to ${f.name}`}
              onClick={() => { if (f.devices > 0) p.onSendTo(f.id) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && f.devices > 0) p.onSendTo(f.id) }}
              className={`rise flex min-h-[200px] cursor-pointer snap-start flex-col rounded-[26px] p-4 text-left transition active:scale-[.97] ${f.devices === 0 ? 'opacity-90' : ''} ${TINTS[i % TINTS.length]} ${allFriends ? '' : 'w-[160px] shrink-0 md:w-auto'}`}>
              <div className="flex items-start justify-between">
                <Icon name="user" size={24} />
                <span className="flex gap-1.5 pt-1"><i className={`h-3 w-3 rounded-full ${f.online ? 'bg-online' : 'bg-ink/20'}`} /></span>
              </div>
              <div className="mt-5 truncate text-[18px] font-semibold leading-tight">{f.name}</div>
              <div className="mb-3 text-[14px] text-mute">{f.devices === 0 ? 'No devices yet' : f.online ? 'Online now' : f.lastSeen ? `Offline ${formatDuration(Date.now() - Date.parse(f.lastSeen))}` : `${f.devices} ${f.devices === 1 ? 'device' : 'devices'}`}</div>
              <div className="flex items-center">
                <div className="rounded-full ring-2 ring-white"><Avatar name={f.name} color={f.color} url={f.avatarUrl} size={32} /></div>
                {f.devices > 0 && <CountDot n={f.devices} size={32} />}
              </div>
              <div className="mt-auto flex items-center justify-between pt-4 text-[15px] font-medium">
                {f.devices === 0 ? <span className="text-[13px] text-mute">No screen yet</span> : 'Send'}
                <span className="flex items-center gap-1.5">
                  <button aria-label={`Call ${f.name}`} title="Video call" onClick={(e) => { e.stopPropagation(); p.onCall(f) }}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white shadow-soft transition active:scale-90"><Icon name="room" size={17} /></button>
                  {f.devices > 0 && <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white shadow-soft"><Icon name="plus" size={17} /></span>}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* rooms (only when you're in some) */}
      {(p.rooms?.length ?? 0) > 0 && (
        <>
          <div className="ui-section"><h2 className="ui-h2">Your Rooms</h2></div>
          <div className="-mx-5 flex snap-x scroll-pl-5 gap-3 overflow-x-auto px-5 pb-2 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0 lg:grid-cols-2 xl:grid-cols-3">
            {p.rooms!.map((r, i) => (
              <button key={r.id} onClick={() => p.onOpenRoom(r.code)}
                className={`rise flex min-h-[150px] w-[160px] shrink-0 snap-start md:w-auto flex-col rounded-[26px] p-4 text-left transition active:scale-[.97] ${TINTS[(i + 1) % TINTS.length]}`}>
                <div className="flex items-start justify-between">
                  <Icon name="room" size={24} />
                  <span className="flex gap-1.5 pt-1"><i className="h-3 w-3 rounded-full bg-online" />{r.isHost && <i className="h-3 w-3 rounded-full bg-danger" />}</span>
                </div>
                <div className="mt-4 truncate text-[17px] font-semibold leading-tight">{r.name}</div>
                <div className="mb-2 text-[14px] text-mute">{r.memberIds.length} {r.memberIds.length === 1 ? 'member' : 'members'}</div>
                <AvatarStack ids={r.memberIds} profiles={p.roomProfiles} max={3} size={28} total />
              </button>
            ))}
          </div>
        </>
      )}

      {/* devices */}
      <div className="ui-section">
        <h2 className="ui-h2">Your Devices</h2>
        <button className="ui-link" onClick={p.onManageDevices}>Manage</button>
      </div>
      {p.devicesSection}
      </div>
      </div>
    </div>
  )
}

function JoinByCode({ onJoin }: { onJoin: (code: string) => void }) {
  const [v, setV] = useState('')
  const code = parseRoomCode(v)
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (code) onJoin(code) }} className="rise mt-3 flex items-center gap-2 rounded-[22px] bg-white p-2 pl-4 shadow-soft">
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Have a room code or link?" aria-label="Room code or link"
        className="min-w-0 flex-1 bg-transparent py-2 text-[15px] outline-none placeholder:text-mute" />
      <button type="submit" disabled={!code} className="rounded-full bg-ink px-5 py-2.5 text-[14px] font-semibold text-white transition active:scale-95 disabled:opacity-30">Join</button>
    </form>
  )
}

function Stat({ icon, color, value, label }: { icon: IconName; color: string; value: number; label: string }) {
  return (
    <div className="rounded-[20px] bg-white p-3 shadow-soft min-[360px]:p-3.5">
      <div className="flex items-center gap-1.5">
        <span className={color}><Icon name={icon} size={19} /></span>
        <span className="text-[20px] font-semibold leading-none">{value}</span>
      </div>
      <div className="mt-1.5 text-[12px] leading-tight text-mute min-[360px]:text-[13px]">{label}</div>
    </div>
  )
}

export function HomePage() {
  const { user, profile } = useAuth()
  const uid = user!.id
  const nav = useNavigate()
  const { open } = useQuickSend()
  const callFriend = useCallFriend()
  const startRoom = useStartRoom()
  const now = useNow()
  const rooms = useRooms(uid)
  const friendships = useFriendships(uid)
  const { byOwner } = useFriendDevices(uid)
  const myDevices = useMyDevices(uid)
  const snaps = useSnapsToday(uid)

  const friendIds = (friendships ?? []).filter((f) => f.status === 'accepted').map((f) => f.otherUid)
  const profiles = useProfiles([...friendIds, ...(rooms ?? []).flatMap((r) => r.memberIds)])
  const friends: HomeFriend[] | null = friendships === null ? null : friendIds.map((id) => ({
    id,
    name: profiles.get(id)?.display_name ?? '…',
    color: profiles.get(id)?.avatar_color ?? '#7c5cff',
    avatarUrl: profiles.get(id)?.avatar_url,
    devices: (byOwner[id] ?? []).length,
    online: (byOwner[id] ?? []).some((d) => isOnline(d.last_seen, now)),
    lastSeen: latestSeen(byOwner[id]),
  }))
  const friendsOnline = friends?.filter((f) => f.online).length ?? 0
  const me = getDeviceId()
  const sorted = [...(myDevices ?? [])].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name)))

  return (
    <HomeView
      name={profile?.display_name ?? ''}
      live={friendsOnline > 0}
      hasRequests={(friendships ?? []).some((f) => f.status === 'pending' && f.requester !== uid)}
      friends={friends}
      stats={{ friendsOnline, devices: myDevices?.length ?? 0, snaps: snaps ?? 0 }}
      rooms={rooms && rooms.map((r) => ({ id: r.id, code: r.code, name: r.name, memberIds: r.memberIds, isHost: r.host_id === uid }))}
      roomProfiles={profiles}
      devicesSection={
        myDevices === null ? <Skeleton className="h-28 w-full !rounded-[28px]" />
          : <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 lg:grid-cols-1 xl:grid-cols-2">{sorted.map((d) => <DeviceCard key={d.id} d={d} isThis={d.id === me} now={now} onChanged={() => undefined} />)}</div>
      }
      onMenu={() => nav('/settings')}
      onBell={() => nav('/friends')}
      onStart={open}
      onViewAll={() => nav('/friends')}
      onManageDevices={() => nav('/devices')}
      onSendTo={(id) => nav(`/send/${id}`)}
      onCall={(f) => void callFriend(f)}
      onNewRoom={() => void startRoom()}
      onWatchParty={() => void startRoom({ party: true })}
      onJoinCode={(c) => nav(`/r/${c}`)}
      onOpenRoom={(c) => nav(`/r/${c}`)}
    />
  )
}
