import { rpc } from './supabase'

export interface CallRow {
  id: string
  caller: string
  callee: string
  room_id: string
  room_code: string
  status: 'ringing' | 'accepted' | 'declined' | 'cancelled'
  created_at: string
}

/** how long a phone rings before the call counts as unanswered */
export const RING_MS = 45_000

export const startCall = (friendId: string) => rpc<CallRow>('start_call', { p_friend: friendId })
export const acceptCall = (id: string) => rpc<string>('accept_call', { p_call: id })
export const declineCall = (id: string) => rpc('decline_call', { p_call: id })
export const cancelCall = (id: string) => rpc('cancel_call', { p_call: id })

/** true / false = known; null = the database update isn't installed (treat as "maybe") */
export async function friendCanRing(friendId: string): Promise<boolean | null> {
  try { return await rpc<boolean>('friend_can_ring', { p_friend: friendId }) } catch { return null }
}

export const isRinging = (c: CallRow, now: number): boolean => c.status === 'ringing' && now - Date.parse(c.created_at) < RING_MS

/** the friendly version of a database error from the calling functions */
export function callError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e)
  if (/could not find the function|start_call|relation .*calls/i.test(m) && !/only call friends|Already ringing/i.test(m))
    return 'Calling is not set up yet: run supabase/update-calling.sql in the Supabase SQL Editor.'
  return m
}
