import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/Toast'
import { createProfile, isUsernameFree, UserFacingError } from '../lib/friends'
import { AVATAR_COLORS, friendlyError, USERNAME_RE } from '../lib/util'
import { Avatar } from '../components/ui'
import { Wordmark } from '../components/Wordmark'

function Logo() {
  return (
    <div className="mb-8 flex flex-col items-center">
      <Wordmark className="w-[230px]" />
      <p className="ui-sub mt-1">Your words, live on their screen.</p>
    </div>
  )
}

export function Login() {
  const { loginGoogle, sendLink } = useAuth()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  // Supabase reports OAuth / magic-link failures in the URL (?error_description=… or #error_description=…)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search + '&' + window.location.hash.replace(/^#/, ''))
    const desc = params.get('error_description') ?? params.get('error')
    if (desc) {
      toast(`Sign-in failed: ${desc.replace(/\+/g, ' ')}`, 'error')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [toast])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } catch (e) { toast(friendlyError(e), 'error') } finally { setBusy(false) }
  }

  return (
    <div className="safe-top safe-bottom mx-auto flex min-h-full max-w-sm flex-col justify-center px-6">
      <Logo />
      {sent ? (
        <div className="ui-card rise p-5 text-center">
          <div className="mb-2 text-4xl">📬</div>
          <div className="font-semibold">Check your inbox</div>
          <p className="mt-1 text-sm text-ink/50">We sent a sign-in link to {email}. Open it on this device.</p>
          <button className="ui-btn-light mt-4" onClick={() => setSent(false)}>Use a different email</button>
        </div>
      ) : (
        <div className="ui-card space-y-3 p-5">
          <button className="ui-btn-light w-full !border !border-line !shadow-none" disabled={busy} onClick={() => run(loginGoogle)}>
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37a13 13 0 1 1 0-26c3.1 0 5.9 1.1 8.1 2.9l6-6A21.9 21.9 0 0 0 24 2a22 22 0 1 0 0 44c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4Z" /></svg>
            Continue with Google
          </button>
          <div className="flex items-center gap-3 text-xs text-ink/30"><div className="h-px flex-1 bg-line" />or<div className="h-px flex-1 bg-line" /></div>
          <input className="ui-field" type="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button
            className="ui-btn-dark w-full"
            disabled={busy || !/^\S+@\S+\.\S+$/.test(email)}
            onClick={() => run(async () => { await sendLink(email.trim()); setSent(true) })}
          >
            Email me a sign-in link
          </button>
          <p className="pt-2 text-center text-xs text-ink/30">No passwords. Ever.</p>
        </div>
      )}
    </div>
  )
}

export function Onboarding() {
  const { user, refreshProfile } = useAuth()
  const toast = useToast()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState(String(user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? ''))
  const [color, setColor] = useState(AVATAR_COLORS[0])
  const [status, setStatus] = useState<'idle' | 'checking' | 'free' | 'taken' | 'invalid'>('idle')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!username) { setStatus('idle'); return }
    if (!USERNAME_RE.test(username)) { setStatus('invalid'); return }
    setStatus('checking')
    let alive = true
    const t = setTimeout(async () => {
      try { const free = await isUsernameFree(username); if (alive) setStatus(free ? 'free' : 'taken') } catch { if (alive) setStatus('idle') }
    }, 350)
    return () => { alive = false; clearTimeout(t) }
  }, [username])

  const submit = async () => {
    if (!user) return
    setBusy(true)
    try {
      await createProfile({ username, displayName: displayName || username, avatarColor: color })
      await refreshProfile()
    } catch (e) {
      toast(e instanceof UserFacingError ? e.message : friendlyError(e), 'error')
      setBusy(false)
    }
  }

  const hint = { idle: '', checking: 'Checking…', free: '✓ Available', taken: 'Already taken', invalid: '3–20 chars, start with a letter; a–z 0–9 _' }[status]

  return (
    <div className="safe-top safe-bottom mx-auto flex min-h-full max-w-sm flex-col justify-center px-6 py-8">
      <h1 className="text-[26px] font-semibold">Welcome 👋</h1>
      <p className="mb-6 mt-1 text-ink/50">Pick how friends will find you.</p>
      <div className="ui-card p-5">
      <div className="mb-5 flex justify-center"><Avatar name={displayName || username || '?'} color={color} url={String(user?.user_metadata?.avatar_url ?? user?.user_metadata?.picture ?? '') || null} size={88} /></div>
      <div className="mb-5 flex flex-wrap justify-center gap-3">
        {AVATAR_COLORS.map((c) => (
          <button key={c} aria-label={`Color ${c}`} onClick={() => setColor(c)}
            className={`h-9 w-9 rounded-full transition active:scale-90 ${color === c ? 'ring-2 ring-ink ring-offset-2 ring-offset-white' : ''}`}
            style={{ background: c }} />
        ))}
      </div>
      <label className="mb-1 text-sm text-ink/60">Username</label>
      <input className="ui-field" autoCapitalize="none" autoCorrect="off" value={username} maxLength={20}
        onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="e.g. rishit" />
      <div className={`mb-4 mt-1 h-4 text-xs ${status === 'free' ? 'text-emerald-600' : status === 'taken' || status === 'invalid' ? 'text-danger' : 'text-ink/40'}`}>{hint}</div>
      <label className="mb-1 text-sm text-ink/60">Display name</label>
      <input className="ui-field mb-6" value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
      <button className="ui-btn-dark w-full" disabled={busy || status !== 'free' || !displayName.trim()} onClick={submit}>
        {busy ? 'Creating…' : "Let's go"}
      </button>
      </div>
    </div>
  )
}

export function ConfigMissing() {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6">
      <Logo />
      <div className="ui-card p-5 text-sm text-ink/70">
        <div className="mb-2 text-base font-semibold text-ink">Supabase isn't configured yet</div>
        Copy <code className="text-pink">.env.example</code> to <code className="text-pink">.env</code> and set
        <code> VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> (Project Settings → API), run
        <code className="text-pink"> supabase/schema.sql</code> in the SQL editor, then restart <code className="text-pink">npm run dev</code>.
        See the README.
      </div>
    </div>
  )
}
