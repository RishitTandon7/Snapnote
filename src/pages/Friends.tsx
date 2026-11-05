import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useGoBack } from '../lib/nav'
import { QRCodeSVG } from 'qrcode.react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { notifyChanged, useFriendDevices, useFriendships, useMyDevices, useNow, useProfiles } from '../hooks/useData'
import { acceptRequest, addFriend, blockUser, removeFriend } from '../lib/friends'
import { addLink, friendlyError, getDeviceId, isOnline } from '../lib/util'
import { latestSeen, offlineFor } from '../lib/duration'
import { Avatar, Empty, ListSkeleton, Sheet } from '../components/ui'

export function ShareCard() {
  const { profile } = useAuth()
  const toast = useToast()
  if (!profile) return null
  const link = addLink(profile.username)
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`, 'success') } catch { toast('Copy failed', 'error') }
  }
  const share = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Add me on Snapnote', text: `Add me on Snapnote: @${profile.username}`, url: link }) } catch { /* cancelled */ } }
    else void copy(link, 'Link')
  }
  return (
    <div className="ui-card p-5 text-center">
      <div className="mx-auto mb-4 w-fit rounded-2xl bg-white p-3"><QRCodeSVG value={link} size={156} /></div>
      <div className="gradient-text text-[28px] font-semibold tracking-wider">{profile.friend_code}</div>
      <div className="mt-1 text-sm text-ink/50">@{profile.username}</div>
      <button className="mt-3 w-full truncate rounded-2xl border border-line bg-card2 px-3 py-2 text-xs text-ink/70" onClick={() => copy(link, 'Link')}>{link.replace(/^https?:\/\//, '')}</button>
      <div className="mt-3 flex gap-2">
        <button className="ui-btn-light flex-1" onClick={() => copy(profile.friend_code, 'Code')}>Copy code</button>
        <button className="ui-btn-dark flex-1" onClick={share}>Share link</button>
      </div>
    </div>
  )
}

function AddSheet({ open, onClose, initial = '' }: { open: boolean; onClose: () => void; initial?: string }) {
  const { user } = useAuth()
  const toast = useToast()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [showQr, setShowQr] = useState(false)
  useEffect(() => { setValue(initial) }, [initial])
  const submit = async () => {
    if (!user) return
    setBusy(true)
    try { toast(await addFriend(user.id, value), 'success'); notifyChanged(); setValue(''); onClose() }
    catch (e) { toast(friendlyError(e), 'error') }
    finally { setBusy(false) }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Add a friend">
      <div className="flex gap-2">
        <input className="ui-field" placeholder="Username or code (RISH-4821)" value={value} autoCapitalize="none"
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value && submit()} />
        <button className="ui-btn-dark" disabled={busy || !value.trim()} onClick={submit}>Add</button>
      </div>
      <button className="ui-btn-light mt-4 w-full" onClick={() => setShowQr((v) => !v)}>{showQr ? 'Hide' : 'Show'} my QR & code</button>
      {showQr && <div className="rise mt-4"><ShareCard /></div>}
    </Sheet>
  )
}

/** /j/<username-or-code> join link (also /add/…) (QR or shared link) */
export function AddByLink() {
  const { code } = useParams()
  const { user } = useAuth()
  const goBack = useGoBack()
  const toast = useToast()
  useEffect(() => {
    if (!user || !code) return
    addFriend(user.id, code).then((m) => { notifyChanged(); toast(m, 'success') }).catch((e) => toast(friendlyError(e), 'error')).finally(() => goBack('/'))
  }, [user, code, goBack, toast])
  return <div className="flex h-full items-center justify-center text-ink/50">Connecting…</div>
}

export function FriendsPage() {
  const { user } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const uid = user!.id
  const rows = useFriendships(uid)
  const myDevices = useMyDevices(uid)
  const { byOwner, loading: devLoading } = useFriendDevices(uid)
  const now = useNow()
  const profiles = useProfiles((rows ?? []).map((r) => r.otherUid))
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); notifyChanged(); if (ok) toast(ok, 'success') } catch (e) { toast(friendlyError(e), 'error') }
    setMenu(null)
  }

  const incoming = (rows ?? []).filter((r) => r.status === 'pending' && r.requester !== uid)
  const outgoing = (rows ?? []).filter((r) => r.status === 'pending' && r.requester === uid)
  const friends = (rows ?? []).filter((r) => r.status === 'accepted')
  const me = getDeviceId()
  const otherMine = (myDevices ?? []).filter((d) => d.id !== me && d.is_display)
  const nameOf = (u: string) => profiles.get(u)?.display_name ?? '…'
  const menuRow = rows?.find((r) => r.otherUid === menu)

  return (
    <div className="safe-top px-5 pb-28 pt-6 md:px-8 md:pt-8">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-[26px] font-semibold">Friends</h1>
        <button className="ui-btn-dark !px-4 !py-2" onClick={() => setAdding(true)}>+ Add</button>
      </div>

      {otherMine.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">My devices</h2>
          <div className="space-y-2">
            {otherMine.map((d) => (
              <button key={d.id} className="ui-card flex w-full items-center gap-3 p-4 text-left transition active:scale-[.98]" onClick={() => nav(`/send/me?device=${d.id}`)}>
                <span className="text-2xl">📱</span>
                <div className="flex-1"><div className="font-semibold">{d.name}</div><div className="text-xs text-ink/40">{isOnline(d.last_seen, now) ? 'Online' : 'Offline'}</div></div>
                <span className={`h-3 w-3 rounded-full ${isOnline(d.last_seen, now) ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
              </button>
            ))}
          </div>
        </section>
      )}

      {incoming.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">Requests</h2>
          <div className="space-y-2">
            {incoming.map((r) => (
              <div key={r.id} className="ui-card rise flex items-center gap-3 p-4">
                <Avatar name={nameOf(r.otherUid)} color={profiles.get(r.otherUid)?.avatar_color ?? '#7c5cff'} url={profiles.get(r.otherUid)?.avatar_url} />
                <div className="min-w-0 flex-1"><div className="truncate font-semibold">{nameOf(r.otherUid)}</div><div className="text-xs text-ink/40">@{profiles.get(r.otherUid)?.username}</div></div>
                <button className="ui-btn-dark !px-4 !py-2" onClick={() => act(() => acceptRequest(uid, r.otherUid), 'Friend added')}>Accept</button>
                <button className="ui-btn-light !px-3 !py-2" aria-label="Decline" onClick={() => act(() => removeFriend(uid, r.otherUid))}>✕</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">Your friends</h2>
        {rows === null || devLoading ? <ListSkeleton /> : friends.length === 0 ? (
          <Empty emoji="👯" title="No friends yet">Add someone by username, friend code or QR and start sending notes to their screen.</Empty>
        ) : (
          <div className="space-y-2 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 lg:grid-cols-3">
            {friends.map((r) => {
              const p = profiles.get(r.otherUid)
              const devs = byOwner[r.otherUid] ?? []
              const online = devs.some((d) => isOnline(d.last_seen, now))
              return (
                <div key={r.id} className="ui-card flex items-center gap-3 p-4">
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" disabled={!devs.length} onClick={() => nav(`/send/${r.otherUid}`)}>
                    <Avatar name={p?.display_name ?? '?'} color={p?.avatar_color ?? '#7c5cff'} url={p?.avatar_url} online={online} />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{p?.display_name ?? '…'}</div>
                      <div className="truncate text-xs text-ink/40">
                        {devs.length === 0 ? `@${p?.username ?? ''} · no shared devices yet` : online ? 'Online · tap to send' : offlineFor(latestSeen(devs), now)}
                      </div>
                    </div>
                  </button>
                  <button className="px-2 text-xl text-ink/40" aria-label="More" onClick={() => setMenu(r.otherUid)}>⋯</button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">Sent requests</h2>
          {outgoing.map((r) => (
            <div key={r.id} className="ui-card mb-2 flex items-center gap-3 p-4">
              <Avatar name={nameOf(r.otherUid)} color={profiles.get(r.otherUid)?.avatar_color ?? '#7c5cff'} url={profiles.get(r.otherUid)?.avatar_url} />
              <div className="flex-1 truncate">{nameOf(r.otherUid)}<div className="text-xs text-ink/40">Pending…</div></div>
              <button className="ui-btn-light !px-3 !py-2" onClick={() => act(() => removeFriend(uid, r.otherUid), 'Request cancelled')}>Cancel</button>
            </div>
          ))}
        </section>
      )}

      <AddSheet open={adding} onClose={() => setAdding(false)} />
      <Sheet open={!!menu} onClose={() => setMenu(null)} title={menu ? nameOf(menu) : ''}>
        <div className="space-y-2">
          <button className="ui-btn-light w-full" onClick={() => menuRow && act(() => removeFriend(uid, menuRow.otherUid), 'Friend removed')}>Remove friend</button>
          <button className="ui-btn-danger w-full" onClick={() => menuRow && act(() => blockUser(uid, menuRow.otherUid), 'Blocked')}>Block</button>
        </div>
      </Sheet>
    </div>
  )
}
