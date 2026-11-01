/** Opening the camera, with failures explained in plain words instead of one generic "blocked". */

export type CameraProblem = 'insecure' | 'unsupported' | 'denied' | 'none' | 'busy' | 'other'

export class CameraError extends Error {
  constructor(public kind: CameraProblem, message: string) { super(message) }
}

function explain(e: unknown, what = 'camera'): CameraError {
  const name = (e as { name?: string })?.name ?? ''
  const Cap = what[0].toUpperCase() + what.slice(1)
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return new CameraError('denied', `${Cap} permission is blocked. Click the lock icon in the address bar, allow the ${what}, then reload.`)
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError')
    return new CameraError('none', `No ${what} was found on this device.`)
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')
    return new CameraError('busy', `The ${what} is in use by another app or browser tab. Close it and try again.`)
  return new CameraError('other', `Couldn't start the ${what}${name ? ` (${name})` : ''}.`)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Ask for the camera with the preferred constraints; fall back to "any camera" if they can't be met,
 * and retry once if the device is momentarily busy (e.g. a previous stream is still being released).
 */
export async function openCamera(preferred: MediaTrackConstraints): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw window.isSecureContext
      ? new CameraError('unsupported', "This browser can't use the camera.")
      : new CameraError('insecure', 'The camera only works over HTTPS (or on localhost). You opened the app over plain http — use the https:// address.')
  }
  const gum = (video: boolean | MediaTrackConstraints) => navigator.mediaDevices.getUserMedia({ video, audio: false })
  try {
    return await gum(preferred)
  } catch (e) {
    const name = (e as { name?: string })?.name
    try {
      if (name === 'OverconstrainedError' || name === 'TypeError') return await gum(true)
      if (name === 'NotReadableError' || name === 'AbortError') { await wait(600); return await gum(preferred) }
    } catch (e2) { throw explain(e2) }
    throw explain(e)
  }
}

/** Microphone for talking in a room: echo cancellation, noise suppression and auto-gain are on. */
export async function openMic(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw window.isSecureContext
      ? new CameraError('unsupported', "This browser can't use the microphone.")
      : new CameraError('insecure', 'The microphone only works over HTTPS (or on localhost). Use the https:// address.')
  }
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false })
  } catch (e) {
    const name = (e as { name?: string })?.name
    try { if (name === 'NotReadableError' || name === 'AbortError') { await wait(600); return await navigator.mediaDevices.getUserMedia({ audio, video: false }) } }
    catch (e2) { throw explain(e2, 'microphone') }
    throw explain(e, 'microphone')
  }
}
