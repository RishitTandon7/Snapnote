import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

/** false until the user puts their project URL + publishable key into .env */
export const backendConfigured = Boolean(url && key)

// Only the *publishable* (anon) key ever goes in the browser. Access is enforced by RLS in supabase/schema.sql.
export const supabase = createClient(url || 'http://localhost:54321', key || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 100 } }, // WebRTC signalling sends bursts (offer + many ICE candidates)
})

export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}
