// Loaded by the app's service worker (see vite.config.ts → workbox.importScripts).
// Shows "X is calling you" even when Snapnote is closed. Tapping it (or "Answer") opens the app and picks up the call.
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch (e) { /* plain text */ }
  event.waitUntil((async () => {
    // if Snapnote is open and in front, its own ringing card is enough
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (wins.some((w) => w.visibilityState === 'visible')) return
    await self.registration.showNotification(d.title || 'Incoming call', {
      body: d.body || 'Tap to answer',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'snapnote-call',
      renotify: true,          // every re-send alerts again (sound + vibration) instead of silently replacing
      silent: false,
      requireInteraction: true, // stays on screen until you act
      vibrate: [400, 200, 400, 200, 400, 200, 400],
      timestamp: Date.now(),
      actions: [{ action: 'answer', title: 'Answer' }],
      data: { call: d.call, code: d.code },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const call = event.notification.data && event.notification.data.call
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) {
      if ('focus' in w) { await w.focus(); w.postMessage({ type: 'answer-call', call }); return }
    }
    await self.clients.openWindow(call ? '/?answer=' + encodeURIComponent(call) : '/')
  })())
})
