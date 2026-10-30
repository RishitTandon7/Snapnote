// Runs INSIDE the Netflix page (so it can use Netflix's own player controls; its <video> refuses to be seeked directly).
(function () {
  function player() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer
      const id = vp.getAllPlayerSessionIds().find((s) => s.indexOf('watch-') === 0) || vp.getAllPlayerSessionIds()[0]
      return id ? vp.getVideoPlayerBySessionId(id) : null
    } catch (e) { return null }
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.snapnoteNetflix !== 'cmd') return
    const p = player()
    if (!p) return
    try {
      if (e.data.seek != null) p.seek(Math.max(0, Math.round(e.data.seek)))
      if (e.data.play === true) p.play()
      if (e.data.play === false) p.pause()
    } catch (err) { /* ignore */ }
  })
})()
