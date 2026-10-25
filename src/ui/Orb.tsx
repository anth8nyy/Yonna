import { useEffect, useRef } from 'react'
import { MODE_FRAMES, paintFrame, resolvePreset } from 'thinking-orbs/engine'
import { useStore } from '../store'

/**
 * Yonna's orb, drawn exactly as Atticus draws its own (ui/ui.html in
 * github.com/SaarthurR/atticus-mac): the thinking-orbs engine (MIT, Jakub
 * Antalik) in its own colours, with three looks —
 *
 *   breathing  waiting, and while she answers
 *   listening  while you talk: it runs faster and grows a little with your voice
 *   solving    while she works something out
 *
 * The presets are designed at 64 px; the canvas is that drawing scaled up.
 */

const DESIGN = 64
/** Slower than Atticus's own pace: 1 would be the same speed. */
const PACE = 0.5
/** Thinner dots than Atticus's: 1 would be the same size. */
const DOT = 0.6

function look(phase: string): string {
  if (phase === 'listening' || phase === 'waking') return 'listening'
  if (phase === 'thinking' || phase === 'tooling') return 'solving'
  return 'breathing'
}

export function Orb() {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let state = 'breathing'
    let preset = resolvePreset(state, DESIGN)
    let t = 0
    let level = 0
    let prev = performance.now()
    let raf = 0

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - prev) / 1000)
      prev = now
      const { phase, level: heard, ui, muted } = useStore.getState()

      const want = look(phase)
      if (want !== state) {
        state = want
        preset = resolvePreset(state, DESIGN)
      }

      const css = Math.round(Math.min(window.innerHeight * 0.52, window.innerWidth * 0.58, 460))
      const dpr = window.devicePixelRatio || 1
      const px = Math.round(css * dpr)
      if (c.width !== px) {
        c.width = c.height = px
        c.style.width = c.style.height = `${css}px`
      }

      // As Atticus: your voice (and hers) speeds it up and grows it by up to 10%.
      const voiced = !muted && (state === 'listening' || phase === 'speaking') ? heard : 0
      level += (voiced - level) * Math.min(1, dt * 12)
      const boost = 0.5 + level * 2.5
      const scale = (1 + level * 0.1) * (ui.reactor?.scale ?? 1)
      c.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`
      c.style.opacity = ui.reactor?.visible === false ? '0' : phase === 'offline' ? '0.35' : '1'
      document.documentElement.style.setProperty(
        '--orb-bottom',
        `${Math.round(window.innerHeight / 2 - 24 + css * 0.42 * scale)}px`,
      )

      t += dt * preset.speed * PACE * (level > 0.01 ? boost : 1) * (reduced.matches ? 0 : 1)
      ctx.setTransform(px / DESIGN, 0, 0, px / DESIGN, 0, 0)
      ctx.clearRect(0, 0, DESIGN, DESIGN)
      const f = MODE_FRAMES[preset.mode](DESIGN, t, preset.opts)
      for (const d of f.dots) d.r *= DOT
      for (const l of f.lines) l.w *= DOT
      paintFrame(ctx, f, true, null)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvas} className="orb" aria-hidden="true" />
}
