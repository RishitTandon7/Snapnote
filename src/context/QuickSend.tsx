import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { QuickSendSheet } from '../components/QuickSendSheet'

interface Ctx { open: () => void }
const C = createContext<Ctx>({ open: () => undefined })

/** The centre "+" and the hero's "Start a Snap" button both open the same quick-send sheet. */
export function QuickSendProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  const open = useCallback(() => setOpen(true), [])
  const value = useMemo(() => ({ open }), [open])
  return (
    <C.Provider value={value}>
      {children}
      {isOpen && <QuickSendSheet onClose={() => setOpen(false)} />}
    </C.Provider>
  )
}

export const useQuickSend = () => useContext(C)
