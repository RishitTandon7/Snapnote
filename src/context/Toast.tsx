import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type Kind = 'info' | 'error' | 'success'
export interface ToastOpts {
  /** small image shown on the left (e.g. the copied photo) */
  thumb?: string
  /** button on the right. `run` is called straight from the click, so it may use the clipboard. */
  action?: { label: string; run: () => void }
  ms?: number
}
interface T { id: number; msg: string; kind: Kind; opts?: ToastOpts }
type Fn = (msg: string, kind?: Kind, opts?: ToastOpts) => void

const Ctx = createContext<Fn>(() => undefined)
let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([])
  const toast = useCallback<Fn>((msg, kind = 'info', opts) => {
    if (!msg) return
    const id = ++seq
    setItems((l) => [...l.slice(-2), { id, msg, kind, opts }])
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), opts?.ms ?? (opts?.action ? 12_000 : 3200))
  }, [])
  const dismiss = (id: number) => setItems((l) => l.filter((t) => t.id !== id))
  const value = useMemo(() => toast, [toast])
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+12px)]">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast-in pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl border px-4 py-3 text-sm shadow-glass ${
              t.kind === 'error' ? 'border-danger/30 bg-white text-danger'
                : t.kind === 'success' ? 'border-emerald-500/30 bg-white text-emerald-700'
                : 'border-white/10 bg-ink text-white'
            }`}
          >
            {t.opts?.thumb && <img src={t.opts.thumb} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />}
            <span className="min-w-0 flex-1">{t.msg}</span>
            {t.opts?.action && (
              <button
                className="shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-white active:scale-95"
                onClick={() => { t.opts!.action!.run(); dismiss(t.id) }}
              >
                {t.opts.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
