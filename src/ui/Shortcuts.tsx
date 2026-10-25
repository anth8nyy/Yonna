import { useEffect, useState } from 'react'

/**
 * Bottom right: every shortcut and what it does.
 * Click it, or press I, to open; click outside, press I or Esc to close.
 */

const KEYS: { keys: string[]; does: string }[] = [
  { keys: ['fn'], does: 'Hold to talk from any app, let go to send — she sees your screen too' },
  { keys: ['Space'], does: 'Talk without saying her name' },
  { keys: ['T'], does: 'Type a question instead of speaking' },
  { keys: ['M'], does: 'Mute or unmute the microphone' },
  { keys: ['G'], does: 'Hand gestures — turns the camera on to follow your hands' },
  { keys: ['V'], does: 'Try the next voice' },
  { keys: ['D'], does: 'Diagnostics (what the mic and voice are doing)' },
  { keys: ['W'], does: 'Welcome — what Yonna needs from your Mac, with Allow buttons' },
]

export function Shortcuts() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Physical key, so it works on the Greek layout too.
      if (e.code === 'KeyI' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.keys-panel, .keys-btn')) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  return (
    <>
      <button
        type="button"
        className={`keys-btn${open ? ' is-open' : ''}`}
        aria-expanded={open}
        title="Shortcuts (I)"
        onClick={() => setOpen((o) => !o)}
      >
        <kbd>I</kbd>
      </button>
      {open && (
        <div className="keys-panel" role="dialog" aria-label="Shortcuts">
          <div className="keys-title">Shortcuts</div>
          {KEYS.map((k) => (
            <div className="keys-row" key={k.does}>
              <span className="keys-keys">
                {k.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
              <span className="keys-does">{k.does}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
