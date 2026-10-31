import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { notifyChanged, useLive, useNow, useProfiles } from '../hooks/useData'
import { supabase } from '../lib/supabase'
import { acceptCall, callError, cancelCall, declineCall, friendCanRing, isRinging, startCall, type CallRow } from '../lib/calls'
import { startRinging, stopRinging } from '../lib/sound'
import { hasAndroidApp, refreshPush, registerAndroidApp, ringPush } from '../lib/push'
import { friendlyError } from '../lib/util'
import { leaveRoom } from '../lib/rooms'
import { Avatar } from './ui'

/** ring a friend and open the call */
export function useCallFriend() {
  const nav = useNavigate()
  const toast = useToast()
  return useCallback(async (f: { id: string; name: string; online: boolean; lastSeen?: string | null }) => {
    const friendId = f.id, name = f.name
    try {
      const c = await startCall(friendId)
      void ringPush(c.id)   // wake their phone even if Snapnote is closed there
      notifyChanged()
      toast(`Calling ${name ?? 'your friend'}…`, 'info', { ms: 3000 })
      // their app is closed: only worth a hint when their phone can NOT be woken up
      if (!f.online) void friendCanRing(friendId).then((can) => {
        if (can === false) toast(`${name} isn't in the app and hasn't turned on call notifications, so the phone may not ring. Ask them to open Snapnote → Settings → Calls → Turn on.`, 'info', { ms: 9000 })
      })
      nav(`/r/${c.room_code}?call=1`)   // ?call=1: camera and mic start ON, like a real call
    } catch (e) { toast(callError(e) || friendlyError(e), 'error', { ms: 8000 }) }
  }, [nav, toast])
}

/**
 * Lives for as long as you're signed in:
 *  - someone calls you → a ringing card with Accept / Decline (ring sound + vibration)
 *  - you call someone → tells you if they declined or didn't pick up
 */
export function CallManager() {
  const { user } = useAuth()
  const uid = user!.id
  const nav = useNavigate()
  const { pathname } = useLocation()
  const toast = useToast()
  const now = useNow(1000)
  useEffect(() => {
    // opened by the Snapnote Android app: it hands over this phone's push token
    const url = new URL(window.location.href)
    const token = url.searchParams.get('fcm')
    if (token) { url.searchParams.delete('fcm'); window.history.replaceState(null, '', url.pathname + url.search + url.hash); void registerAndroidApp(token) }
    else if (!hasAndroidApp()) void refreshPush()   // keep this phone's notification subscription fresh
  }, [uid])
  const calls = useLive<CallRow[]>(
    `calls-${uid}`,
    async () => {
      const { data, error } = await supabase.from('calls').select('*').order('created_at', { ascending: false }).limit(20)
      if (error) return []
      return (data ?? []) as CallRow[]
    },
    ['calls'],
    4000,
  )
  const incoming = (calls ?? []).find((c) => c.callee === uid && isRinging(c, now)) ?? null
  const profiles = useProfiles(incoming ? [incoming.caller] : [])
  const caller = incoming ? profiles.get(incoming.caller) : undefined

  // ring while a call is coming in
  useEffect(() => {
    if (!incoming) return
    startRinging()
    return () => stopRinging()
  }, [incoming?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /** nobody picked up: close the empty room and, if I'm still sitting in it, take me home */
  const endUnanswered = (c: CallRow) => {
    void leaveRoom(c.room_id).then(() => notifyChanged()).catch(() => undefined)
    if (pathname.toLowerCase().startsWith(`/r/${c.room_code}`)) nav('/', { replace: true })
  }
  // tapped "Answer" on the call notification: join straight away (no second tap)
  const answerById = useCallback(async (id: string) => {
    stopRinging()
    try { const code = await acceptCall(id); notifyChanged(); nav(`/r/${code}?call=1`) }
    catch (e) { toast(callError(e) || friendlyError(e), 'error') }
  }, [nav, toast])
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('answer')
    if (fromUrl) { window.history.replaceState(null, '', window.location.pathname); void answerById(fromUrl) }
    const onMsg = (e: MessageEvent) => { const d = e.data as { type?: string; call?: string } | null; if (d?.type === 'answer-call' && d.call) void answerById(d.call) }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [answerById])

  // outgoing calls: say what happened
  const seen = useRef(new Map<string, string>())
  const outProfiles = useProfiles((calls ?? []).filter((c) => c.caller === uid).map((c) => c.callee))
  useEffect(() => {
    for (const c of calls ?? []) {
      if (c.caller !== uid) continue
      const prev = seen.current.get(c.id)
      const name = outProfiles.get(c.callee)?.display_name ?? 'They'
      if (prev === 'ringing' && c.status === 'declined') { toast(`${name} declined the call`, 'info', { ms: 5000 }); endUnanswered(c) }
      if (prev === 'ringing' && c.status === 'accepted') toast(`${name} picked up`, 'success', { ms: 3000 })
      if (c.status === 'ringing' && !isRinging(c, now)) {
        if (seen.current.get(c.id) !== 'missed') { seen.current.set(c.id, 'missed'); toast(`${name} didn't answer`, 'info', { ms: 5000 }); void cancelCall(c.id).catch(() => undefined); endUnanswered(c) }
        continue
      }
      seen.current.set(c.id, c.status)
    }
  }, [calls, now, uid, outProfiles, toast]) // eslint-disable-line react-hooks/exhaustive-deps

  const outgoing = (calls ?? []).find((c) => c.caller === uid && isRinging(c, now)) ?? null
  const calleeProfile = useProfiles(outgoing ? [outgoing.callee] : []).get(outgoing?.callee ?? '')
  if (outgoing && !incoming) {
    const secs = Math.max(0, Math.round((now - Date.parse(outgoing.created_at)) / 1000))
    return (
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[96] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+10px)]" role="status">
        <div className="rise pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[28px] bg-ink p-3 pr-3.5 text-white shadow-glass">
          <span className="relative flex h-12 w-12 shrink-0 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-white/25" />
            <Avatar name={calleeProfile?.display_name ?? '?'} color={calleeProfile?.avatar_color ?? '#7c5cff'} url={calleeProfile?.avatar_url} size={48} />
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[16px] font-semibold">Calling {calleeProfile?.display_name ?? '…'}</div>
            <div className="text-[13px] text-white/65">Ringing · {secs}s</div>
          </div>
          <button onClick={() => { void cancelCall(outgoing.id).then(() => notifyChanged()).catch(() => undefined) }} className="rounded-full bg-danger px-4 py-2.5 text-[13px] font-semibold transition active:scale-95">Cancel</button>
        </div>
      </div>
    )
  }
  if (!incoming) return null
  const name = caller?.display_name ?? 'Someone'
  const answer = async () => {
    stopRinging()
    try { const code = await acceptCall(incoming.id); notifyChanged(); nav(`/r/${code}?call=1`) }
    catch (e) { toast(callError(e) || friendlyError(e), 'error') }
  }
  const decline = async () => { stopRinging(); try { await declineCall(incoming.id); notifyChanged() } catch { /* ignore */ } }
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[96] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+10px)]" role="alertdialog" aria-label={`${name} is calling`}>
      <div className="rise pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[28px] bg-ink p-3 pr-3.5 text-white shadow-glass">
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-white/25" />
          <Avatar name={name} color={caller?.avatar_color ?? '#7c5cff'} url={caller?.avatar_url} size={48} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[16px] font-semibold">{name}</div>
          <div className="text-[13px] text-white/65">Snapnote video call…</div>
        </div>
        <button onClick={() => void decline()} aria-label="Decline" className="flex h-12 w-12 items-center justify-center rounded-full bg-danger text-lg transition active:scale-90">✕</button>
        <button onClick={() => void answer()} aria-label="Accept" className="flex h-12 w-12 items-center justify-center rounded-full bg-[#34c759] text-lg transition active:scale-90">📞</button>
      </div>
    </div>
  )
}
