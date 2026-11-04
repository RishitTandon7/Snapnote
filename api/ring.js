// Vercel serverless function: makes the callee's phones ring.
//  - Snapnote Android app (Firebase push, "fcm:" tokens): one high-priority push; the app rings by itself, full screen, until answered.
//  - Browser / installed web app (Web Push): ONE notification per call. (Re-sending every few seconds made Chrome label the site "possible spam" and silence it.)
// The caller's own login token is used to ask the database who to notify (the database only answers for the caller's own ringing call),
// so no admin key is needed for that. Secrets live in Vercel environment variables: VAPID_PRIVATE_KEY, FIREBASE_SERVICE_ACCOUNT.
import * as webpush from 'web-push'
import { createSign } from 'node:crypto'

export const config = { maxDuration: 60 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b64u = (x) => Buffer.from(x).toString('base64url')

let cached = { token: '', exp: 0 }
async function fcmAccessToken(sa) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token
  const now = Math.floor(Date.now() / 1000)
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key, 'base64url')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  })
  if (!r.ok) throw new Error('google auth failed')
  const j = await r.json()
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }
  return cached.token
}

async function sendFcm(sa, token, data) {
  const at = await fcmAccessToken(sa)
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '45s' } } }),
  })
  return r.ok
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const auth = req.headers.authorization || ''
  const callId = req.body && req.body.call
  if (!auth.startsWith('Bearer ') || typeof callId !== 'string') return res.status(400).json({ error: 'bad request' })

  const url = process.env.VITE_SUPABASE_URL
  const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const pub = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!url || !anon || !pub || !priv) return res.status(500).json({ error: 'push is not configured' })
  try { webpush.setVapidDetails('https://snapnote.rishit.site', pub, priv) } catch { return res.status(500).json({ error: 'push keys are invalid' }) }

  let sa = null
  try { if (process.env.FIREBASE_SERVICE_ACCOUNT) sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) } catch { sa = null }

  const lookup = async () => {
    const r = await fetch(`${url}/rest/v1/rpc/call_push_targets`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_call: callId }),
    })
    if (!r.ok) return r.status === 401 ? null : []
    const list = await r.json()
    return Array.isArray(list) ? list : []
  }

  let sent = 0
  let fcmTokens = []
  const started = Date.now()
  // the Android app is pushed once (it keeps ringing by itself); browsers get one notification. Then we only watch, so we can tell the app when the call stops.
  for (let i = 0; i < 9; i++) {
    const targets = await lookup()
    if (targets === null) return res.status(401).json({ error: 'not signed in' })
    if (targets.length === 0) break
    const isFcm = (t) => typeof t.endpoint === 'string' && t.endpoint.startsWith('fcm:')
    if (i === 0) {
      fcmTokens = targets.filter(isFcm).map((t) => t.endpoint.slice(4))
      if (sa) {
        await Promise.all(targets.filter(isFcm).map(async (t) => {
          try { if (await sendFcm(sa, t.endpoint.slice(4), { type: 'call', call: callId, name: String(t.caller_name || 'Someone'), code: String(t.room_code || '') })) sent++ } catch { /* bad token */ }
        }))
      }
    }
    if (i === 0) await Promise.all(targets.filter((t) => !isFcm(t)).map(async (t) => {
      try {
        await webpush.sendNotification(
          { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
          JSON.stringify({ title: `${t.caller_name} is calling`, body: 'Tap to answer', code: t.room_code, call: callId }),
          { TTL: 30, urgency: 'high' },
        )
        sent++
      } catch { /* an expired subscription: nothing to do */ }
    }))
    if (Date.now() - started > 42_000) break
    await sleep(5000)
  }
  // the call stopped ringing (answered / declined / cancelled): tell the Android app to stop its ringtone
  if (sa && fcmTokens.length) {
    await Promise.all(fcmTokens.map((tok) => sendFcm(sa, tok, { type: 'cancel', call: callId }).catch(() => false)))
  }
  return res.status(200).json({ sent })
}
