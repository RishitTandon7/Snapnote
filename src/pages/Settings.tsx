import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { supabase } from '../lib/supabase'
import { notifyChanged, useFriendships, useProfiles } from '../hooks/useData'
import { unblockUser } from '../lib/friends'
import { AVATAR_COLORS, friendlyError } from '../lib/util'
import { Avatar } from '../components/ui'
import { ShareCard } from './Friends'
import { IOSInstallSheet, useInstallAction } from '../components/InstallCard'
import { getTheme, setTheme, type Theme } from '../lib/theme'
import { callError } from '../lib/calls'
import { disablePush, enablePush, pushState, type PushState } from '../lib/push'

export function SettingsPage() {
  const { user, profile, logout, refreshProfile } = useAuth()
  const toast = useToast()
  const uid = user!.id
  const [name, setName] = useState(profile?.display_name ?? '')
  const rows = useFriendships(uid)
  const blocked = (rows ?? []).filter((r) => r.status === 'blocked' && r.blocked_by === uid)
  const profiles = useProfiles(blocked.map((b) => b.otherUid))
  const install = useInstallAction()
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [push, setPush] = useState<PushState | null>(null)
  useEffect(() => { void pushState().then(setPush) }, [])
  if (!profile) return null

  const save = async (patch: { display_name?: string; avatar_color?: string }) => {
    try {
      const { error } = await supabase.from('profiles').update(patch).eq('id', uid)
      if (error) throw error
      await refreshProfile()
    } catch (e) { toast(friendlyError(e), 'error') }
  }

  return (
    <div className="safe-top mx-auto max-w-xl space-y-6 px-5 pb-28 pt-6 md:pt-8">
      <h1 className="text-[26px] font-semibold">Settings</h1>

      <section className="ui-card space-y-4 p-5">
        <div className="flex items-center gap-4">
          <Avatar name={profile.display_name} color={profile.avatar_color} url={profile.avatar_url} size={64} />
          <div className="min-w-0">
            <div className="truncate text-lg font-bold">{profile.display_name}</div>
            <div className="text-sm text-ink/50">@{profile.username}</div>
          </div>
        </div>
        <input className="ui-field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== profile.display_name && void save({ display_name: name.trim() })} aria-label="Display name" />
        <div className="flex flex-wrap gap-3">
          {AVATAR_COLORS.map((c) => (
            <button key={c} aria-label={`Color ${c}`} onClick={() => save({ avatar_color: c })}
              className={`h-8 w-8 rounded-full transition active:scale-90 ${profile.avatar_color === c ? 'ring-2 ring-ink ring-offset-2 ring-offset-card' : ''}`} style={{ background: c }} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">Calls</h2>
        <div className="ui-card flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">Ring me when Snapnote is closed</div>
            <div className="text-[13px] text-mute">
              {push === 'app' ? 'On: the Snapnote Android app rings this phone like a real call.'
                : push === 'on' ? 'On: this phone rings for incoming calls.'
                : push === 'blocked' ? 'Blocked: allow notifications for Snapnote in your phone/browser settings.'
                : push === 'needs-install' ? 'On iPhone: add Snapnote to your Home Screen first, then open it from there.'
                : push === 'unsupported' ? "This browser can't show call notifications."
                : 'Get a notification when a friend calls, even if the app is closed.'}
            </div>
          </div>
          {(push === 'off' || push === 'on') && (
            <button className={push === 'on' ? 'ui-btn-light !px-4 !py-2 text-[14px]' : 'ui-btn-dark !px-4 !py-2 text-[14px]'}
              onClick={async () => {
                try { if (push === 'on') await disablePush(); else await enablePush(); setPush(await pushState()); toast(push === 'on' ? 'Call notifications off' : 'Call notifications on', 'success') }
                catch (e) { toast(/could not find the function|save_push/i.test((e as Error).message) ? 'Run supabase/update-push.sql in the Supabase SQL Editor first.' : callError(e) || friendlyError(e), 'error', { ms: 8000 }) }
              }}>{push === 'on' ? 'Turn off' : 'Turn on'}</button>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">Appearance</h2>
        <div className="ui-card grid grid-cols-3 gap-2 p-2" role="radiogroup" aria-label="Theme">
          {([['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={theme === k} onClick={() => { setTheme(k); setThemeState(k) }}
              className={`rounded-full px-3 py-2.5 text-[14px] font-semibold transition active:scale-95 ${theme === k ? 'bg-ink text-white' : 'text-ink/70'}`}>{label}</button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">Your friend code</h2>
        <ShareCard />
      </section>

      {blocked.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">Blocked</h2>
          {blocked.map((b) => (
            <div key={b.id} className="ui-card mb-2 flex items-center gap-3 p-3">
              <Avatar name={profiles.get(b.otherUid)?.display_name ?? '?'} color={profiles.get(b.otherUid)?.avatar_color ?? '#555'} url={profiles.get(b.otherUid)?.avatar_url} size={36} />
              <div className="flex-1 truncate">{profiles.get(b.otherUid)?.display_name ?? '…'}</div>
              <button className="ui-btn-light !px-3 !py-1.5 text-sm" onClick={() => unblockUser(uid, b.otherUid).then(() => { notifyChanged(); toast('Unblocked') })}>Unblock</button>
            </div>
          ))}
        </section>
      )}

      {install.available && (
        <section className="ui-card flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1 leading-tight"><div className="font-semibold">Install the app</div><div className="text-[13px] text-mute">Full screen, own icon, no browser bar.</div></div>
          <button className="ui-btn-dark !px-4 !py-2" onClick={() => void install.run()}>{install.label}</button>
        </section>
      )}
      <IOSInstallSheet open={install.iosOpen} onClose={() => install.setIosOpen(false)} />

      <button className="ui-btn-danger w-full" onClick={() => logout()}>Sign out</button>
      <p className="text-center text-xs text-ink/25">Snapnote · signed in as {user?.email}</p>
    </div>
  )
}
