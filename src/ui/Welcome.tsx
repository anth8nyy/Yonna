import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * First launch: what Yonna needs, each with its state and one button that
 * asks for it — so nobody has to dig through System Settings by hand.
 * Shown once (and again with W). Updates itself every two seconds while open,
 * so a switch turned on in System Settings ticks green here on its own.
 *
 * "This window" rows come from the native Yonna window (window-app), which is
 * what holds those permissions; in a browser they are left out.
 */

const SEEN_KEY = 'yonna.welcomed'

type State = 'allowed' | 'ask' | 'denied' | 'off'
type Native = { microphone: State; speech: State; camera: State }
type Setup = {
  keys: { microphone: State; speech: State; screen: State } | null
  calendar: State
  messages: State
  spotify: State
}

type Handler = { postMessage: (m: unknown) => Promise<unknown> }
const native = (): Handler | null =>
  ((window as unknown as { webkit?: { messageHandlers?: { native?: Handler } } }).webkit?.messageHandlers?.native) ?? null

const SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?'

function loadSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

export function Welcome() {
  const [open, setOpen] = useState(() => !loadSeen())
  const [win, setWin] = useState<Native | null>(null)
  const [setup, setSetup] = useState<Setup | null>(null)

  const refresh = useCallback(() => {
    void native()
      ?.postMessage({ op: 'status' })
      .then((s) => setWin(s as Native))
      .catch(() => {})
    void fetch(`${BRIDGE_HTTP_URL}/setup`)
      .then((r) => r.json())
      .then(setSetup)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) return
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [open, refresh])

  // W opens it again; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'KeyW' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) setOpen((o) => !o)
      else if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const done = () => {
    try {
      localStorage.setItem(SEEN_KEY, '1')
    } catch {
      /* fine */
    }
    setOpen(false)
  }

  const ask = (what: keyof Native) => {
    const n = native()
    if (!n) return
    if (win?.[what] === 'denied') {
      const pane = { microphone: 'Privacy_Microphone', speech: 'Privacy_SpeechRecognition', camera: 'Privacy_Camera' }[what]
      void n.postMessage({ op: 'open', url: SETTINGS + pane })
    } else {
      void n.postMessage({ op: 'request', what }).then((s) => setWin(s as Native))
    }
  }
  const act = (what: string) => {
    void fetch(`${BRIDGE_HTTP_URL}/setup/do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ what }),
    }).then(refresh)
  }

  const k = setup?.keys
  const keysVoice: State = !k ? 'ask' : k.microphone === 'allowed' && k.speech === 'allowed' ? 'allowed' : k.microphone === 'denied' || k.speech === 'denied' ? 'denied' : 'ask'

  const rows: { title: string; why: string; state: State | undefined; button: string; onClick: () => void; optional?: boolean }[] = []
  if (native()) {
    rows.push(
      { title: 'Microphone', why: 'So she can hear you in this window.', state: win?.microphone, button: 'Allow', onClick: () => ask('microphone') },
      { title: 'Speech Recognition', why: 'Turns what you say into text, on this Mac.', state: win?.speech, button: 'Allow', onClick: () => ask('speech') },
    )
  }
  rows.push(
    {
      title: 'Talk from any app',
      why: 'Hold fn anywhere to ask her something.',
      state: keysVoice,
      button: keysVoice === 'denied' ? 'Open Settings' : 'Allow',
      onClick: () => act(keysVoice === 'denied' ? 'keys-settings' : 'keys'),
    },
    {
      title: 'See your screen',
      why: 'With the shortcut, she sees what you are looking at.',
      state: k?.screen,
      button: 'Allow',
      onClick: () => act('screen'),
    },
    { title: 'Calendar', why: 'Your day in "Today", and events when you ask.', state: setup?.calendar, button: 'Allow', onClick: () => act('calendar') },
  )
  if (native()) {
    rows.push({ title: 'Camera', why: 'Hand gestures, and when you ask her to look.', state: win?.camera, button: 'Allow', onClick: () => ask('camera'), optional: true })
  }
  if (setup && setup.messages !== 'off') {
    rows.push({ title: 'Messages', why: 'Ask her by iMessage from your phone.', state: setup.messages, button: 'Allow', onClick: () => act('messages'), optional: true })
  }
  rows.push({ title: 'Spotify', why: 'Play your own playlists and liked songs.', state: setup?.spotify, button: 'Connect', onClick: () => act('spotify'), optional: true })

  const ready = rows.filter((r) => !r.optional).every((r) => r.state === 'allowed')

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="welcome-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
        >
          <motion.div
            className="welcome"
            role="dialog"
            aria-label="Welcome to Yonna"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
          >
            <div className="welcome-title">Welcome to Yonna</div>
            <p className="welcome-sub">A few things she needs from your Mac. Each one asks once.</p>
            <ul className="welcome-list">
              {rows.map((r) => (
                <li key={r.title}>
                  <span className={`welcome-dot is-${r.state ?? 'ask'}`} />
                  <span className="welcome-text">
                    <b>
                      {r.title}
                      {r.optional && <em> optional</em>}
                    </b>
                    <span>{r.why}</span>
                  </span>
                  {r.state === 'allowed' ? (
                    <span className="welcome-ok">On</span>
                  ) : (
                    <button type="button" onClick={r.onClick}>
                      {r.state === 'denied' && r.button === 'Allow' ? 'Open Settings' : r.button}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="welcome-foot">
              <span>{ready ? 'All set.' : 'You can come back here any time with W.'}</span>
              <button type="button" className="welcome-go" onClick={done}>
                {ready ? 'Start' : 'Later'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
