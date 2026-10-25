import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './lib/install' // starts listening for the browser's install prompt immediately
import App from './App'
import '@fontsource-variable/inter'
import './index.css'

import { applyTheme, watchSystemTheme } from './lib/theme'

applyTheme() // light / dark before the first paint
watchSystemTheme()
registerSW({ immediate: true })

// app-like touch behaviour
document.addEventListener('gesturestart', (e) => e.preventDefault()) // iOS pinch zoom
document.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement | null
  if (!t?.closest('input, textarea, [contenteditable], .selectable')) e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
