export interface Profile {
  id: string
  username: string
  display_name: string
  avatar_color: string
  /** the Google account's profile picture (null/absent = show the initial) */
  avatar_url?: string | null
  friend_code: string
}

export interface Device {
  id: string
  user_id: string
  name: string
  is_display: boolean
  last_seen: string | null
}

export type FriendStatus = 'pending' | 'accepted' | 'blocked'

export interface Friendship {
  user_a: string
  user_b: string
  requester: string
  status: FriendStatus
  blocked_by: string | null
}

export interface Room {
  id: string
  code: string
  name: string
  host_id: string
  /** waiting room on: people wait for the host to let them in (absent until the database update is applied) */
  require_approval?: boolean
  created_at: string
  expires_at: string
}
export interface RoomMember { room_id: string; user_id: string }
export interface RoomDevice { room_id: string; device_id: string; user_id: string }

export type MessageType = 'text' | 'clear' | 'capture' | 'photo'

export interface Message {
  id: string
  from_user: string
  from_name: string
  from_device: string | null
  to_user: string
  to_device: string
  type: MessageType
  body: string
  image_data_url: string
  reply_to: string | null
  live: boolean
  created_at: string
  expire_at: string
}
