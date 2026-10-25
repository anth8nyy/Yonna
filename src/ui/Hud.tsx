import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore, accentFor } from '../store'
import { BladeSweep, Blades } from './Blades'
import { AgendaBox } from './Agenda'
import { Shortcuts } from './Shortcuts'
import { Welcome } from './Welcome'
import { getBrain, setBrain as bridgeSetBrain, type Brain } from '../lib/bridge'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'

/* ------------------------------------------------------------------ decode */

/**
 * The glyphs the ghost is drawn from. Uppercase, digits and rules only: the
 * point is that the unresolved text reads as *machine*, so lowercase letters
 * and anything with a descender are left out — they look like badly rendered
 * words rather than an unfinished decode.
 */
const GLYPHS = '/\\|<>[]{}=+*#%&$0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Characters of noise shown ahead of the resolved text. */
const GHOST = 22
/** Repaint interval for the scramble. ~24fps is plenty for glyph noise. */
const FRAME_MS = 42
/** Floor on the resolve rate, characters per second. */
const MIN_RATE = 110
/** The frontier is never allowed to trail the streamed text by longer. */
const MAX_LAG_MS = 420

function scramble(s: string, seed: number) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    // Whitespace is left alone so word shapes and line breaks hold still while
    // the glyphs underneath churn.
    if (c === ' ' || c === '\n' || c === '\t') {
      out += c
      continue
    }
    out += GLYPHS[(seed * 7919 + i * 104729 + c.charCodeAt(0)) % GLYPHS.length]
  }
  return out
}

/**
 * Yonna's lines, arriving the way a computer would produce them.
 *
 * The hard part is not the effect, it is that the text underneath is *live*.
 * The store appends a token at a time, so this component re-renders dozens of
 * times a second with a slightly longer string, and the naive implementation —
 * scramble the whole thing, resolve it over N milliseconds — restarts the
 * animation on every token and never finishes decoding anything.
 *
 * So the frontier is a ref and only ever moves forward. Everything behind it
 * has settled and is plain text that will never animate again; a short window
 * ahead of it is noise; the rest is present in the DOM but invisible, which
 * keeps the line wrapping identical to the finished paragraph and means the
 * accessibility tree always holds the real sentence. The rate scales with how
 * far behind the frontier has fallen, so a single token drips and a 300
 * character burst clears inside MAX_LAG_MS — the decode must never be the
 * reason the transcript trails the voice.
 *
 * The rAF loop repaints on a 42ms gate rather than every frame, and stops dead
 * the moment the frontier catches up.
 */
function DecodeText({ text }: { text: string }) {
  const reduced = useReducedMotion()
  const settled = useRef(0)
  const raf = useRef(0)
  const latest = useRef(text)
  const [tick, bump] = useState(0)

  useEffect(() => {
    // The running loop reads the length through this ref rather than through
    // its own closure, so a token landing mid-sweep simply extends the target
    // instead of leaving the loop chasing a length that is already stale.
    latest.current = text

    if (reduced) {
      settled.current = text.length
      return
    }
    if (raf.current || settled.current >= text.length) return

    let prev = performance.now()
    let painted = 0

    const step = (now: number) => {
      // Clamped so a backgrounded tab does not resolve the whole answer in one
      // enormous frame the moment it comes back.
      const dt = Math.min(now - prev, 120) / 1000
      prev = now

      const target = latest.current.length
      const rate = Math.max(MIN_RATE, (target - settled.current) / (MAX_LAG_MS / 1000))
      settled.current = Math.min(target, settled.current + rate * dt)

      if (now - painted >= FRAME_MS) {
        painted = now
        bump((n) => n + 1)
      }

      if (settled.current < latest.current.length) {
        raf.current = requestAnimationFrame(step)
      } else {
        raf.current = 0
        bump((n) => n + 1)
      }
    }
    raf.current = requestAnimationFrame(step)
  }, [text, reduced])

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const n = Math.floor(settled.current)
  if (reduced || n >= text.length) return <>{text}</>

  return (
    <>
      {text.slice(0, n)}
      <span className="decode-ghost">{scramble(text.slice(n, n + GHOST), tick)}</span>
      <span className="decode-veil">{text.slice(n + GHOST)}</span>
    </>
  )
}

/* --------------------------------------------------------------------- hud */

export function Hud() {
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const error = useStore((s) => s.error)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const muted = useStore((s) => s.muted)
  const ui = useStore((s) => s.ui)

  // accentFor folds Yonna's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every .hud-* rule without
  // a single component knowing a theme exists.
  const colour = accentFor(phase, ui)

  useEffect(() => {
    // The ground has to be set on the document, not painted here: the HUD sits
    // above the 3D scene, so a background drawn inside it would cover the
    // reactor rather than sit behind it. --bg is what html, body, #root and the
    // boot screen all pin themselves to.
    const root = document.documentElement
    if (ui.background) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  return (
    <div className={`hud phase-${phase}${muted ? ' is-muted' : ''}`} style={{ ['--accent' as string]: colour }}>
      {/* First in the tree on purpose. Everything after it is positioned with
          `z-index: auto`, so paint order is document order and the sweep stays
          behind the transcript and the panels without a z-index war. */}
      <BladeSweep />

      <header className="hud-top">
        {ui.chrome.brand && <span className="brand-mark">YONNA</span>}
        <BrainSwitch muted={muted} />
      </header>

      <StateLabel phase={phase} muted={muted} tool={activeTool} />

      {/* Conversation log — just the last question and its answer */}
      {ui.chrome.transcript && (
        <div className="log">
          <AnimatePresence initial={false}>
            {lastExchange(turns).map((t) => (
              <motion.div
                key={t.id}
                className={`log-line log-${t.role}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              >
                <span className="log-who">{t.role === 'user' ? 'You' : 'Yonna'}</span>
                {/* Only her half decodes. What the user said was never
                    transmitted from anywhere — dressing it up as machine
                    output would be a lie about where the words came from. */}
                <span className="log-text">
                  {t.role === 'yonna' ? <DecodeText text={t.text} /> : t.text}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {caption && (
          <motion.div
            className="caption"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {caption}
          </motion.div>
        )}
      </AnimatePresence>

      {/* The one surface. Panels used to sit alongside this as a second place
          for things to appear, which meant two places to look and a decision
          the model had to make on grounds it could not know. Everything renders
          here now; Panels.tsx is unmounted rather than deleted so the design
          system it documents stays findable. */}
      <Blades />

      {/* Today's calendar, bottom-left, behind "Today ›". */}
      <AgendaBox />
      <Shortcuts />
      <Welcome />


      {error && <div className="error">{error}</div>}


      {/* Last, so a flash or a tear reads as being on the glass rather than
          underneath the chrome. It is pointer-events: none and unmounts the
          instant it finishes. */}
      <Effects />

      {/* Above even the effects: the reticle shows where a press will land, and
          a press that lands under a flourish is a press you cannot aim. */}
      <Pointer />
      {(gestures || looking) && (
        // Just a camera symbol under the brain's name, as the menu bar shows one.
        <div
          className="hands-live"
          role="status"
          aria-label={looking ? `Camera on — looking: ${looking}` : 'Camera on — press G to stop'}
          title={looking ? `Looking — ${looking}` : 'Camera on — press G to stop'}
        >
          <svg viewBox="0 0 24 16" aria-hidden="true">
            <rect x="0.5" y="1.5" width="15" height="13" rx="3.2" />
            <path d="M17 6.2 22.6 2.9c.6-.4 1.4.1 1.4.8v8.6c0 .7-.8 1.2-1.4.8L17 9.8Z" />
          </svg>
        </div>
      )}
      <GestureGuide live={gestures} />
    </div>
  )
}

/** Top right: a dot for the microphone and the brain's name. Click the name
 *  to switch between Sonnet (quick, the default) and Opus (smartest); M mutes. */
const NEXT: Record<Brain, Brain> = { sonnet: 'opus', opus: 'sonnet' }
const BRAIN_NAME: Record<Brain, string> = { sonnet: 'Sonnet', opus: 'Opus' }
const BRAIN_TIP: Record<Brain, string> = {
  sonnet: 'Sonnet — quick. Click for Opus (smartest).',
  opus: 'Opus — smartest. Click for Sonnet (quick).',
}

function BrainSwitch({ muted }: { muted: boolean }) {
  const [brain, setBrain] = useState<Brain>(getBrain)

  return (
    <div className="status">
      <button
        type="button"
        className={`mic-dot${muted ? ' is-muted' : ''}`}
        aria-pressed={muted}
        title={muted ? 'Microphone off — click or press M to turn it on' : 'Mute the microphone (M)'}
        onClick={() => useStore.getState().setMuted(!muted)}
      />
      <button
        type="button"
        className="brain-btn"
        title={BRAIN_TIP[brain]}
        onClick={() => {
          const next = NEXT[brain]
          bridgeSetBrain(next)
          setBrain(next)
        }}
      >
        {BRAIN_NAME[brain]}
      </button>
    </div>
  )
}

/** Under the orb: what she is doing, and a fainter line under it. */
function StateLabel({ phase, muted, tool }: { phase: string; muted: boolean; tool: string | null }) {
  const [label, hint] =
    phase === 'offline' || phase === 'boot'
      ? ['Offline', 'Waiting for the brain to start']
      : muted
        ? ['', '']
        : phase === 'listening' || phase === 'waking'
          ? ['Listening…', '']
          : phase === 'thinking'
            ? ['Thinking', '']
            : phase === 'tooling'
              ? ['Working', tool ? tool.replace(/^yonna_/, '').replace(/[_-]/g, ' ') : '']
              : phase === 'speaking'
                ? ['Speaking', '']
                : ['', '']
  return (
    <div className="state" aria-live="polite">
      <div className="state-label">{label}</div>
      <div className="state-hint">{hint}</div>
    </div>
  )
}

/** The latest question and the answer to it — nothing older. */
function lastExchange<T extends { role: string }>(turns: T[]): T[] {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'user') return turns.slice(i, i + 2)
  return turns.slice(-1)
}
