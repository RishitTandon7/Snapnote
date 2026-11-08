import { rpc } from './supabase'
import type { Room } from '../types'

export const createRoom = (name: string) => rpc<Room>('create_room', { p_name: name })
export const joinRoom = (code: string) => rpc<string>('join_room', { p_code: code })
export const leaveRoom = (roomId: string) => rpc('leave_room', { p_room: roomId })
export const setRoomDevice = (roomId: string, deviceId: string, on: boolean) =>
  rpc('set_room_device', { p_room: roomId, p_device: deviceId, p_on: on })

export const roomLink = (code: string) => `${window.location.origin}/r/${code}`

/** accepts "abc-defg-hij", "ABC DEFG HIJ" or a full room link */
export function parseRoomCode(input: string): string | null {
  const m = input.trim().toLowerCase().match(/([a-z]{3})[-\s]?([a-z]{4})[-\s]?([a-z]{3})\s*$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

export interface EnterResult { status: 'member' | 'pending' | 'denied'; room_id?: string; name?: string; host_name?: string; /** true = the database has no waiting room yet (update not run), so the old instant join was used */ legacy?: boolean }

/**
 * Open a room link. With the waiting room on, strangers get `pending` until the host admits them.
 * If the database hasn't been updated yet (no enter_room function) this quietly falls back to the old instant join.
 */
export async function enterRoom(code: string): Promise<EnterResult> {
  try {
    return await rpc<EnterResult>('enter_room', { p_code: code })
  } catch (e) {
    if (/could not find the function|enter_room/i.test((e as Error).message) && !/not found or it has ended|full/i.test((e as Error).message)) {
      const id = await joinRoom(code)
      return { status: 'member', room_id: id, legacy: true }
    }
    throw e
  }
}
export const admitRequest = (roomId: string, userId: string) => rpc('admit_request', { p_room: roomId, p_user: userId })
export const denyRequest = (roomId: string, userId: string) => rpc('deny_request', { p_room: roomId, p_user: userId })
export const cancelJoin = (code: string) => rpc('cancel_join', { p_code: code })
export const setRoomApproval = (roomId: string, on: boolean) => rpc('set_room_approval', { p_room: roomId, p_on: on })
