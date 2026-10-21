export type Theme = 'system' | 'light' | 'dark'
const KEY = 'snapnote.theme'

export const getTheme = (): Theme => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system' } catch { return 'system' } }

/** put (or take off) the `dark` class on <html>; every colour in the app follows from that */
export function applyTheme(t: Theme = getTheme()): void {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e101c' : '#d9dbe8')
}

export function setTheme(t: Theme): void {
  try { localStorage.setItem(KEY, t) } catch { /* ignore */ }
  applyTheme(t)
}

export function watchSystemTheme(): void {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (getTheme() === 'system') applyTheme() })
}
