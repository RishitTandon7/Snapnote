// Runs on the Snapnote website. A tiny bridge: the page talks to the extension with window.postMessage.
//   page → extension : { snapnoteApp: true, payload: {...} }
//   extension → page : { snapnoteExt: true, payload: {...} }
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || !e.data.snapnoteApp) return
  try { chrome.runtime.sendMessage({ from: 'snapnote', ...e.data.payload }) } catch (_) { /* extension reloaded */ }
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.to === 'snapnote') window.postMessage({ snapnoteExt: true, payload: msg }, '*')
})

// say hello so the page knows the extension is installed (also answers the page's own "ping")
const hello = () => window.postMessage({ snapnoteExt: true, payload: { to: 'snapnote', t: 'present', version: '1.0.0' } }, '*')
hello()
window.addEventListener('message', (e) => { if (e.source === window && e.data && e.data.snapnoteApp && e.data.payload && e.data.payload.t === 'ping') hello() })
try { chrome.runtime.sendMessage({ from: 'snapnote', t: 'register-hub' }) } catch (_) { /* ignore */ }
