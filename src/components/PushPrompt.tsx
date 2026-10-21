import { useEffect, useState } from 'react'
import { useToast } from '../context/Toast'
import { enablePush, pushState } from '../lib/push'
import { friendlyError } from '../lib/util'

const KEY = 'snapnote.pushPromptDismissed'

/** a gentle one-tap card on Home: "ring me even when the app is closed" */
export function PushPrompt() {
  const toast = useToast()
  const [show, setShow] = useState(false)
  useEffect(() => {
    let dismissed = false
    try { dismissed = localStorage.getItem(KEY) === '1' } catch { /* ignore */ }
    // only ask people who have never allowed it; anyone who already did is restored silently
    if (!dismissed && 'Notification' in window && Notification.permission === 'default') void pushState().then((s) => setShow(s === 'off'))
  }, [])
  if (!show) return null
  return (
    <div className="rise mb-4 flex items-center gap-3 rounded-[24px] bg-white p-3 pl-4 shadow-soft">
      <span className="text-2xl" aria-hidden>🔔</span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[15px] font-semibold">Get rung when the app is closed</div>
        <div className="text-[12.5px] text-mute">Turn on call notifications</div>
      </div>
      <button className="rounded-full px-2 py-2 text-[13px] font-medium text-mute" onClick={() => { try { localStorage.setItem(KEY, '1') } catch { /* ignore */ } setShow(false) }}>Not now</button>
      <button className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white transition active:scale-95"
        onClick={async () => { try { await enablePush(); setShow(false); toast('Call notifications on', 'success') } catch (e) { toast(/save_push|could not find the function/i.test((e as Error).message) ? 'Run supabase/update-push.sql in the Supabase SQL Editor first.' : friendlyError(e), 'error', { ms: 8000 }) } }}>Turn on</button>
    </div>
  )
}
