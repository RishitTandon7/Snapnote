import { rpc } from './supabase'
import type { Profile } from '../types'

export class UserFacingError extends Error {}

export const isUsernameFree = (username: string) => rpc<boolean>('username_available', { p_username: username })

/** Username uniqueness + friend-code allocation happen atomically on the server. */
export const createProfile = (p: { username: string; displayName: string; avatarColor: string }) =>
  rpc<Profile>('create_profile', { p_username: p.username, p_display_name: p.displayName, p_color: p.avatarColor })

/** Username (with or without @) or friend code. Auto-accepts a crossing request. Returns a UI message. */
export const addFriend = (_me: string, input: string) => {
  if (!input.trim()) throw new UserFacingError('Enter a username or friend code')
  return rpc<string>('add_friend', { q: input })
}

export const acceptRequest = (_me: string, other: string) => rpc('accept_friend', { other })
/** remove friend / decline / cancel request / unblock; also revokes my device permissions for them */
export const removeFriend = (_me: string, other: string) => rpc('remove_friend', { other })
export const blockUser = (_me: string, other: string) => rpc('block_user', { other })
export const unblockUser = (_me: string, other: string) => rpc('remove_friend', { other })
