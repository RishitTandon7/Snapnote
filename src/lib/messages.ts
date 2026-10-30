import { rpc, supabase } from './supabase'
import type { Message, MessageType } from '../types'

export interface SendArgs {
  fromDeviceId: string
  toUid: string
  toDeviceId: string
  type: MessageType
  body?: string
  imageDataUrl?: string
  replyTo?: string
}

/** text | clear | capture. Server checks friendship + per-device permission, sets sender name, rate-limits. */
export const sendMessage = (a: SendArgs) =>
  rpc<string>('send_message', {
    p_to_user: a.toUid, p_to_device: a.toDeviceId, p_from_device: a.fromDeviceId, p_type: a.type, p_body: a.body ?? '',
  })

/** "Show as I type": the server overwrites one row per (sender, device). */
export const sendLiveText = (a: Omit<SendArgs, 'type'>) =>
  rpc('send_live', { p_to_user: a.toUid, p_to_device: a.toDeviceId, p_from_device: a.fromDeviceId, p_body: a.body ?? '' })

/** Photo goes back inside the row as a base64 JPEG (no Storage), only as a reply to a capture request. */
export const sendPhoto = (a: Omit<SendArgs, 'type'> & { replyTo: string; imageDataUrl: string }) =>
  rpc<string>('send_photo', {
    p_to_user: a.toUid, p_to_device: a.toDeviceId, p_from_device: a.fromDeviceId,
    p_reply_to: a.replyTo, p_body: a.body ?? '', p_image: a.imageDataUrl,
  })

export const deleteMessage = (id: string) => supabase.from('messages').delete().eq('id', id)

/**
 * Listen for rows addressed to one device.
 * Realtime is only a "nudge": large photo rows can exceed Realtime's payload limit, so photos are
 * always re-fetched by id; and a catch-up query on (re)subscribe + a slow poll covers missed events.
 * Rows are de-duplicated by (id, created_at) so a live-typing row re-fires whenever it is rewritten.
 */
export function watchMessages(
  deviceId: string,
  onRow: (m: Message) => void,
  onStatus?: (connected: boolean) => void,
) {
  const seen = new Map<string, string>()
  const handle = (m: Message) => {
    if (seen.get(m.id) === m.created_at) return
    seen.set(m.id, m.created_at)
    onRow(m)
  }
  const refresh = async () => {
    const { data } = await supabase
      .from('messages').select('*').eq('to_device', deviceId)
      .gt('expire_at', new Date().toISOString()).order('created_at', { ascending: true })
    ;(data as Message[] | null)?.forEach(handle)
  }
  const channel = supabase
    .channel(`msg-${deviceId}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `to_device=eq.${deviceId}` }, async (p) => {
      if (p.eventType === 'DELETE') return
      const row = p.new as Message
      if (row.type === 'photo') {
        const { data } = await supabase.from('messages').select('*').eq('id', row.id).maybeSingle()
        if (data) handle(data as Message)
      } else handle(row)
    })
    .subscribe((status) => {
      onStatus?.(status === 'SUBSCRIBED')
      if (status === 'SUBSCRIBED') void refresh()
    })
  const poll = setInterval(refresh, 15_000)
  return {
    refresh,
    stop: () => { clearInterval(poll); void supabase.removeChannel(channel) },
  }
}
