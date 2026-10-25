/**
 * The camera, and everything that looks through it.
 *
 * One stream, shared. Hand tracking wants it, the camera blade wants it, and
 * looking at something wants it — and a second getUserMedia makes Chrome drop
 * the first, so anything that opens its own would silently blind the others.
 * Everything here goes through one refcounted handle.
 *
 * Three ways of seeing, because "look at this" means three different things:
 *
 *   grabFrame   — one photograph. What is in front of me right now.
 *   watchAhead  — the next few seconds, as a grid. What am I doing.
 *   recentGrid  — the last few seconds, as a grid. What did I just do.
 *
 * The grid is the whole trick for the last two. A model sees images, not video,
 * so a clip has to become a contact sheet: frames sampled evenly, laid out in
 * reading order, each stamped with its offset so the order is unambiguous and
 * the model can talk about timing rather than just contents.
 *
 * Nothing is written to disk and nothing leaves the machine except the single
 * still that a tool call returns. The rolling buffer exists only while the
 * camera is open and is dropped the moment it closes.
 */

/** Frames per second kept in the rolling buffer. Enough to catch a gesture,
 *  cheap enough to run alongside hand tracking. */
const BUFFER_FPS = 6
/** How much past to keep. Long enough for "what did I just do", short enough
 *  that the memory cost is a few megabytes rather than a few hundred. */
const BUFFER_SECONDS = 10

/** Each cell in a contact sheet. Small on purpose — nine of these is already a
 *  large image, and detail past this adds tokens rather than understanding. */
const CELL_W = 426
const CELL_H = 240

/**
 * Which camera. The Mac has more than one, pointed at different things:
 *
 *   face — the built-in camera, at the person. Hand tracking and "look at me".
 *   desk — the Logitech webcam, at the desk. "Look at my table", "what is
 *          this on my desk".
 *
 * Each is its own stream with its own holders, so the hands can stay on the
 * face camera while the desk one is open on a blade. The one-stream rule below
 * is per camera: two getUserMedia calls on the SAME device make Chrome drop
 * the first, two different devices are fine.
 */
export type Which = 'face' | 'desk'

/** How the desk camera is recognised by name. The C270 calls itself "C270 HD
 *  WEBCAM"; other Logitech models say Logitech or C9xx. */
const DESK_NAME = /logitech|c270|c9[0-9]{2}|brio|webcam/i
/** Never the desk camera: the built-in one, an iPhone through Continuity, or
 *  the iPhone's Desk View. */
const NOT_DESK = /facetime|macbook|built-?in|iphone|continuity|desk view/i
const FACE_NAME = /facetime|macbook|built-?in/i

type Eye = {
  stream: MediaStream | null
  video: HTMLVideoElement | null
  /** How many things currently need this camera. It closes at zero, not before. */
  holders: number
  /** A hold in progress, so two callers at once share one getUserMedia. */
  opening: Promise<HTMLVideoElement> | null
  buffer: Shot[]
  bufferTimer: ReturnType<typeof setInterval> | null
}

const newEye = (): Eye => ({
  stream: null,
  video: null,
  holders: 0,
  opening: null,
  buffer: [],
  bufferTimer: null,
})
const eyes: Record<Which, Eye> = { face: newEye(), desk: newEye() }

export const diag = {
  open: false,
  holders: 0,
  buffered: 0,
  desk: '' as string,
  lastError: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__camera = diag
}

/* ------------------------------------------------------------------- stream */

/**
 * The device id for a camera, by name.
 *
 * Names are only readable once the page has camera permission; before that
 * they are blank, so a nameless list is unlocked with a brief default stream
 * and read again.
 */
async function deviceFor(which: Which): Promise<string | undefined> {
  const list = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
  let cams = await list()
  if (which === 'desk' && cams.length && cams.every((d) => !d.label)) {
    const s = await navigator.mediaDevices.getUserMedia({ video: true })
    s.getTracks().forEach((t) => t.stop())
    cams = await list()
  }
  if (which === 'face') return cams.find((d) => FACE_NAME.test(d.label))?.deviceId
  const desk =
    cams.find((d) => DESK_NAME.test(d.label) && !NOT_DESK.test(d.label)) ??
    cams.find((d) => d.label && !NOT_DESK.test(d.label))
  diag.desk = desk?.label ?? ''
  if (!desk) {
    throw new Error('The desk camera (the Logitech) is not connected. Plug it in and ask again.')
  }
  return desk.deviceId
}

async function open(which: Which): Promise<HTMLVideoElement> {
  const eye = eyes[which]
  const id = await deviceFor(which)
  eye.stream = await navigator.mediaDevices.getUserMedia({
    video: id
      ? { deviceId: { exact: id }, width: 1280, height: 720 }
      : { width: 1280, height: 720, facingMode: 'user' },
  })
  const el = document.createElement('video')
  el.autoplay = true
  el.playsInline = true
  el.muted = true
  el.srcObject = eye.stream
  /**
   * In the page, though nobody sees it. A video element that is not in the
   * document is not rendered, and Chrome is then free to stop advancing the
   * frame it hands to drawImage — every "look" got the same old picture, so
   * a circuit board held up to the desk camera was still the highlighter
   * from the first look.
   */
  el.className = 'camera-source'
  el.setAttribute('aria-hidden', 'true')
  document.body.appendChild(el)
  await el.play()
  eye.video = el
  return el
}

const syncDiag = () => {
  diag.open = Boolean(eyes.face.video || eyes.desk.video)
  diag.holders = eyes.face.holders + eyes.desk.holders
  diag.buffered = eyes.face.buffer.length + eyes.desk.buffer.length
}

/**
 * Take a hold on a camera. Every caller must release it exactly once.
 *
 * Refcounted rather than "open if closed", because the failure mode of getting
 * that wrong is invisible: whoever closes it last takes the picture away from
 * everyone still using it, and the symptom is another feature going blind for
 * reasons that have nothing to do with it.
 */
export async function holdCamera(which: Which = 'face'): Promise<HTMLVideoElement> {
  const eye = eyes[which]
  eye.holders++
  syncDiag()
  if (eye.video && eye.stream) return eye.video
  try {
    eye.opening ??= open(which).finally(() => {
      eye.opening = null
    })
    const el = await eye.opening
    diag.lastError = ''
    syncDiag()
    return el
  } catch (err) {
    // The hold is given back on failure, or the count drifts up for ever and
    // the camera can never be closed.
    eye.holders = Math.max(0, eye.holders - 1)
    eye.stream?.getTracks().forEach((t) => t.stop())
    eye.stream = null
    eye.video = null
    syncDiag()
    diag.lastError = String((err as Error)?.message ?? err)
    throw err
  }
}

/** Give back a hold. The camera light goes out when the last one does. */
export function releaseCamera(which: Which = 'face'): void {
  const eye = eyes[which]
  eye.holders = Math.max(0, eye.holders - 1)
  syncDiag()
  if (eye.holders > 0) return
  stopBuffer(which)
  if (eye.video) {
    eye.video.pause()
    eye.video.srcObject = null
    eye.video.remove()
    eye.video = null
  }
  // Stopping every track is what actually extinguishes the hardware light.
  // Anything less leaves it on, and a user who sees that is right to distrust
  // every other claim this interface makes about its camera.
  eye.stream?.getTracks().forEach((t) => t.stop())
  eye.stream = null
  syncDiag()
}

export const cameraLive = (which: Which = 'face') => Boolean(eyes[which].video && eyes[which].stream)
export const cameraStream = (which: Which = 'face') => eyes[which].stream

/* -------------------------------------------------------------------- frames */

function drawTo(which: Which, canvas: HTMLCanvasElement, w: number, h: number) {
  const ctx = canvas.getContext('2d')
  const video = eyes[which].video
  if (!ctx || !video) return null
  canvas.width = w
  canvas.height = h
  /**
   * Drawn unmirrored, deliberately.
   *
   * The hand overlay mirrors its coordinates because a mirror is what a person
   * expects to see of themselves. The raw frame is not mirrored, and for
   * looking at something that is the correct choice: hold a label up to the
   * camera and the raw frame reads it the right way round, while a mirrored
   * one hands the model text backwards.
   */
  ctx.drawImage(video, 0, 0, w, h)
  return ctx
}

const toJpeg = (canvas: HTMLCanvasElement, q = 0.82) => {
  const url = canvas.toDataURL('image/jpeg', q)
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/jpeg' }
}

/** A camera that has only just opened can report no size for a moment. */
async function ready(which: Which) {
  for (let i = 0; i < 40 && !eyes[which].video?.videoWidth; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!eyes[which].video?.videoWidth) throw new Error('the camera is not ready')
}

/**
 * One frame, full size — taken from the camera now, not from the video.
 *
 * ImageCapture asks the camera track itself for its next frame, so the picture
 * is always the current one whatever the video element is doing. The video is
 * the fallback for browsers without it.
 */
export async function grabFrame(which: Which = 'face'): Promise<{ data: string; mimeType: string }> {
  await ready(which)
  const track = eyes[which].stream?.getVideoTracks()[0]
  const Capture = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture
  if (track && Capture) {
    try {
      const bitmap = await new Capture(track).grabFrame()
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      bitmap.close()
      return toJpeg(canvas)
    } catch {
      /* fall back to the video below */
    }
  }
  const v = eyes[which].video!
  const canvas = document.createElement('canvas')
  if (!drawTo(which, canvas, v.videoWidth, v.videoHeight)) {
    throw new Error('could not read the camera frame')
  }
  return toJpeg(canvas)
}

/* -------------------------------------------------------------------- buffer */

type Shot = { at: number; bitmap: HTMLCanvasElement }

/**
 * Start remembering the recent past.
 *
 * Frames are kept as small canvases rather than as encoded images: encoding
 * costs real time and most of these are thrown away unlooked-at, so paying for
 * it up front would be paying six times a second for something used once.
 */
export function startBuffer(which: Which = 'face'): void {
  const eye = eyes[which]
  if (eye.bufferTimer) return
  eye.bufferTimer = setInterval(() => {
    if (!eye.video?.videoWidth) return
    const cell = document.createElement('canvas')
    if (!drawTo(which, cell, CELL_W, CELL_H)) return
    eye.buffer.push({ at: performance.now(), bitmap: cell })
    const cutoff = performance.now() - BUFFER_SECONDS * 1000
    while (eye.buffer.length && eye.buffer[0].at < cutoff) eye.buffer.shift()
    syncDiag()
  }, 1000 / BUFFER_FPS)
}

export function stopBuffer(which: Which = 'face'): void {
  const eye = eyes[which]
  if (eye.bufferTimer) clearInterval(eye.bufferTimer)
  eye.bufferTimer = null
  eye.buffer = []
  syncDiag()
}

/* --------------------------------------------------------------------- grids */

/**
 * Lay frames out as a contact sheet.
 *
 * Reading order, left to right and top to bottom, with each cell stamped with
 * its offset in seconds. The stamps are not decoration: without them a model
 * looking at nine similar frames has no way to know which came first, and will
 * describe a sequence of events in whatever order it happens to read them.
 */
function contactSheet(
  shots: { at: number; bitmap: HTMLCanvasElement }[],
  originAt: number,
): { data: string; mimeType: string } {
  const n = shots.length
  const cols = n <= 2 ? n : n <= 6 ? 3 : 4
  const rows = Math.ceil(n / cols)
  const canvas = document.createElement('canvas')
  canvas.width = cols * CELL_W
  canvas.height = rows * CELL_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('could not build the grid')

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  shots.forEach((shot, i) => {
    const x = (i % cols) * CELL_W
    const y = Math.floor(i / cols) * CELL_H
    ctx.drawImage(shot.bitmap, x, y, CELL_W, CELL_H)

    const label = `${i + 1}  ${((shot.at - originAt) / 1000).toFixed(1)}s`
    ctx.font = '600 22px ui-monospace, monospace'
    // Drawn twice — dark underneath, light on top — so the stamp survives both
    // a bright frame and a dark one without a panel behind it.
    ctx.lineWidth = 4
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(label, x + 12, y + 30)
    ctx.fillStyle = '#fff'
    ctx.fillText(label, x + 12, y + 30)

    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, CELL_H - 1)
  })

  return toJpeg(canvas, 0.78)
}

/** Evenly spaced picks, always including the first and last. */
function sample<T>(items: T[], want: number): T[] {
  if (items.length <= want) return items
  const out: T[] = []
  for (let i = 0; i < want; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (want - 1))])
  }
  return out
}

/**
 * Watch for the next few seconds and hand back a grid.
 *
 * Forward-looking, so it is the right tool for "watch me do this" — the answer
 * is about something that has not happened yet when the question is asked.
 */
export async function watchAhead(
  seconds: number,
  frames: number,
  which: Which = 'face',
): Promise<{ data: string; mimeType: string }> {
  await ready(which)
  const shots: Shot[] = []
  const started = performance.now()
  const gap = (seconds * 1000) / Math.max(1, frames - 1)

  for (let i = 0; i < frames; i++) {
    const cell = document.createElement('canvas')
    if (drawTo(which, cell, CELL_W, CELL_H)) {
      shots.push({ at: performance.now(), bitmap: cell })
    }
    if (i < frames - 1) await new Promise((r) => setTimeout(r, gap))
  }
  if (!shots.length) throw new Error('no frames were captured')
  return contactSheet(shots, started)
}

/**
 * The last few seconds, as a grid.
 *
 * Only possible while the buffer is running, which it is whenever the camera
 * blade is open. This is what answers "what did I just do" — a question that
 * cannot be answered by starting to record when it is asked.
 */
export function recentGrid(
  seconds: number,
  frames: number,
  which: Which = 'face',
): { data: string; mimeType: string } | null {
  const cutoff = performance.now() - seconds * 1000
  const window = eyes[which].buffer.filter((s) => s.at >= cutoff)
  if (window.length < 2) return null
  const picked = sample(window, frames)
  return contactSheet(picked, picked[0].at)
}

export const bufferedSeconds = (which: Which = 'face') => {
  const buffer = eyes[which].buffer
  return buffer.length < 2 ? 0 : (buffer[buffer.length - 1].at - buffer[0].at) / 1000
}
