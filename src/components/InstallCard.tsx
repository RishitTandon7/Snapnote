import { useState } from 'react'
import { dismissInstall, installDismissed, useInstall } from '../lib/install'
import { Sheet } from './ui'

function ShareGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="inline-block align-[-4px]">
      <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </svg>
  )
}

/** Steps for iPhone/iPad, which has no install button */
export function IOSInstallSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Add Snapnote to your Home Screen">
      <ol className="space-y-3 text-[15px]">
        <li className="flex gap-3"><b className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-[13px] text-white">1</b><span>Open this page in <b>Safari</b>.</span></li>
        <li className="flex gap-3"><b className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-[13px] text-white">2</b><span>Tap the <b>Share</b> button <ShareGlyph /> at the bottom of the screen.</span></li>
        <li className="flex gap-3"><b className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-[13px] text-white">3</b><span>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</span></li>
      </ol>
      <p className="ui-sub mt-4">Then open Snapnote from your Home Screen. It runs full screen, like any other app.</p>
      <button className="ui-btn-dark mt-4 w-full" onClick={onClose}>Got it</button>
    </Sheet>
  )
}

/** One-tap install (Android / desktop) or the iPhone steps. Hidden when already installed. */
export function useInstallAction() {
  const s = useInstall()
  const [iosOpen, setIosOpen] = useState(false)
  const available = !s.installed && (s.canPrompt || s.ios)
  const run = async () => { if (s.canPrompt) await s.install(); else if (s.ios) setIosOpen(true) }
  return { available, run, iosOpen, setIosOpen, label: s.ios && !s.canPrompt ? 'Show me how' : 'Install' }
}

/** Dismissible card on Home */
export function InstallCard() {
  const { available, run, iosOpen, setIosOpen, label } = useInstallAction()
  const [hidden, setHidden] = useState(installDismissed)
  if (!available || hidden) return null
  return (
    <>
      <div className="rise mb-4 flex items-center gap-3 rounded-[24px] bg-white p-3 pr-2 shadow-soft">
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[15px] font-semibold">Install Snapnote</div>
          <div className="text-[13px] text-mute">Opens full screen, like an app.</div>
        </div>
        <button onClick={() => void run()} className="shrink-0 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white transition active:scale-95">{label}</button>
        <button aria-label="Dismiss" onClick={() => { dismissInstall(); setHidden(true) }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink/40">✕</button>
      </div>
      <IOSInstallSheet open={iosOpen} onClose={() => setIosOpen(false)} />
    </>
  )
}
