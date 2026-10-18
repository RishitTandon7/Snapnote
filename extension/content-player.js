// Runs on video sites. Watches the player (play / pause / seek) and tells Snapnote; applies what Snapnote tells it.
(function () {
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname)
  let video = null
  let applying = 0 // while we are applying a friend's action, don't report it back (no echo loop)

  const send = (m) => { try { chrome.runtime.sendMessage({ from: 'player', ...m }) } catch (e) { /* extension reloaded */ } }
  const state = (kind) => ({ t: 'state', kind, playing: !video.paused, time: Math.round(video.currentTime * 1000), host: location.hostname, title: document.title })

  function attach(v) {
    if (video === v) return
    video = v
    const report = (kind) => () => { if (Date.now() < applying) return; send(state(kind)) }
    v.addEventListener('play', report('play'))
    v.addEventListener('pause', report('pause'))
    v.addEventListener('seeked', report('seek'))
    send(state('found'))
  }

  function findVideo() {
    const vs = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0 || !v.paused)
    const best = vs.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0]
    if (best) attach(best)
  }
  findVideo()
  setInterval(findVideo, 2000)
  // a tick so Snapnote can keep everyone together (only while playing)
  setInterval(() => { if (video && !video.paused && Date.now() >= applying) send(state('tick')) }, 6000)

  function netflix(cmd) { window.postMessage({ snapnoteNetflix: 'cmd', ...cmd }, '*') }

  // big 3-2-1 over the video (runs here, in the tab you are watching, so background-tab timer throttling can't delay it)
  function countdown(ms, done) {
    const el = document.createElement('div')
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;pointer-events:none;font:700 140px system-ui,sans-serif;color:#fff;text-shadow:0 4px 30px rgba(0,0,0,.7);background:rgba(0,0,0,.25)'
    ;(document.fullscreenElement || document.body).appendChild(el)
    let left = Math.ceil(ms / 1000)
    el.textContent = String(left)
    const t = setInterval(() => {
      left -= 1
      if (left <= 0) { clearInterval(t); el.remove(); done() } else el.textContent = String(left)
    }, 1000)
  }

  function apply(m) {
    if (!video) return
    if (m.kind === 'start') {
      // everyone: jump to the same moment, pause, count down, then play together
      apply({ kind: 'seek', playing: false, time: m.time })
      countdown(m.delay || 3000, () => apply({ kind: 'play', playing: true, time: m.time }))
      return
    }
    applying = Date.now() + 1500
    const wantMs = m.time + (m.playing ? 150 : 0) // a little for the trip
    const off = Math.abs(video.currentTime * 1000 - wantMs)
    if (isNetflix) {
      if (m.kind !== 'tick' || off > 1500) netflix({ seek: wantMs })
      netflix({ play: !!m.playing })
    } else {
      if (m.kind !== 'tick' || off > 1500) video.currentTime = wantMs / 1000
      if (m.playing && video.paused) video.play().catch(() => undefined)
      if (!m.playing && !video.paused) video.pause()
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.to !== 'player') return
    if (msg.t === 'probe') { if (video) send(state('found')) }
    else if (msg.t === 'apply') apply(msg)
  })

  window.addEventListener('pagehide', () => send({ t: 'gone' }))
})()
