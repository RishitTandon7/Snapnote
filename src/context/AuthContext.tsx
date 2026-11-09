import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { clearProfileCache } from '../hooks/useData'
import { rpc } from '../lib/supabase'
import type { Profile } from '../types'

interface AuthCtx {
  user: User | null
  profile: Profile | null
  authReady: boolean
  profileReady: boolean
  refreshProfile: () => Promise<void>
  loginGoogle: () => Promise<void>
  sendLink: (email: string) => Promise<void>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

/** where Supabase should send the user back to (must be in Auth → URL Configuration → Redirect URLs) */
const redirectTo = () => window.location.origin + window.location.pathname

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileReady, setProfileReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null)
      setAuthReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser((prev) => (prev?.id === session?.user?.id ? prev : session?.user ?? null))
      setAuthReady(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const uid = user?.id
  const loadProfile = useCallback(async () => {
    if (!uid) { setProfile(null); setProfileReady(true); return }
    const { data } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
    setProfile((data as Profile | null) ?? null)
    setProfileReady(true)
  }, [uid])

  useEffect(() => {
    setProfileReady(false)
    void loadProfile()
  }, [loadProfile])

  // keep the stored profile picture in step with the Google account photo (best effort: ignored if the database
  // hasn't had the update yet; email-link accounts have no photo and keep their initial)
  const syncedPhoto = useRef<string | null>(null)
  useEffect(() => {
    const raw = (user?.user_metadata?.avatar_url ?? user?.user_metadata?.picture) as string | undefined
    if (!user || !profile || !raw || !/^https:\/\//.test(raw)) return
    const photo = raw.replace(/=s\d+-c$/, '=s256-c') // a bigger rendition, still square-cropped
    if (profile.avatar_url === photo || syncedPhoto.current === `${user.id}|${photo}`) return
    syncedPhoto.current = `${user.id}|${photo}`
    rpc('set_avatar_url', { p_url: photo }).then(() => loadProfile()).catch(() => undefined)
  }, [user, profile, loadProfile])

  const loginGoogle = useCallback(async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo(), skipBrowserRedirect: true } })
    if (error) throw error
    if (data.url) window.location.replace(data.url) // replace, so Back doesn't walk back through Google's pages
  }, [])

  const sendLink = useCallback(async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo() } })
    if (error) throw error
  }, [])

  const logout = useCallback(async () => {
    clearProfileCache()
    await supabase.auth.signOut()
  }, [])

  const value = useMemo(
    () => ({ user, profile, authReady, profileReady, refreshProfile: loadProfile, loginGoogle, sendLink, logout }),
    [user, profile, authReady, profileReady, loadProfile, loginGoogle, sendLink, logout],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth outside provider')
  return c
}
