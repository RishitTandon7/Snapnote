# Snapnote

Realtime "send text to a friend's screen" PWA. Vite + React + TypeScript + Tailwind, backed by **Supabase (free plan)**: Auth, Postgres + Row Level Security, Realtime. No paid services, no Edge Functions.

A device in **Display mode** shows its camera (or a captured photo) with friends' text overlaid, live. Friends can also trigger a **remote capture**: a real, full-quality camera photo that lands on their clipboard within seconds (see below).

## 1. Supabase setup (free)

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**. This creates tables, RLS policies, RPC functions, Realtime publication and a 15-minute cleanup job for expired messages. Safe to re-run.
   - The cleanup job uses `pg_cron`. If the script prints a notice that it isn't available, enable **Database → Extensions → pg_cron**, then re-run the script.
3. **Authentication → Providers**
   - **Email**: enabled (magic link; leave "Confirm email" as you like). No passwords are used.
   - **Google**: enable, paste a Google OAuth *Client ID / Secret* (Google Cloud Console → APIs & Services → Credentials → OAuth client, type Web). Add the callback URL shown by Supabase (`https://<ref>.supabase.co/auth/v1/callback`) as an **Authorized redirect URI**.
4. **Authentication → URL Configuration**
   - **Site URL**: your deployed URL (e.g. `https://snapnote.vercel.app`)
   - **Redirect URLs**: add `http://localhost:5173/**` and `https://<your-domain>/**`
5. **Project Settings → API**: copy the **Project URL** and the **publishable** key.
6. `cp .env.example .env` and fill in:
   ```
   VITE_SUPABASE_URL=https://<ref>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```
   > **Never** put the `sb_secret_…` key in this app or in git. The browser only ever needs the publishable key; everything is protected by RLS and the `SECURITY DEFINER` functions in `schema.sql`. If a secret key was ever pasted somewhere public, rotate it in the dashboard.

## 2. Run locally

```bash
npm install
npm run dev          # http://localhost:5173
```
Camera works on `localhost` and HTTPS only.

## 3. Deploy

Any static host works (Vercel, Netlify, Cloudflare Pages, Supabase-free GitHub Pages…). Example with Vercel:

```bash
npm run build        # outputs dist/
npx vercel --prod    # set the two VITE_SUPABASE_* env vars in the Vercel project
```
Add a rewrite of all paths to `/index.html` (Vercel/Netlify do this for SPAs automatically with a `vercel.json`/`_redirects`; see below). Then add the deployed URL to Supabase **Redirect URLs** (step 1.4). HTTPS is provided by the host, which the camera requires.

`vercel.json`:
```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

## 4. Install on your phone
Open the HTTPS URL in Chrome (Android → menu → *Install app*) or Safari (iOS → Share → *Add to Home Screen*). Sign in with the same account everywhere; each browser registers itself under **Devices**.

## How to use
1. Sign in (Google or email link), pick username / display name / colour. Your friend code (e.g. `RISH-4821`), link and QR are in **Settings**.
2. **Friends → + Add** by username or code, or open a join link like `/j/rishit` (QR / shared link; `/add/<code>` also works). The other person accepts.
3. On the device that should show text: **Devices → Use as display**; under *Who can show text on this device?* toggle the friends you trust (default: nobody). Tap **Open display mode**.
4. Your friend taps you in **Friends** (online + allowed) → type → **Send**. Toggle *Show as I type* for live text, **Capture on their device** for a remote photo, **Save image** to export photo + text.

## Remote capture (real photo → Controller's clipboard)
1. **Trigger:** the Controller taps *Capture*. A `capture` event goes over a **private Realtime Broadcast** channel (`cap:<viewerDevice>`, not a DB insert). Only the device's owner may *listen* on a channel; everyone else only *sends* (over HTTPS, `httpSend`), so the access rules can stay strict. The Viewer's camera is already running at the highest resolution (ideal 4096×2160, rear camera), so it starts instantly.
2. **Real photo:** on Android Chrome the Viewer uses `ImageCapture.takePhoto()` at the camera's max still size (read once and cached when the camera starts). Elsewhere (iOS Safari) it falls back to the video frame at its native size, JPEG 0.95. Flash + vibration play on the Viewer.
3. **Two stages, in parallel:** a ~480px preview (<60 KB) is broadcast immediately; the untouched full-size photo is uploaded to the private `captures` bucket and its path is broadcast. The Controller downloads it, swaps the preview for the full image and shows an **HD** badge, then deletes the file (receipt confirmed). The Viewer also deletes any of its own files older than 1 hour.
4. **Clipboard:** the Capture click *synchronously* calls `navigator.clipboard.write([new ClipboardItem({'image/png': promise})])`; the promise resolves when the full image arrives (converted to PNG at full size). The button shows *Copying…*, then a toast with a thumbnail. If it fails or takes > 15 s you get a **Tap to copy** toast. Nothing is saved to disk (the *Save* button is manual). The last 5 captures are kept in memory only, tap a thumbnail to copy it again. The toggle **Text on copied photo** burns the current overlay text into the copy.
5. **Security:** broadcast channels and the bucket are private and protected by policies in `schema.sql` (only people allowed on that device may trigger; only the photographer and the named controller can read the file; mime/size limited to 20 MB).
6. **Measuring:** open the app once with `?debug=1` (sticky; `?debug=0` turns it off) to get a small overlay of trigger→preview, →full event, →downloaded, →clipboard, plus photo size/method on both phones. Targets: preview ≲ 1 s, full-res in clipboard ≲ 3 s on mobile data. Please measure on real phones; I could only verify the pieces in desktop Chrome with a fake camera.

Browser notes: clipboard images need Chrome/Edge/Safari (Firefox can't copy images → use *Save*). The page must be focused when the full image arrives. If your Storage setup differs, re-run `schema.sql`, which creates the bucket and policies.

## Design system
Light glassmorphism: lavender-grey gradient page, white / pastel cards (24–28px radius), white circular icon buttons, navy primary circles, pill CTAs, a floating glass nav pill. Inter font. **No photos anywhere** — only initials-on-gradient avatars, abstract gradients and inline SVG icons.

- **Tokens:** every colour is a CSS variable in `:root` of `src/index.css` (`--ink`, `--coral`, `--tint-pink/blue/green`, `--violet`/`--blush` for the hero, `--bg-from/--bg-to` for the page gradient …) mapped into Tailwind in `tailwind.config.js`. Change them there and the whole app follows. Shared classes: `ui-btn-dark`, `ui-btn-light`, `ui-field`, `ui-card`, `ui-glass`.
- **Layout:** mobile-first; app screens sit in a centred column, max 430px on desktop.
- **Home:** greeting, gradient hero ("Snap. Send. Show." + *Start a Snap*), stat chips (Friends Online · Devices · Snaps Today), *Your Friends* pastel cards, rooms you're in, *Your Devices* with display toggle + per-friend permissions.
- **Nav pill:** Home · Messages (friends) · big **+** (quick-send sheet: pick a friend/device, start or join a room) · Devices · Profile (settings). Display mode opens from *Open display mode* on your device card.
- **The call screen:** `src/screens/CallScreen/` holds it unchanged, with its own copies of the few shared pieces it uses and a `CallScope` that pins its original tokens and page background, so restyling the rest of the app can never alter it. Its logic is wired in from `src/pages/Room.tsx` through props only. (One approved change: the control pill's third button is now a chat button that opens a *Text everyone* sheet and sends your text to every room member's on-screen device; sharing the link lives in the invite card and the ⋮ menu.)

## Rooms (Meet-style, with real shared video)
**+ / Start a room** creates a room with a code like `abc-defg-hij` and a link `/r/abc-defg-hij`. Anyone signed in who opens the link (or types the code on Home) joins, up to 8 people, for 12 hours.

- **Setup:** run these once in the Supabase SQL Editor, in order (each is small and safe to re-run): `supabase/video-update.sql` (video & voice), then `supabase/update-waiting-room-avatars.sql` (waiting room + profile pictures). Until you do, rooms still work: anyone with the link walks straight in and avatars show initials.
- **Waiting room:** with it on (the default for new rooms) a stranger who opens the link waits on a "Waiting to be let in…" screen. The host sees "X wants to join" with **Admit / Deny** over the call (and a "N waiting" note on the minimised bar), and the host can switch the waiting room off/on in Room details. The old direct-join route is closed server-side for waiting-room rooms. Leaving the waiting screen withdraws your request; a denied person cannot ask again.
- **Ping sounds:** a short synthesised ping plays when someone asks to join (host), when someone joins, when you are let in, and when a text arrives; switch them off in Room details (remembered on the device).
- **Profile picture:** signing in with Google uses your Google photo as your avatar (others see it too); email-link accounts and failed images show the initial.
- **Shared video + voice:** turn your camera on and everyone sees it in your tile; unmute the microphone and everyone hears you (peer-to-peer WebRTC; the media itself never touches the server). The mic starts muted, uses echo cancellation + noise suppression, and whoever is speaking gets a green ring on their tile. Signalling uses the room's **private** Realtime channel `room:<roomId>`, which only members of that room can read or write (policy in `supabase/schema.sql`: re-run it after updating). Uses public STUN; add a TURN server via `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` for strict networks.
- **Tap a tile** to maximise it. In the maximised view, **Snapshot** copies the current frame (full resolution PNG) to your clipboard — nothing is saved to disk. If their camera is off, Snapshot is disabled.
- **Who's shown:** only people who are in the call right now (live from the connection, with a heartbeat every 4 s). Someone who closes the tab or loses signal disappears within ~11 s (immediately if they press Leave); someone joining appears instantly, no reload.
- **Four buttons:** mic · camera · text everyone · leave. The layout is responsive: phones stack tiles; tablets and desktops put them side by side and use the full width. Room details (code, QR, link, display mode, leave) are in the top-right menu.
- **Text everyone:** your text flashes for 5 s on every room member's screen. Joining a room turns your screen "on" for text automatically (switch it off in Room details).
- Leaving removes you; if the host leaves, the room ends for everyone.

- **Screen stays awake** while you're in a room (Screen Wake Lock; needs Chrome/Edge/Android or iOS 16.4+ Safari).

## Updates
The app stamps every build (`/version.json`) and checks it when opened, every minute and when you return to it: an outdated cached copy updates itself right after opening (once, no loop), otherwise you get an **Update** button so a call is never interrupted.

Pages are fetched from the network first (falling back to the last copy when offline) and a new deploy never force-reloads the page, so there is no "old version then reload" flicker. The app still opens offline.


**Check the database has the video/voice rules** (SQL Editor):
```sql
select policyname from pg_policies where schemaname = 'realtime' and tablename = 'messages' order by 1;
```
You should see 4 rows: `snap_cap_receive`, `snap_cap_send`, `snap_room_receive`, `snap_room_send`. Fewer = `supabase/schema.sql` was not fully applied: run the whole file again and read the result panel for an error (the SQL Editor stops at the first one).

## Back button
The phone's Back button steps back inside the app instead of closing it: sheets and the maximised tile close first; bottom-nav tabs behave like tabs (Back from any tab goes Home); opening a link straight into a screen puts Home underneath. Back on Home leaves the app, as on any Android app. (`src/lib/nav.ts`)

## Data model (see `supabase/schema.sql`)
| table | purpose |
|---|---|
| `profiles` | username (unique, immutable), display name, avatar colour, friend code |
| `friendships` | ordered pair `(user_a < user_b)`, `status` pending/accepted/blocked |
| `devices` | one row per browser: name, `is_display`, `last_seen` |
| `device_allowed` | owner allows a specific friend on a specific device (default: none) |
| `rooms`, `room_members`, `room_devices` | Meet-style rooms and the devices members put on screen for text |
| `messages` | `text / clear / capture / photo`, ≤500 chars, `expire_at` = +24h |

**Security model:** tables have no direct insert/update policies for anything cross-user. Friend actions and all sends go through RPCs (`add_friend`, `accept_friend`, `block_user`, `send_message`, `send_live`, `send_photo`, …) that check friendship, per-device permission, blocks, payload size and rate (5 msgs/s), and set the sender name server-side. Only sender and recipient can read a message. A photo can only be sent as a reply to a capture request addressed to the photographer.

**Presence:** each open app calls `touch_device` every 30 s (server clock); online = `last_seen` < 60 s old.
**Live typing:** `send_live` overwrites one row per (sender, device) instead of creating many.
**Remote capture** (details above) uses private Realtime Broadcast + a private Storage bucket, not database rows.

## Free-plan notes
Free projects pause after ~1 week of inactivity (just click *Restore*). Realtime and DB limits are ample for a friends-scale app. One always-open device issues ~2,900 tiny heartbeat calls/day.

## Tests
```bash
npm test            # runs schema.sql in real Postgres (PGlite) with a stubbed auth schema
```
53 tests (incl. rooms, and the private broadcast channels + storage policies for remote capture): unique usernames, immutable username/code, friend request/accept/block semantics, per-device permission, un-friending revokes access, message validation, rate limit, read isolation, live-row overwrite, photo-only-as-reply.

## Scripts
`npm run dev | build | lint | typecheck | test | icons`. `npm run icons` regenerates the PNG icons from `public/logo.svg`.

## Limits
- iOS Safari has no `navigator.vibrate`; the flash still plays.
- Magic links opened in a different browser than requested may need a re-request.

## Calling, layouts and updates

- **Call a friend:** the camera button on a friend's card on Home rings them (needs `supabase/update-calling.sql`, run once in the SQL Editor). They get an Accept / Decline card with a ring sound; you're told if they decline or don't answer.
- **Waiting room preview:** while waiting to be let in you can check your camera/mic first.
- **Layouts:** Auto (two people: the other person big and you small like WhatsApp; 3+: grid), Grid, Spotlight. Drag the small video to move it, drag its corner to resize it, drag the divider between the big tile and the strip. Pin someone for yourself or for everyone.
- **Updates:** outside a call the app updates itself with a quiet "Updating…" animation and a small "Updated" check afterwards; during a call it only shows an "Update now / Later" card. The website and the installed app use the same check.

## Android app (real incoming-call screen)

`android-app/` is a small native Android app that opens Snapnote full screen (a Trusted Web Activity, so Google sign-in, camera and WebRTC work) and adds what a website can't do: a full-screen incoming call over the lock screen with a looping ringtone (`IncomingCallActivity`, `CallRinger`), driven by Firebase push (`SnapMessagingService`). The server (`api/ring.js`) sends it one high-priority push per call and a "cancel" when the call stops ringing.

- Install: open `https://snapnote.rishit.site/snapnote.apk` on the phone (Settings → Calls also links to it).
- Firebase setup (once): create a Firebase project, add an Android app with package `site.rishit.snapnote`, copy `apiKey / appId / projectId / senderId` from `google-services.json` into `android-app/firebase.properties`, put the service-account JSON (Project settings → Service accounts → Generate new private key) in the Vercel env var `FIREBASE_SERVICE_ACCOUNT`.
- Build: `cd android-app && gradlew assembleRelease`, then copy `app/build/outputs/apk/release/app-release.apk` to `public/snapnote.apk`. The signing key lives outside the project (`~/android-sdk/keys`) and its SHA-256 is published in `public/.well-known/assetlinks.json`; keep that key, or phones must reinstall.
