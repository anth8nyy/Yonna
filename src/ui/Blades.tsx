import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type Blade } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { sanitisePanelHtml } from './sanitise'
import { frameSpan, peaceScroll, pinchCount } from '../lib/hands'
import * as camera from '../lib/camera'
import * as sfx from '../lib/sfx'
import { createSpeaker } from '../lib/tts'
import { isGreek } from '../lib/lang'

/**
 * The blades.
 *
 * This file used to be six slivers of light raking across the frame while a
 * tool ran — pure atmosphere, nothing you could read. That effect is still
 * here, at the bottom, because it is still the right answer to "something is
 * happening". But the name now belongs to the surface it was decorating.
 *
 * A panel is a card you glance at while listening: a figure, three headlines, a
 * status line. A blade is the thing you actually look at. The distinction is
 * not styling, it is geometry — an article you are meant to READ needs a column
 * of a particular width and a height you can scroll, and no amount of care
 * makes that work inside a 320px card stacked beside the reactor. So blades own
 * their size, they stack instead of replacing one another, and the user can
 * pull an older one forward or throw one to full screen.
 *
 * The hard problem a blade solves is that most of the web refuses to be shown.
 * X-Frame-Options and frame-ancestors stop an article being framed, CORS stops
 * the page fetching it, and hotlink protection stops even its images loading.
 * All three are rules the origin server enforces against the *browser*, so the
 * bridge takes the browser out of it: it fetches server-side and serves the
 * result from localhost, and at that point the document in the iframe is ours.
 *
 * Nothing in this file is a special case for a particular site, and nothing
 * here sniffs a file extension. The model asks `probe_url` what a thing is and
 * says what it wants shown; this only knows how to show it.
 */

/* ------------------------------------------------------------------ sources */

/**
 * Paths that are genuinely on this machine's disk, as opposed to app-relative
 * URLs that happen to start with a slash. Mirrors the test in sanitise.ts and
 * Orbits.tsx — the list of root directories is the sort of thing that should be
 * changed in each place deliberately.
 */
const DISK_PATH =
  /^\/(Users|home|root|Volumes|Applications|System|Library|private|tmp|var|opt|mnt|media|srv|data)\//

/** Route a source through the bridge, which is the only origin that can
 *  actually fetch it — and the only one the page CSP will load from. */
function viaBridge(raw: string, route: 'img' | 'media'): string {
  const src = String(raw ?? '').trim()
  if (!src) return ''
  const path = src.replace(/^file:\/\//, '')
  if (DISK_PATH.test(path)) {
    return `${BRIDGE_HTTP_URL}/file?path=${encodeURIComponent(path)}`
  }
  if (!/^https?:\/\//i.test(src)) return src
  if (src.startsWith(`${BRIDGE_HTTP_URL}/`)) return src
  return `${BRIDGE_HTTP_URL}/${route}?url=${encodeURIComponent(src)}`
}

/** A whole document, rendered by the bridge so it can be framed at all. */
const pageUrl = (url: string, mode: 'reader' | 'live') =>
  `${BRIDGE_HTTP_URL}/page?mode=${mode}&url=${encodeURIComponent(url)}`

/**
 * The three embed hosts, and only these.
 *
 * Same closed list as the panel sanitiser, for the same reason: YouTube and
 * Vimeo will not hand over the media file, so an iframe is the only way to play
 * a result inline, and the trade for that is that the host list does not grow.
 */
function embedUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '')
  const id = (s: string) => (/^[\w-]{6,20}$/.test(s) ? s : null)

  if (host === 'youtube.com' && url.pathname === '/watch') {
    const v = id(url.searchParams.get('v') ?? '')
    return v && `https://www.youtube-nocookie.com/embed/${v}`
  }
  if (host === 'youtu.be') {
    const v = id(url.pathname.slice(1))
    return v && `https://www.youtube-nocookie.com/embed/${v}`
  }
  if (host === 'youtube-nocookie.com' && /^\/embed\/[\w-]+/.test(url.pathname)) return url.href
  if (host === 'vimeo.com') {
    const v = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return /^\d+$/.test(v) ? `https://player.vimeo.com/video/${v}` : null
  }
  if (host === 'player.vimeo.com' && /^\/video\/\d+/.test(url.pathname)) return url.href
  return null
}

/* --------------------------------------------------------------------- body */

/**
 * What goes inside a blade.
 *
 * Every iframe is sandboxed. `allow-same-origin` is deliberately absent from
 * the proxied-page case: that document is served from the bridge's own origin —
 * the one origin permitted to open the agent socket — so granting it
 * same-origin would let a page Yonna found on the web reach that socket. It
 * does not need it. It is being read, not run.
 */
/**
 * The live camera, on screen.
 *
 * Holding the camera for as long as the blade is open does two jobs. It shows
 * the user what Yonna can see, which is the honest way to run a camera; and it
 * starts the rolling buffer, which is the only reason "what did I just do" can
 * ever be answered — a question that cannot be satisfied by starting to record
 * at the moment it is asked.
 *
 * Mirrored here and only here. A person expects their own image to behave like
 * a reflection, so the preview is flipped for them; the frames handed to the
 * model are not, because a label held up to the lens has to arrive the right
 * way round.
 */
const CameraView = memo(function CameraView({ which }: { which: camera.Which }) {
  const el = useRef<HTMLVideoElement>(null)
  const [failed, failed_] = useState<string | null>(null)

  useEffect(() => {
    let held = false
    let gone = false
    void camera
      .holdCamera(which)
      .then((source) => {
        if (gone) {
          camera.releaseCamera(which)
          return
        }
        held = true
        camera.startBuffer(which)
        if (el.current && source.srcObject) el.current.srcObject = source.srcObject
      })
      .catch((err: DOMException) =>
        failed_(
          err?.name === 'NotAllowedError'
            ? 'Camera access is not permitted.'
            : `The camera could not be opened: ${err?.message ?? err}`,
        ),
      )
    return () => {
      gone = true
      if (held) camera.releaseCamera(which)
    }
  }, [which])

  if (failed) return <p className="bl-note">{failed}</p>
  // The desk camera is not mirrored: it looks at the desk, not at you, and a
  // mirrored desk puts everything on the wrong side.
  return (
    <video
      ref={el}
      className={`bl-camera${which === 'desk' ? ' is-desk' : ''}`}
      autoPlay
      playsInline
      muted
    />
  )
})

/**
 * A live countdown. Counts from the bridge's clock (same machine), so a reload
 * or a slow tab never drifts it — it always shows the real time left. At zero
 * it flashes, chimes and says so, once.
 */
/** Spoken reminders after a countdown ends, until acknowledged. */
const REMIND_EVERY_MS = 30_000
const REMINDERS = 5

function TimerView({ blade }: { blade: Blade }) {
  const endsAt = blade.endsAt ?? Date.now()
  const total = Math.max(1, blade.durationMs ?? 1)
  const [now, setNow] = useState(() => Date.now())
  const announced = useRef(false)
  const left = Math.max(0, endsAt - now)
  const done = left === 0

  useEffect(() => {
    if (done) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [done])

  /**
   * Say it out loud — and keep saying it. Once is easy to miss from across the
   * room, so the reminder repeats every REMIND_EVERY_MS until it is
   * acknowledged (a click on the panel, or closing it), up to REMINDERS times.
   */
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => {
    if (!done || acknowledged) return
    // A countdown that ended long ago (say, before a reload) is not news.
    if (Date.now() - endsAt > 60_000) return
    const label = blade.title && blade.title !== 'COUNTDOWN' ? `the ${blade.title.toLowerCase()} countdown` : 'your countdown'
    let said = 0
    const remind = () => {
      if (said >= REMINDERS) return
      sfx.play('done')
      const spk = createSpeaker()
      spk.say(said === 0 ? `Sir, ${label} is complete.` : `Sir, a reminder: ${label} has finished.`)
      void spk.end()
      said++
    }
    if (!announced.current) {
      announced.current = true
      remind()
    }
    const t = setInterval(remind, REMIND_EVERY_MS)
    return () => clearInterval(t)
  }, [done, acknowledged, endsAt, blade.title])

  const secs = Math.ceil(left / 1000)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const sec = secs % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  const shown = h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`

  return (
    <div
      className={`bl-timer${done ? ' is-done' : ''}${acknowledged ? ' is-acked' : ''}`}
      onPointerDown={() => done && setAcknowledged(true)}
    >
      <div className="bl-timer-time">{done ? 'TIME’S UP' : shown}</div>
      <div className="bl-timer-bar">
        <div className="bl-timer-fill" style={{ width: `${(left / total) * 100}%` }} />
      </div>
      {done && !acknowledged && <div className="bl-timer-hint">click to stop the reminder</div>}
    </div>
  )
}

/** Ticks: re-renders the caller every `ms` with the current time. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * A live clock — "what time is it" used to put up a picture of the time that
 * then sat there going stale. This keeps ticking, here or in another zone.
 */
function ClockView({ blade }: { blade: Blade }) {
  const now = useNow(1000)
  const locale = isGreek() ? 'el-GR' : 'en-GB'
  const zone = blade.timeZone ? { timeZone: blade.timeZone } : {}
  const time = new Date(now).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, ...zone })
  const date = new Date(now).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', ...zone })
  const tzName =
    new Intl.DateTimeFormat(locale, { timeZoneName: 'short', ...zone })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  return (
    <div className="bl-timer bl-clock">
      <div className="bl-timer-time">{time}</div>
      <div className="bl-clock-date">
        {date}
        {tzName ? ` — ${tzName}` : ''}
      </div>
    </div>
  )
}

/** A stopwatch counting up from when it was started; click to pause/resume. */
function StopwatchView({ blade }: { blade: Blade }) {
  const [paused, setPaused] = useState<number | null>(null) // elapsed ms when paused
  const [offset, setOffset] = useState(0) // time spent paused, so resume continues
  const now = useNow(paused === null ? 100 : 60_000)
  const start = blade.startedAt ?? now
  const elapsed = paused ?? Math.max(0, now - start - offset)
  const toggle = () => {
    if (paused === null) setPaused(elapsed)
    else {
      setOffset(Date.now() - start - paused)
      setPaused(null)
    }
  }
  const total = Math.floor(elapsed / 100)
  const tenths = total % 10
  const secs = Math.floor(total / 10) % 60
  const mins = Math.floor(total / 600) % 60
  const hrs = Math.floor(total / 36000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    <div className={`bl-timer${paused !== null ? ' is-acked' : ''}`} onPointerDown={toggle} style={{ cursor: 'pointer' }}>
      <div className="bl-timer-time">
        {hrs ? `${hrs}:` : ''}
        {pad(mins)}:{pad(secs)}
        <span className="bl-stopwatch-tenths">.{tenths}</span>
      </div>
      <div className="bl-timer-hint">{paused !== null ? 'paused — click to resume' : 'click to pause'}</div>
    </div>
  )
}

const Body = memo(function Body({ blade }: { blade: Blade }) {
  if (blade.kind === 'camera') return <CameraView which={blade.camera === 'desk' ? 'desk' : 'face'} />
  if (blade.kind === 'timer') return <TimerView blade={blade} />
  if (blade.kind === 'clock') return <ClockView blade={blade} />
  if (blade.kind === 'stopwatch') return <StopwatchView blade={blade} />

  if (blade.kind === 'article' && blade.url) {
    return (
      <iframe
        className="bl-frame"
        src={pageUrl(blade.url, blade.mode ?? 'reader')}
        // allow-scripts WITHOUT allow-same-origin. That combination is the
        // point: the page runs in an opaque origin, so the one script the
        // bridge injects can move the document's own scroll position and can
        // reach nothing of ours — not this origin, not the agent socket. Adding
        // allow-same-origin would hand a page found on the web the keys.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'embed' && blade.url) {
    const embed = embedUrl(blade.url)
    if (!embed) return <p className="bl-note">That video link could not be played.</p>
    return (
      <iframe
        className="bl-frame"
        src={embed}
        // A player genuinely needs scripts and its own origin. Nothing that
        // reaches the room the user is sitting in is granted.
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="no-referrer"
        allowFullScreen
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'video' && blade.url) {
    return (
      <video
        className="bl-video"
        src={viaBridge(blade.url, 'media')}
        controls
        playsInline
        preload="metadata"
      />
    )
  }

  if (blade.kind === 'image' && blade.url) {
    return <img className="bl-image" src={viaBridge(blade.url, 'img')} alt={blade.title} />
  }

  if (blade.kind === 'gallery') {
    return (
      <div className="bl-gallery">
        {(blade.images ?? []).map((src, i) => (
          <img key={`${src}-${i}`} className="bl-thumb" src={viaBridge(src, 'img')} alt="" />
        ))}
      </div>
    )
  }

  if (blade.kind === 'markup' && blade.html) {
    // Model-authored markup gets exactly the treatment panel markup gets.
    // There is one sanitiser, and this is it.
    return (
      <div
        className="bl-markup p-body"
        dangerouslySetInnerHTML={{ __html: sanitisePanelHtml(blade.html) }}
      />
    )
  }

  return <p className="bl-note">Nothing to show.</p>
})

/* -------------------------------------------------------------------- card */

/** Release speed is measured over this much of the end of a drag. */
const THROW_WINDOW_MS = 110
/** Slower than this (px/ms) on release is a placement, not a throw. */
const THROW_MIN_SPEED = 0.35
/** Fraction of speed kept per 16ms frame while gliding. */
const THROW_FRICTION = 0.93
/** Once this much of a thrown blade is off-screen, it is dismissed. */
const THROW_AWAY_FRACTION = 0.6

function Card({
  blade,
  depth,
  focused,
  expanded,
  onFocus,
  onExpand,
  onClose,
}: {
  blade: Blade
  /** 0 is front-most. Drives the offset and the dimming behind it. */
  depth: number
  focused: boolean
  expanded: boolean
  onFocus: () => void
  onExpand: () => void
  onClose: () => void
}) {
  /** Size the user has dragged this blade to, overriding the class preset. */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  /** Where the user has dragged it, relative to its slot. */
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const shell = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)

  /**
   * Scroll whatever this blade is showing.
   *
   * Two destinations, because a blade holds two different kinds of thing. Its
   * own overflow for markup and galleries; a postMessage for an article, since
   * an iframe is a separate document that the parent cannot scroll directly —
   * see the shim in bridge/page.mjs.
   */
  const scrollContent = (dy: number) => {
    const el = body.current
    if (!el) return
    const frame = el.querySelector('iframe')
    if (frame?.contentWindow) {
      frame.contentWindow.postMessage({ yonna: 'scroll', dy }, '*')
    } else {
      el.scrollTop += dy
    }
  }

  /**
   * Drag and resize both listen on `window`, and that is the whole trick.
   *
   * The obvious implementations do not work by hand. framer-motion's own drag
   * tracks the pointer through internals we cannot reach, and the resize grip
   * originally listened on the grip element — but the hand controller aims its
   * synthetic events with elementFromPoint, and one pixel into a drag the
   * element under the cursor is no longer the grip. So resizing by hand died on
   * the first frame, and dragging never started at all.
   *
   * Listening on window fixes both for free: a synthetic event dispatched at
   * whatever is under the cursor still bubbles to window, so these handlers see
   * a hand and a mouse identically. Which is the property the gesture layer was
   * designed around — one interaction, not two implementations of it.
   */
  const grab = (
    e: React.PointerEvent,
    onMove: (dx: number, dy: number) => void,
    onRelease?: (vx: number, vy: number) => void,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    stopFling()
    const sx = e.clientX
    const sy = e.clientY
    let baseX = sx
    let baseY = sy
    let dx = 0
    let dy = 0
    /** Recent positions, for the speed at the moment of release. */
    const samples: { x: number; y: number; at: number }[] = []

    const move = (ev: PointerEvent) => {
      const now = performance.now()
      samples.push({ x: ev.clientX, y: ev.clientY, at: now })
      while (samples.length > 2 && now - samples[0].at > THROW_WINDOW_MS) samples.shift()
      /**
       * Both hands pinching means this is not a drag.
       *
       * One pinch is a grab. Two is somebody doing something two-handed, and
       * whichever hand happened to press first should not be hauling the blade
       * around underneath it — the result is a blade that lurches away while
       * you are trying to do something else with both hands.
       *
       * Suppressed by re-anchoring rather than by returning early. A plain
       * return would leave the origin where the press began, so the moment one
       * hand released, the blade would leap by however far the other hand had
       * travelled in the meantime. Moving the origin with the hand keeps the
       * offset constant, so letting go of one hand simply resumes from here.
       */
      if (ev.pointerType === 'touch' && pinchCount() > 1) {
        baseX = ev.clientX - dx
        baseY = ev.clientY - dy
        return
      }
      dx = ev.clientX - baseX
      dy = ev.clientY - baseY
      onMove(dx, dy)
    }
    const done = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
      if (!onRelease || ev.type !== 'pointerup' || samples.length < 2) return
      // A hand that has stopped before letting go is placing, not throwing.
      const last = samples[samples.length - 1]
      if (performance.now() - last.at > THROW_WINDOW_MS) return
      const first = samples[0]
      const dt = Math.max(16, last.at - first.at)
      onRelease((last.x - first.x) / dt, (last.y - first.y) / dt)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
  }

  /**
   * Let go mid-swing and the blade keeps going.
   *
   * It glides on the speed it was released with and slows under friction, so a
   * flick moves it further than the hand did, which is what makes moving
   * things by hand feel light rather than like dragging a weight. Thrown hard
   * enough that most of it leaves the screen, it is gone: throwing a card away
   * is the gesture people reach for when they are done with it.
   */
  const fling = useRef(0)
  const stopFling = () => {
    cancelAnimationFrame(fling.current)
    fling.current = 0
  }
  useEffect(() => stopFling, [])

  const throwBlade = (vx: number, vy: number) => {
    if (Math.hypot(vx, vy) < THROW_MIN_SPEED) return
    let last = performance.now()
    const step = () => {
      const now = performance.now()
      const dt = Math.min(48, now - last)
      last = now
      const decay = Math.pow(THROW_FRICTION, dt / 16)
      vx *= decay
      vy *= decay
      setPos((p) => ({ x: p.x + vx * dt, y: p.y + vy * dt }))

      const r = shell.current?.getBoundingClientRect()
      if (r && r.width && r.height) {
        const visW = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0))
        const visH = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0))
        if ((visW * visH) / (r.width * r.height) < 1 - THROW_AWAY_FRACTION) {
          fling.current = 0
          onClose()
          return
        }
      }
      if (Math.hypot(vx, vy) < 0.02) {
        fling.current = 0
        return
      }
      fling.current = requestAnimationFrame(step)
    }
    fling.current = requestAnimationFrame(step)
  }

  const onHeadDown = (e: React.PointerEvent) => {
    // Buttons live in the header too; starting a drag from one would mean the
    // click never lands.
    if ((e.target as HTMLElement).closest('button')) return
    if (!focused) onFocus()
    if (expanded) return
    const from = { ...pos }
    grab(e, (dx, dy) => setPos({ x: from.x + dx, y: from.y + dy }), throwBlade)
  }

  /**
   * Pinch anywhere on a blade to grab it.
   *
   * This used to scroll, and moving a blade was possible only by hitting the
   * header — a strip 31 pixels tall. Asking someone to land a hand cursor on 31
   * pixels is not an interaction, and since a pinch on the body scrolled
   * instead, there was in practice no way to move a blade by hand at all.
   *
   * Grabbing is also what people try first: you see a thing and reach for it.
   * So a pinch anywhere picks the blade up, and scrolling moves to a pose that
   * is deliberate and hard to make by accident — two fingers, see the effect
   * below. Only for 'touch', which is what the gesture layer dispatches; a mouse
   * keeps its wheel and its ability to select text.
   */
  const onBodyDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return
    if (!focused) onFocus()
    if (expanded) return
    const from = { ...pos }
    grab(e, (dx, dy) => setPos({ x: from.x + dx, y: from.y + dy }), throwBlade)
  }

  /**
   * Two fingers up, moved up or down, scrolls the front blade.
   *
   * Reads a distance from hands.ts and decides here that it means scrolling —
   * the tracker publishes the pose, not the consequence.
   */
  useEffect(() => {
    if (!focused) return
    let raf = 0
    let last: number | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const travelled = peaceScroll()
      if (travelled === null) {
        last = null
        return
      }
      if (last === null) {
        last = travelled
        return
      }
      // Inverted and amplified: pulling your hand up moves you down the page,
      // and a hand does not have the travel a scroll wheel does.
      scrollContent((last - travelled) * 2.4)
      last = travelled
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [focused])

  /**
   * Frame the blade with both hands to resize it.
   *
   * Index up, thumb out, one hand either side — the rectangle people already
   * mime when they frame a shot. Pull the corners apart and the blade grows;
   * bring them together and it shrinks; lean toward the camera and it grows
   * too, because leaning in enlarges everything about the hands including the
   * gap between them.
   *
   * This replaced a two-handed pinch, which read well on paper and collided
   * badly in practice: a pinch is how you GRAB a blade, so two of them meant
   * two hands each trying to pick something up while also asking to resize it.
   * The framing pose collides with nothing, which is most of why it is right.
   *
   * The measurement arrives as a plain distance; that it means a resize is
   * decided here. Only the focused blade, and never while expanded, where the
   * size is the entire point of the state.
   */
  useEffect(() => {
    if (!focused || expanded) return
    let raf = 0
    let from: { span: number; w: number; h: number } | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const span = frameSpan()
      if (span === null) {
        from = null
        return
      }
      const box = shell.current?.getBoundingClientRect()
      if (!box) return
      if (!from) {
        // Both hands have just closed. Anchor on the size as it is now.
        from = { span, w: box.width, h: box.height }
        return
      }
      // Guard the divisor: hands almost touching would send the scale to
      // infinity and the blade off the screen in one frame.
      const k = span / Math.max(from.span, 40)
      setSize({
        w: Math.max(280, Math.min(window.innerWidth * 0.96, from.w * k)),
        h: Math.max(180, Math.min(window.innerHeight * 0.94, from.h * k)),
      })
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [focused, expanded])

  /**
   * Resize from any corner.
   *
   * The blade is centred in its slot, so a change of width moves both edges by
   * half. Shifting it by that same half keeps the opposite corner where it was
   * and the grabbed corner under the finger — before, the corner slid away
   * from the cursor at half speed, which is a lot to chase with a hand.
   */
  const onGrip = (corner: 'tl' | 'tr' | 'bl' | 'br') => (e: React.PointerEvent) => {
    const box = shell.current?.getBoundingClientRect()
    if (!box) return
    const from = { w: box.width, h: box.height, x: pos.x, y: pos.y }
    const sx = corner.endsWith('r') ? 1 : -1
    const sy = corner.startsWith('b') ? 1 : -1
    grab(e, (dx, dy) => {
      const w = Math.max(280, Math.min(window.innerWidth * 0.96, from.w + sx * dx))
      const h = Math.max(180, Math.min(window.innerHeight * 0.94, from.h + sy * dy))
      setSize({ w, h })
      setPos({ x: from.x + (sx * (w - from.w)) / 2, y: from.y + (sy * (h - from.h)) / 2 })
    })
  }

  /** Right-click menu: Stay (survive the next question) or let go again. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const setHold = useStore((st) => st.setBladeHold)
  const stays = blade.hold === 'sticky'
  // Camera blade only: the picture folded away to its title bar (the camera
  // keeps running while it is).
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && close()
    // Next tick, so the click that opened it does not also close it.
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close)
      window.addEventListener('keydown', onKey)
    })
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  /**
   * Resize from the bottom-right grip.
   *
   * Pointer capture rather than window listeners: the pointer spends most of a
   * resize over an <iframe>, and an iframe swallows mousemove from the parent
   * document entirely. Without capture the blade stops resizing the instant the
   * cursor crosses into the article it is showing, which is precisely where it
   * always crosses.
   */
  return (
    /**
     * Two elements, because two different things want the transform.
     *
     * The outer one carries the depth offset — the small lift and scale that
     * makes the stack read as objects rather than as a list. The inner one is
     * what the user drags. Framer owns `transform` on anything it animates, so
     * with both jobs on one element the drag and the stack animation overwrite
     * each other every frame and the blade jitters back to its slot.
     */
    <motion.div
      className="bl-slot"
      initial={{ opacity: 0, y: 26, scale: 0.96, filter: 'blur(6px)' }}
      animate={{
        opacity: expanded || depth === 0 ? 1 : Math.max(0.3, 1 - depth * 0.24),
        y: expanded ? 0 : depth * -13,
        x: expanded ? 0 : depth * 15,
        scale: expanded ? 1 : 1 - depth * 0.035,
        filter: depth === 0 || expanded ? 'blur(0px)' : `blur(${depth * 0.7}px)`,
      }}
      exit={{ opacity: 0, y: 18, filter: 'blur(8px)', transition: { duration: 0.28 } }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      style={{ zIndex: expanded ? 60 : 40 - depth }}
    >
      <motion.section
        ref={shell}
        className={
          `bl bl-${blade.size}` +
          (expanded ? ' bl-expanded' : '') +
          (focused ? ' bl-front' : '') +
          (collapsed ? ' bl-collapsed' : '')
        }
        // Position and size are ours rather than framer's — see `grab` above for
        // why. Applied as a plain transform because the depth animation lives on
        // the slot wrapper, so nothing is competing for this element's own one.
        style={{
          ...(size && !expanded && !collapsed ? { width: size.w, height: size.h } : null),
          transform: expanded ? undefined : `translate(${pos.x}px, ${pos.y}px)`,
        }}
        // pointerdown, not mousedown: a hand dispatches PointerEvents, and a
        // mousedown handler simply never hears them. Focusing a blade by pinch
        // was silently impossible until this changed.
        onPointerDown={() => {
          if (!focused) onFocus()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <span className="pk pk-tl" />
        <span className="pk pk-tr" />
        <span className="pk pk-bl" />
        <span className="pk pk-br" />

        <header className="bl-head" onPointerDown={onHeadDown}>
          <span className="bl-title">{blade.title}</span>
          <span className="bl-kind">{blade.kind}</span>
          {blade.kind === 'camera' && (
            <>
              <button
                className={`bl-stay${stays ? '' : ' is-off'}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setHold(blade.id, stays ? 'turn' : 'sticky')
                }}
                title={stays ? 'Stays open — click to let it close with the next question' : 'Click to keep it open'}
              >
                STAY
              </button>
              <button
                className={`bl-stay${collapsed ? '' : ' is-off'}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setCollapsed(!collapsed)
                }}
                title={collapsed ? 'Show the picture' : 'Hide the picture — the camera stays on'}
              >
                {collapsed ? 'SHOW' : 'HIDE'}
              </button>
            </>
          )}
          {stays && blade.kind !== 'camera' && (
            <button
              className="bl-stay"
              onClick={(e) => {
                e.stopPropagation()
                setHold(blade.id, 'turn')
              }}
              title="Stays through the next question — click to let it go"
            >
              STAYS
            </button>
          )}
          <span className="bl-acts">
            {Boolean(size || pos.x || pos.y) && !expanded && (
              <button
                className="bl-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  setSize(null)
                  setPos({ x: 0, y: 0 })
                }}
                title="Back where it started"
              >
                ⤾
              </button>
            )}
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onExpand()
              }}
              title={expanded ? 'Shrink (E)' : 'Full screen (E)'}
            >
              {expanded ? '⤡' : '⤢'}
            </button>
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              title="Close (X)"
            >
              ✕
            </button>
          </span>
        </header>

        <div className="bl-body" ref={body} onPointerDown={onBodyDown}>
          <Body blade={blade} />
        </div>

        {/* Resize grips on all four corners, with a generous invisible reach so
            a hand cursor does not have to land on a hairline. Absent while
            expanded, where the size is the point. */}
        {!expanded &&
          (['tl', 'tr', 'bl', 'br'] as const).map((c) => (
            <span key={c} className={`bl-grip bl-grip-${c}`} onPointerDown={onGrip(c)} title="Drag to resize" />
          ))}

        {menu &&
          createPortal(
            <div
              className="bl-menu"
              style={{ left: menu.x, top: menu.y }}
              onPointerDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                onClick={() => {
                  setHold(blade.id, stays ? 'turn' : 'sticky')
                  setMenu(null)
                }}
              >
                {stays ? 'Don’t stay' : 'Stay'}
              </button>
              <button
                onClick={() => {
                  setMenu(null)
                  onClose()
                }}
              >
                Close
              </button>
            </div>,
            document.body,
          )}
      </motion.section>
    </motion.div>
  )
}

/* ------------------------------------------------------------------- stack */

export function Blades() {
  const blades = useStore((s) => s.blades)
  const focusedBlade = useStore((s) => s.focusedBlade)
  const expandedBlade = useStore((s) => s.expandedBlade)
  const focusBlade = useStore((s) => s.focusBlade)
  const expandBlade = useStore((s) => s.expandBlade)
  const closeBlade = useStore((s) => s.closeBlade)

  /**
   * Newest first, then whichever the user pulled forward lifted to the front.
   *
   * Ordered here rather than in the store because it is a view concern, and the
   * store's array order is the history — which is what makes "the one before
   * that" a meaningful thing to ask for.
   */
  const ordered = useMemo(() => {
    const newestFirst = [...blades].reverse()
    if (!focusedBlade) return newestFirst
    const hit = newestFirst.findIndex((b) => b.id === focusedBlade)
    if (hit <= 0) return newestFirst
    const copy = [...newestFirst]
    const [lifted] = copy.splice(hit, 1)
    return [lifted, ...copy]
  }, [blades, focusedBlade])

  const front = ordered[0]

  const cycle = useCallback(
    (by: number) => {
      if (ordered.length < 2) return
      const at = ordered.findIndex((b) => b.id === front?.id)
      const next = ordered[(at + by + ordered.length) % ordered.length]
      if (next) focusBlade(next.id)
    },
    [ordered, front, focusBlade],
  )

  // Bound here rather than in App, and only while something is open, so E and X
  // are free for anything else the moment the last blade closes.
  const live = useRef(false)
  live.current = blades.length > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (useStore.getState().typing) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return

      // Physical keys, so they work on the Greek layout too.
      if (e.code === 'KeyE') {
        e.preventDefault()
        expandBlade(expandedBlade ? null : (front?.id ?? null))
      } else if (e.code === 'KeyX') {
        e.preventDefault()
        if (front) closeBlade(front.id)
      } else if (e.code === 'BracketRight') {
        e.preventDefault()
        cycle(1)
      } else if (e.code === 'BracketLeft') {
        e.preventDefault()
        cycle(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [front, expandedBlade, expandBlade, closeBlade, cycle])

  if (!blades.length) return null

  return (
    <div className={`blades-stack${expandedBlade ? ' blades-stack-full' : ''}`}>
      <AnimatePresence>
        {ordered.map((blade, i) => {
          const expanded = expandedBlade === blade.id
          // While one is expanded it is the only thing on screen; the rest are
          // unmounted rather than hidden so their iframes stop loading.
          if (expandedBlade && !expanded) return null
          return (
            <Card
              key={blade.id}
              blade={blade}
              depth={expanded ? 0 : i}
              focused={blade.id === front?.id}
              expanded={expanded}
              onFocus={() => focusBlade(blade.id)}
              onExpand={() => expandBlade(expanded ? null : blade.id)}
              onClose={() => closeBlade(blade.id)}
            />
          )
        })}
      </AnimatePresence>

      {blades.length > 1 && !expandedBlade && (
        <div className="bl-hint">
          <kbd>[</kbd> <kbd>]</kbd> cycle · <kbd>E</kbd> full · <kbd>X</kbd> close
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- the sweep */

/**
 * The original blades: slivers of light raking across the frame while a tool
 * runs. Unchanged, because it is still the right answer to "something is
 * happening" — a tool call is the one moment the interface stops being a face
 * and becomes machinery, and the reactor cannot carry that on its own.
 *
 * Deliberately CSS rather than three.js: the scene is bloomed and tone-mapped,
 * which is exactly wrong for a 1px edge. Kept in the DOM it stays a blade.
 */
const SWEEP = [1, 2, 3, 4, 5, 6]

export function BladeSweep() {
  const phase = useStore((s) => s.phase)
  const activeTool = useStore((s) => s.activeTool)

  return (
    <AnimatePresence>
      {phase === 'tooling' && (
        <motion.div
          className="blades"
          // Only opacity is animated here. The sweeps are CSS keyframes on the
          // children, and framer writes `transform` inline on anything it
          // animates — one transform prop in this list and every blade would be
          // sliding inside an element that is itself sliding.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <div className="blade-field">
            {SWEEP.map((n) => (
              <span key={n} className={`blade blade-${n}`} />
            ))}
          </div>

          {activeTool && (
            // Keyed on the name so a chain of tools re-runs the ride-in for
            // each one rather than silently swapping the text mid-sweep.
            <div className="blade-carrier">
              <span key={activeTool} className="blade-tool">
                {activeTool}
              </span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
