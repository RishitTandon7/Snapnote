// Relays messages between the Snapnote tab (the hub that talks to your friends) and the tab that is playing the video.
const KEY = 'players' // tabId -> last time it told us it has a player

async function players() { return (await chrome.storage.session.get(KEY))[KEY] || {} }
async function setPlayers(p) { await chrome.storage.session.set({ [KEY]: p }) }

async function hubTabs() { return chrome.tabs.query({ url: 'https://snapnote.rishit.site/*' }) }

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.from === 'player') {
      // a video tab: remember it, pass its news to Snapnote
      if (sender.tab) {
        const p = await players()
        if (msg.t === 'gone') delete p[sender.tab.id]
        else p[sender.tab.id] = Date.now()
        await setPlayers(p)
      }
      for (const t of await hubTabs()) chrome.tabs.sendMessage(t.id, { ...msg, to: 'snapnote', tabId: sender.tab && sender.tab.id }).catch(() => undefined)
    } else if (msg.from === 'snapnote') {
      if (msg.t === 'register-hub') return
      // Snapnote → the most recently active video tab (or all of them for a probe)
      const p = await players()
      const ids = Object.keys(p).map(Number).sort((a, b) => p[b] - p[a])
      const target = msg.t === 'probe' ? ids : ids.slice(0, 1)
      for (const id of target) chrome.tabs.sendMessage(id, { ...msg, to: 'player' }).catch(() => undefined)
      if (msg.t === 'probe' && target.length === 0) for (const t of await hubTabs()) chrome.tabs.sendMessage(t.id, { to: 'snapnote', t: 'player', found: false }).catch(() => undefined)
    }
  })()
  return false
})

chrome.tabs.onRemoved.addListener(async (id) => { const p = await players(); if (p[id]) { delete p[id]; await setPlayers(p) } })
