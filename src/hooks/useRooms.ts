import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createRoom } from '../lib/rooms'
import { friendlyError } from '../lib/util'
import { useToast } from '../context/Toast'
import { useAuth } from '../context/AuthContext'
import { notifyChanged, useLive } from './useData'
import type { Device, Room, RoomDevice, RoomMember } from '../types'

export interface RoomWithMembers extends Room { memberIds: string[] }

/** rooms I'm in (RLS only returns those), with member ids */
export function useRooms(uid: string | undefined) {
  return useLive<RoomWithMembers[]>(
    uid ? `rooms-${uid}` : undefined,
    async () => {
      const { data: rooms, error } = await supabase.from('rooms').select('*').order('created_at', { ascending: false })
      if (error) throw error
      const list = (rooms ?? []) as Room[]
      if (!list.length) return []
      const { data: members } = await supabase.from('room_members').select('*').in('room_id', list.map((r) => r.id))
      const by = new Map<string, string[]>()
      ;((members ?? []) as RoomMember[]).forEach((m) => by.set(m.room_id, [...(by.get(m.room_id) ?? []), m.user_id]))
      return list.map((r) => ({ ...r, memberIds: by.get(r.id) ?? [] }))
    },
    ['rooms', 'room_members'],
    20_000,
  )
}

export interface RoomData { room: Room | null; members: RoomMember[]; roomDevices: RoomDevice[]; devices: Device[] }

export function useRoom(roomId: string | undefined) {
  return useLive<RoomData>(
    roomId ? `room-${roomId}` : undefined,
    async () => {
      const { data: room } = await supabase.from('rooms').select('*').eq('id', roomId!).maybeSingle()
      if (!room) return { room: null, members: [], roomDevices: [], devices: [] }
      const [m, rd] = await Promise.all([
        supabase.from('room_members').select('*').eq('room_id', roomId!),
        supabase.from('room_devices').select('*').eq('room_id', roomId!),
      ])
      const roomDevices = (rd.data ?? []) as RoomDevice[]
      const ids = roomDevices.map((d) => d.device_id)
      const devices = ids.length ? (((await supabase.from('devices').select('*').in('id', ids)).data ?? []) as Device[]) : []
      return { room: room as Room, members: (m.data ?? []) as RoomMember[], roomDevices, devices }
    },
    ['rooms', 'room_members', 'room_devices', 'devices'],
    15_000,
  )
}

/** create a room and jump into it */
export function useStartRoom() {
  const nav = useNavigate()
  const toast = useToast()
  const { profile } = useAuth()
  return useCallback(async (opts?: { party?: boolean }) => {
    try {
      const r = await createRoom(opts?.party ? `${profile?.display_name ?? 'My'}'s watch party` : `${profile?.display_name ?? 'My'}'s room`)
      notifyChanged()
      nav(`/r/${r.code}${opts?.party ? '?party=1' : ''}`)
    } catch (e) { toast(friendlyError(e), 'error') }
  }, [nav, toast, profile])
}

export interface JoinRequest { user_id: string; created_at: string }

/** people waiting to be let into this room (host only; empty if the waiting-room update isn't installed) */
export function useJoinRequests(roomId: string | undefined, enabled: boolean) {
  return useLive<JoinRequest[]>(
    roomId && enabled ? `requests-${roomId}` : undefined,
    async () => {
      const { data, error } = await supabase.from('room_requests').select('user_id,created_at').eq('room_id', roomId!).eq('status', 'pending').order('created_at')
      if (error) return []
      return (data ?? []) as JoinRequest[]
    },
    ['room_requests'],
    4000,
  )
}
