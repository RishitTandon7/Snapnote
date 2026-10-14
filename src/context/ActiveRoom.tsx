import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export interface ActiveRoomInfo { id: string; code: string; name: string }

interface Ctx {
  active: ActiveRoomInfo | null
  /** remember the room I'm "in" (kept across reloads so a minimized room survives a refresh) */
  setActive: (r: ActiveRoomInfo | null) => void
}

const KEY = 'snapnote.activeRoom'
const C = createContext<Ctx>({ active: null, setActive: () => undefined })

function load(): ActiveRoomInfo | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as ActiveRoomInfo) : null
  } catch { return null }
}

export function ActiveRoomProvider({ children }: { children: ReactNode }) {
  const [active, setState] = useState<ActiveRoomInfo | null>(load)
  const setActive = useCallback((r: ActiveRoomInfo | null) => {
    setState((prev) => (prev?.id === r?.id && prev?.name === r?.name && prev?.code === r?.code ? prev : r))
    try { if (r) localStorage.setItem(KEY, JSON.stringify(r)); else localStorage.removeItem(KEY) } catch { /* ignore */ }
  }, [])
  const value = useMemo(() => ({ active, setActive }), [active, setActive])
  return <C.Provider value={value}>{children}</C.Provider>
}

export const useActiveRoom = () => useContext(C)
