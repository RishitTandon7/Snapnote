import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useActiveRoom } from '../context/ActiveRoom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { notifyChanged } from '../hooks/useData'
import { useJoinRequests, useRooms } from '../hooks/useRooms'
import { playPing } from '../lib/sound'
import { leaveRoom } from '../lib/rooms'
import { friendlyError } from '../lib/util'
import { Icon } from './Nav'

/** Floating "you're still in a room" bar shown above the bottom nav while the room is minimized. */
export function MiniRoomBar() {
  const { active, setActive } = useActiveRoom()
  const { user } = useAuth()
  const nav = useNavigate()
  const toast = useToast()
  const rooms = useRooms(active ? user?.id : undefined)
  const live = rooms?.find((r) => r.id === active?.id)

  // host: people asking to join while this room is minimised
  const waiting = useJoinRequests(live?.id, !!live && live.host_id === user?.id)?.length ?? 0
  const prevWaiting = useRef(0)
  useEffect(() => {
    if (waiting > prevWaiting.current) playPing('request')
    prevWaiting.current = waiting
  }, [waiting])

  // the room ended or I was removed → forget it
  useEffect(() => {
    if (active && rooms && !live) setActive(null)
  }, [active, rooms, live, setActive])

  if (!active || !live) return null

  const leave = async () => {
    if (!confirm(live.host_id === user?.id ? 'End this room for everyone?' : 'Leave this room?')) return
    try { await leaveRoom(live.id); setActive(null); notifyChanged() } catch (e) { toast(friendlyError(e), 'error') }
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+98px)] z-40 flex justify-center px-4">
      <div className="ui-glass rise pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-full py-1.5 pl-2 pr-2">
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink text-white">
          <Icon name="room" size={18} />
          <i className="absolute right-0 top-0 h-3 w-3 rounded-full bg-[#4cd964] ring-2 ring-white" />
        </span>
        <button className="min-w-0 flex-1 text-left leading-tight" onClick={() => nav(`/r/${live.code}`)}>
          <div className="truncate text-[14px] font-semibold">{live.name}</div>
          <div className="text-[12px] text-mute">In room · {live.memberIds.length} {live.memberIds.length === 1 ? 'person' : 'people'}{waiting > 0 && <b className="text-danger"> · {waiting} waiting</b>}</div>
        </button>
        <button onClick={() => nav(`/r/${live.code}`)} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white transition active:scale-95">Return</button>
        <button aria-label="Leave room" onClick={leave} className="flex h-9 w-9 items-center justify-center rounded-full bg-danger/90 text-white transition active:scale-90">
          <Icon name="phoneOff" size={17} />
        </button>
      </div>
    </div>
  )
}
