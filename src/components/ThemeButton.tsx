import { useEffect, useState } from 'react'
import { applyTheme, setTheme } from '../lib/theme'
import { RoundBtn } from './Nav'

const isDark = () => document.documentElement.classList.contains('dark')

/** one tap: light ⇄ dark (the full Auto / Light / Dark choice is in Settings → Appearance) */
export function ThemeButton() {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const sync = () => setDark(isDark())
    mq?.addEventListener?.('change', sync)
    return () => mq?.removeEventListener?.('change', sync)
  }, [])
  return (
    <RoundBtn icon={dark ? 'sun' : 'moon'} label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => { const next = dark ? 'light' : 'dark'; setTheme(next); applyTheme(next); setDark(!dark) }} />
  )
}
