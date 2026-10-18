// FROZEN copy of the shared pieces the call screen uses (Avatar, Icon, RoundBtn, Sheet, Skeleton).
// Kept here, verbatim, so restyling the rest of the app can never change the call screen.
import { useState, type ReactNode } from 'react'
import { initials } from '../../lib/util'
import { useBackToClose } from '../../lib/nav'

const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  homeFill: 'M12 2.6 2.7 10.5c-.4.3-.2 1 .3 1H5v8.2c0 .7.5 1.2 1.2 1.2H9.5a.5.5 0 0 0 .5-.5V15h4v5a.5.5 0 0 0 .5.5h3.3c.7 0 1.2-.5 1.2-1.2V11.5H21c.5 0 .7-.7.3-1Z',
  users: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm-12 9a8 8 0 0 1 16 0',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12Z',
  device: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm5 14h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.7 3h-4l-.3 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.3 2.7h4l.3-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z',
  plus: 'M12 5v14M5 12h14',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  screen: 'M4 5h16v11H4zM8 20h8M12 16v4',
  screenOff: 'M4 5h16v11H4zM8 20h8M12 16v4M3 3l18 18',
  leave: 'M9 21H5V3h4M16 17l5-5-5-5M21 12H9',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
  room: 'M3 7h12v10H3zM15 11l6-4v10l-6-4',
  roomFill: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h8A1.5 1.5 0 0 1 14 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 3 17.5ZM15.5 10.2l4.9-3a.6.6 0 0 1 .9.5v10.6a.6.6 0 0 1-.9.5l-4.9-3Z',
  back: 'M19 12H5M12 19l-7-7 7-7',
  minimize: 'M6 9l6 6 6-6',
  videoOff: 'M3 7h12v10H3zM15 11l6-4v10l-6-4M3 3l18 18',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  flip: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  menu: 'M4 7h16M4 12h10M4 17h16',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2 8 2 8H4s2-2 2-8ZM10 20.5a2 2 0 0 0 4 0',
  dots: 'M12 5h.01M12 12h.01M12 19h.01',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18',
  phoneOff: 'M10.7 13.3a16 16 0 0 0 3 2.3l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.2 6.2 2 2 0 0 1 5.2 4h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L9.1 11.9M2 2l20 20',
  briefcase: 'M4 8h16v11H4zM9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8M4 13h16',
  folder: 'M4 5h5l2 2h9v12H4z',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.7 3h-4l-.3 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.3 2.7h4l.3-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z',
} as const
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 22, className = '', fill }: { name: IconName; size?: number; className?: string; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={PATHS[name]} />
    </svg>
  )
}


/** round white button, as in the reference header */
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


export function Avatar({ name, color, size = 44, online, url }: { name: string; color: string; size?: number; online?: boolean; url?: string | null }) {
  const [bad, setBad] = useState(false) // photo failed to load → fall back to the initial
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full font-bold text-white"
        style={{ background: `linear-gradient(135deg, ${color}, ${color}aa)`, fontSize: size * 0.42 }}
      >
        {url && !bad
          ? <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(true)} className="h-full w-full object-cover" />
          : initials(name)}
      </div>
      {online !== undefined && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-paper ${online ? 'bg-emerald-400' : 'bg-zinc-600'}`}
        />
      )}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}


export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useBackToClose(open, onClose)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="rise safe-bottom w-full max-w-lg rounded-t-[2rem] border border-line bg-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink/20" />
        <h2 className="mb-4 text-xl font-bold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

