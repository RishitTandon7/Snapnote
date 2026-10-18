import { useEffect } from 'react'
import { rpc, supabase } from '../lib/supabase'
import { defaultDeviceName, getDeviceId, isAutoDeviceName, HEARTBEAT_MS, resetDeviceId } from '../lib/util'

/** Registers this browser as a device and refreshes last_seen (server clock) every 30s while the app is open. */
export function usePresence(uid: string | undefined, username: string | undefined, onRemoved?: () => void) {
  useEffect(() => {
    if (!uid) return
    const id = getDeviceId()
    let timer: ReturnType<typeof setInterval> | undefined
    let stopped = false

    const beat = async () => {
      try {
        const ok = await rpc<boolean>('touch_device', { p_id: id })
        if (!ok && !stopped) {
          // removed from another device → stop; next app start registers afresh
          stopped = true
          if (timer) clearInterval(timer)
          resetDeviceId()
          onRemoved?.()
        }
      } catch { /* offline – try again next tick */ }
    }

    ;(async () => {
      try {
        const { data } = await supabase.from('devices').select('id,name').eq('id', id).maybeSingle()
        if (data && username && data.name !== username && isAutoDeviceName(data.name, username)) {
          await supabase.from('devices').update({ name: username }).eq('id', id) // adopt the username as the name
        }
        if (!data) {
          await supabase.from('devices').insert({ id, user_id: uid, name: defaultDeviceName(username), is_display: false })
        } else await beat()
      } catch { /* retry on next beat */ }
      if (!stopped) timer = setInterval(beat, HEARTBEAT_MS)
    })()

    const onVis = () => { if (document.visibilityState === 'visible' && !stopped) void beat() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [uid, username, onRemoved])
}
