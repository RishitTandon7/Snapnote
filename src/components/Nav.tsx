import { useLocation } from 'react-router-dom'
import { useTabNav } from '../lib/nav'
import { useQuickSend } from '../context/QuickSend'
import { Avatar } from './ui'
import type { Profile } from '../types'

const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  homeFill: 'M12 2.6 2.7 10.5c-.4.3-.2 1 .3 1H5v8.2c0 .7.5 1.2 1.2 1.2H9.5a.5.5 0 0 0 .5-.5V15h4v5a.5.5 0 0 0 .5.5h3.3c.7 0 1.2-.5 1.2-1.2V11.5H21c.5 0 .7-.7.3-1Z',
  users: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm-12 9a8 8 0 0 1 16 0',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12Z',
  device: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm5 14h.01',
  plus: 'M12 5v14M5 12h14',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  room: 'M3 7h12v10H3zM15 11l6-4v10l-6-4',
  back: 'M19 12H5M12 19l-7-7 7-7',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  menu: 'M4 7h16M4 12h10M4 17h16',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2 8 2 8H4s2-2 2-8ZM10 20.5a2 2 0 0 0 4 0',
  dots: 'M12 5h.01M12 12h.01M12 19h.01',
  phoneOff: 'M10.7 13.3a16 16 0 0 0 3 2.3l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.2 6.2 2 2 0 0 1 5.2 4h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L9.1 11.9M2 2l20 20',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
  chevron: 'M9 6l6 6-6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-4.3-4.3',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h3v3h-3zM20 14v6h-3M14 20h.01',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
} as const
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 22, className = '', fill }: { name: IconName; size?: number; className?: string; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={PATHS[name]} />
    </svg>
  )
}

/** Overlapping initials avatars with a dark "+N" (or total) circle. No stock photos – colour + initial only. */
export function AvatarStack({ ids, profiles, max = 3, size = 32, total = false }: { ids: string[]; profiles: Map<string, Profile>; max?: number; size?: number; total?: boolean }) {
  const shown = ids.slice(0, max)
  const extra = ids.length - shown.length
  const show = total ? ids.length : extra
  return (
    <div className="flex items-center">
      {shown.map((id, i) => {
        const p = profiles.get(id)
        return (
          <div key={id} className="rounded-full ring-2 ring-white" style={{ marginLeft: i ? -size * 0.32 : 0 }}>
            <Avatar name={p?.display_name ?? '?'} color={p?.avatar_color ?? '#7c5cff'} url={p?.avatar_url} size={size} />
          </div>
        )
      })}
      {(total || extra > 0) && <CountDot n={show} size={size} overlap={shown.length > 0} />}
    </div>
  )
}

/** the dark "+N" circle */
export function CountDot({ n, size = 32, overlap = true, prefix = '' }: { n: number | string; size?: number; overlap?: boolean; prefix?: string }) {
  return (
    <div className="flex items-center justify-center rounded-full bg-ink/85 font-semibold text-white ring-2 ring-white backdrop-blur"
      style={{ width: size, height: size, marginLeft: overlap ? -size * 0.32 : 0, fontSize: size * 0.4 }}>
      {prefix}{n}
    </div>
  )
}

/** white circular icon button (menu, bell, back, more …) */
export function RoundBtn({ icon, label, onClick, dot, dark, size = 46 }: { icon: IconName; label: string; onClick?: () => void; dot?: boolean; dark?: boolean; size?: number }) {
  return (
    <button aria-label={label} onClick={onClick}
      className={`relative flex shrink-0 items-center justify-center rounded-full shadow-soft transition active:scale-90 ${dark ? 'bg-ink text-white' : 'bg-white text-ink'}`}
      style={{ width: size, height: size }}>
      <Icon name={icon} size={size * 0.46} />
      {dot && <span className="absolute right-[11px] top-[10px] h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-white" />}
    </button>
  )
}

type Item = { to: string; label: string; icon: IconName; end?: boolean }
const LEFT: Item[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/friends', label: 'Messages', icon: 'chat' },
]
const RIGHT: Item[] = [
  { to: '/devices', label: 'Devices', icon: 'device' },
  { to: '/settings', label: 'Profile', icon: 'user' },
]

/**
 * Floating glass pill: Home · Messages · big dark "+" · Devices · Profile (2 + 2, so it stays balanced).
 * `staticActive` renders non-interactive items (design preview); otherwise tabs that follow app-style Back rules.
 */
export function NavPill({ onPlus, staticActive }: { onPlus: () => void; staticActive?: string }) {
  const { pathname } = useLocation()
  const go = useTabNav()
  const cls = (on: boolean) =>
    `flex h-[54px] w-[54px] items-center justify-center rounded-full transition active:scale-90 ${on ? 'bg-white text-ink shadow-soft' : 'text-ink/45'}`
  const glyph = (t: Item, on: boolean) => <Icon name={t.icon === 'home' && on ? 'homeFill' : t.icon} fill={t.icon === 'home' && on} />
  const item = (t: Item) => {
    const on = staticActive !== undefined ? t.to === staticActive : t.end ? pathname === t.to : pathname.startsWith(t.to)
    return staticActive !== undefined ? (
      <span key={t.to} className={cls(on)}>{glyph(t, on)}</span>
    ) : (
      <button key={t.to} aria-label={t.label} aria-current={on ? 'page' : undefined} className={cls(on)} onClick={() => go(t.to)}>{glyph(t, on)}</button>
    )
  }
  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+14px)]">
      <div className="ui-glass pointer-events-auto flex items-center gap-0.5 rounded-full p-1.5">
        {LEFT.map(item)}
        <button aria-label="Quick send" onClick={onPlus}
          className="mx-1 flex h-[64px] w-[64px] items-center justify-center rounded-full bg-ink text-white shadow-lg shadow-ink/30 transition active:scale-90">
          <Icon name="plus" size={28} />
        </button>
        {RIGHT.map(item)}
      </div>
    </nav>
  )
}

export function TabBar() {
  const { open } = useQuickSend()
  return <NavPill onPlus={open} />
}
