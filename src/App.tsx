import { useEffect, useRef } from 'react'
import { Orb } from './ui/Orb'
import { Hud } from './ui/Hud'
import { TypeBox } from './ui/TypeBox'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { onWakeMiss, startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, speakingNow } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { attention } from './lib/fillers'
import { goodbye, overlay, reportHeard, tryInstant, watchPtt } from './lib/bridge'
import { isGreek } from './lib/lang'
import { fixName, isBareName, stripLeadingName } from './lib/wake'
import { trimCarryOver } from './lib/carryover'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel, releaseMic } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000
/** After his name alone, how long to wait for more before answering "Sir?". */
const GREET_DELAY_MS = 1100

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** Her name as it may trail a farewell ("goodbye Yonna"). Waking and the
 *  name before a request are matched by sound instead — see lib/wake.ts. */
const NAME =
  '(?:yonna|yona|yonah|yonnah|yanna|jonna|jona|jonah|joanna|johanna|iona|γιόνα|γιονα|γιόννα|γιοννα|γιώνα|τζόνα|τζονα)'

/**
 * Signing off: "goodbye", "goodnight", "it's time to go" — on their own, with
 * or without his name. Anchored at both ends, so a question that merely
 * contains one ("play goodbye yellow brick road") is still a question.
 */
const FAREWELL = new RegExp(
  `^(?:(?:ok|okay|alright|right|well)[,\\s]+)?` +
    `(?:good\\s*-?\\s*bye|bye(?:\\s*bye)?|good\\s*-?\\s*night|night\\s*night|` +
    `it'?s\\s+time\\s+to\\s+go|time\\s+to\\s+go|see\\s+you(?:\\s+later|\\s+tomorrow)?|` +
    `that'?s\\s+all(?:\\s+for\\s+(?:now|today|tonight))?|shut\\s*down|power\\s+(?:off|down)|go\\s+to\\s+sleep|` +
    // Greek: αντίο, καληνύχτα, γεια σου, τα λέμε, ώρα να φύγω, κλείσε
    `αντ[ίι]ο|καλην[ύυ]χτα|γεια\\s+σου|γεια|τα\\s+λ[έε]με|[ώω]ρα\\s+να\\s+φ[ύυ]γω|κλε[ίι]σε)` +
    `(?:[,\\s]+(?:${NAME}|sir|κ[ύυ]ριε|for\\s+now|for\\s+today|for\\s+tonight|για\\s+σ[ήη]μερα|για\\s+απ[όο]ψε))*[\\s,.!?;]*$`,
  'iu',
)
const FAREWELL_LINES = ['Night!', 'See you later.', 'Bye for now.']
const FAREWELL_LINES_EL = ['Καληνύχτα, κύριε.', 'Μάλιστα, κύριε. Τα λέμε.', 'Αντίο, κύριε.']

// Short phrases that were not taken as his name go to the bridge log, so a
// spelling of "Yonna" the recogniser produces but the matcher misses can be found.
onWakeMiss(reportHeard)

export default function App() {
  const store = useStore
  const history = useRef<Msg[]>([])
  /** Option+Space is held down. */
  const pushing = useRef(false)
  /**
   * Tabs and panels that arrive before she has started speaking wait here, so
   * the screen never runs ahead of her voice. null = show them straight away.
   */
  const visualsHeld = useRef<Array<() => void> | null>(null)
  const releaseVisuals = () => {
    const waiting = visualsHeld.current
    visualsHeld.current = null
    waiting?.forEach((show) => show())
  }
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  /** The last question asked, so a repeat of it glued to the next can be cut. */
  const lastQuestion = useRef('')
  /** A pending "Κύριε;" after his name alone — see onWake. */
  const greetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- push-to-talk -----------------------------------------------------------

  /** Option+Space down — from this window's keyboard or from the global
   *  shortcut helper by way of the bridge. */
  const pttStart = () => {
    if (store.getState().muted) return
    // Still "pushing" from a press whose release never came (the bridge
    // restarted mid-press, say): end it, or every later press is ignored.
    if (pushing.current) {
      pushing.current = false
      voice.current?.push(false)
    }
    const ph = store.getState().phase
    if (ph === 'offline' || ph === 'boot') return
    pushing.current = true
    // Talking over her: stop the answer in flight first.
    if (ph === 'thinking' || ph === 'tooling' || ph === 'speaking') onSpeechStart()
    clearIdle()
    store.getState().setPhase('listening')
    store.getState().setCaption('…')
    overlay('listening')
    voice.current?.push(true)
  }
  const pttEnd = () => {
    if (!pushing.current) return
    pushing.current = false
    voice.current?.push(false)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    // Signing off is handled here, not by the model: it should be instant, and
    // it must work even when the brain is busy or slow.
    if (FAREWELL.test(stripLeadingName(said))) {
      turn.current++
      clearIdle()
      silence()
      interrupt()
      const s = store.getState()
      s.pushTurn({ id: newId(), role: 'user', text: said })
      s.setPhase('speaking')
      const bye = createSpeaker()
      speaker.current = bye
      const lines = isGreek() ? FAREWELL_LINES_EL : FAREWELL_LINES
      bye.say(lines[Math.floor(Math.random() * lines.length)])
      // Never hang on a voice that fails to finish: leave after a few seconds
      // whatever happens.
      await Promise.race([bye.end(), new Promise((r) => setTimeout(r, 4000))])
      goodbye()
      return
    }

    lastQuestion.current = said
    const mine = ++turn.current
    const stale = () => mine !== turn.current
    overlay('question', said)

    // Simple, common requests are done at once with no AI (bridge/instant.mjs):
    // "open Spotify", "what time is it", "set a timer for five minutes".
    {
      const quick = await tryInstant(said)
      if (stale()) return
      if (quick.handled) {
        clearIdle()
        const s = store.getState()
        s.setCaption('')
        s.pushTurn({ id: newId(), role: 'user', text: said })
        if (quick.blade) s.pushBlade(quick.blade)
        overlay('done', quick.say || 'Done.')
        if (quick.say) {
          s.pushTurn({ id: newId(), role: 'yonna', text: quick.say })
          s.setPhase('speaking')
          const spk = createSpeaker()
          speaker.current = spk
          spk.say(quick.say)
          await Promise.race([spk.end(), new Promise((r) => setTimeout(r, 6000))])
          if (stale()) return
          speaker.current = null
        }
        voice.current?.flush()
        listen(FOLLOW_UP_MS)
        return
      }
    }

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false

    // Her words and any tab she opens appear when her voice starts, not
    // before — reading the answer and then hearing it a beat later felt
    // backwards. A slow voice never holds the screen more than a moment.
    visualsHeld.current = []
    let showing = false
    let unshown = ''
    const reveal = () => {
      if (stale() || showing) return
      showing = true
      if (unshown) store.getState().appendToLastTurn(unshown)
      unshown = ''
      releaseVisuals()
    }
    void spk.started().then(reveal)

    // Said once. The model sometimes writes its answer twice in one turn —
    // typically before and again after showing a panel ("Fifty-one, sir.
    // Fifty-one, sir."). So after every finished sentence, new text is held
    // while it is an exact repeat of something already said; if that is all it
    // turns out to be, it is dropped. The moment it says something new, it
    // flows on — a fraction of a second's hold at most.
    let said_ = ''
    let held = ''
    let checking = false
    const squash = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const emit = (delta: string) => {
      // Text from before and after a panel joins with no space — "sir.Saturday"
      // — which reads badly and is spoken without a breath. Put the space back.
      if (/[.!?…;]["'»”’)\]]?$/.test(said_) && /^[\p{L}\p{N}"'«“(]/u.test(delta)) delta = ' ' + delta
      if (showing) store.getState().appendToLastTurn(delta)
      else unshown += delta
      overlay('answer', said_ + delta)
      spk.push(delta)
      said_ += delta
      // A sentence just ended: whatever comes next may be a repeat.
      if (/[.!?…;]["'»”’)\]]?\s*$/.test(said_)) {
        checking = true
        held = ''
      }
    }

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'yonna', text: '' })
            setTimeout(reveal, 2500)
          }
          // Text arrives in small pieces and a sentence can end mid-piece
          // ("…sir.Fif"), so take each piece apart at sentence ends first.
          for (const part of delta.split(/(?<=[.!?…;])/u)) {
            if (!part) continue
            if (checking) {
              held += part
              const h = squash(held)
              if (!h || squash(said_).includes(h)) continue // still a repeat so far
              checking = false
              const out = held
              held = ''
              emit(out)
              continue
            }
            emit(part)
          }
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          // A tool after he has started talking: watch for a repeat. See emit.
          if (started) {
            checking = true
            held = ''
          }
          store.getState().setActiveTool(name)
          // The sound and the screen say that work has started. Nothing is
          // spoken: "Working on it", "Searching" before every answer was
          // chatter the user asked to be rid of — they want the answer only.
          sfx.play('tool')
          music.working(true)
        },
      })

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      overlay('done', said_)
      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        reveal()
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // A clean slate before listening again: whatever the recogniser still
        // holds from his answer must not start the next question.
        voice.current?.flush()
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    if (store.getState().muted) return 'deaf'
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Yonna, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    const asked = trailing ? trimCarryOver(trailing, speakingNow(), lastQuestion.current) : ''
    if (asked) {
      void respond(asked)
      return
    }

    store.getState().setPhase('waking')
    listen(AWAIT_SPEECH_MS)

    // Answer to his name — but only if they stop there. "Τζάρβις, τι ώρα
    // είναι" is usually one breath, and the recogniser hears the name a beat
    // before the rest: greeting at once meant "Κύριε;" spoken straight over the
    // question. So wait a moment; if more words arrive, stay quiet and listen.
    if (greetTimer.current) clearTimeout(greetTimer.current)
    greetTimer.current = setTimeout(() => {
      greetTimer.current = null
      if (store.getState().phase !== 'listening' || store.getState().caption) return
      const greeting = createSpeaker()
      speaker.current = greeting
      greeting.say(attention())
      void greeting.end()
    }, GREET_DELAY_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (raw: string) => {
    const text = fixName(raw)
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "yonna" to the model as a question.
    if (isBareName(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    // Cut any lead-in carried over from his last answer or the last question.
    const said = trimCarryOver(stripLeadingName(text), speakingNow(), lastQuestion.current)
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    // They kept talking after his name: no greeting needed.
    if (text && greetTimer.current) {
      clearTimeout(greetTimer.current)
      greetTimer.current = null
    }
    // "Rianna", "Fionna", "Johna"… are her name misheard: show it as Yonna.
    text = fixName(text)
    store.getState().setCaption(text)
    if (pushing.current) overlay('listening', text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[yonna] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  /** Open the microphone: the reactor's analyser, then the voice loop. */
  const openEars = async () => {
    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[yonna] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })
  }

  /** Close the microphone completely — mute. The system's mic light goes out. */
  const closeEars = () => {
    voice.current?.stop()
    voice.current = null
    releaseMic()
  }

  const ignite = async () => {
    const s = store.getState()
    // Starting, quietly. There is no intro any more: no ignition button, no
    // boot sequence, no music — the app opens straight into Yonna.
    // The desktop app's Chrome runs with --autoplay-policy=no-user-gesture-
    // required, so audio does not need a click first (unlockAudio swallows
    // the refusal anywhere it still applies).
    s.setPhase('boot')

    await sfx.unlockAudio()
    // No music: the score is never enabled, so the ambient track and the
    // working cues stay silent (music.* calls do nothing until enable()).

    watchServers((servers) => store.getState().setConnected(servers))
    // The global Option+Space helper, by way of the bridge.
    watchPtt((down) => (down ? pttStart() : pttEnd()))

    // Held while she has not started speaking yet — see visualsHeld.
    const show = (apply: () => void) =>
      visualsHeld.current ? visualsHeld.current.push(apply) : apply()
    watchPanels((panel) => show(() => store.getState().pushPanel(panel)))
    watchBlades((blade) =>
      blade.cancel
        ? store.getState().closeBlade(blade.id)
        : show(() => store.getState().pushBlade(blade)),
    )

    /**
     * Yonna asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds(req.camera) < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // The camera is only ever on with its blade on screen: looking with the
      // blade closed opens it again, so the user always sees what he sees —
      // and closing the blade is what turns the camera off.
      const cam = req.camera
      const isOpen = () =>
        store.getState().blades.some((b) => b.kind === 'camera' && (b.camera === 'desk' ? 'desk' : 'face') === cam)
      if (!isOpen()) {
        store.getState().pushBlade({
          id: `cam-${cam}-${Date.now().toString(36)}`,
          title: cam === 'desk' ? 'DESK' : 'CAMERA',
          kind: 'camera',
          camera: cam,
          size: 'wide',
          hold: 'sticky',
        })
        // Let it open and the picture settle before the photograph.
        for (let i = 0; i < 30 && !camera.cameraLive(cam); i++) {
          await new Promise((r) => setTimeout(r, 100))
        }
        await new Promise((r) => setTimeout(r, 400))
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera(req.camera)
        held = true
        if (req.mode === 'look') return await camera.grabFrame(req.camera)
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9, req.camera)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9, req.camera)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera(req.camera)
        store.getState().setLooking(null)
      }
    })

    // The interface is Yonna's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[yonna] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Yonna" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, Yonna comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // One voice loop, started once, running until the page closes.
    // One voice loop, running until the page closes — or until mute closes
    // the microphone, when openEars starts it again on unmute.
    if (!store.getState().muted) await openEars()

    store.getState().setPhase('dormant')
  }

  // -- start at once ---------------------------------------------------------

  // No intro: power on as soon as the page is up. If it fails (the bridge not
  // there yet, say), the next click or key press tries again.
  useEffect(() => {
    void powerOn()
    const retry = () => {
      if (store.getState().phase === 'offline') void powerOn()
    }
    window.addEventListener('pointerdown', retry)
    window.addEventListener('keydown', retry)
    return () => {
      window.removeEventListener('pointerdown', retry)
      window.removeEventListener('keydown', retry)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- mute closes the microphone ----------------------------------------------

  // Mute used to leave the microphone open and simply ignore it — the mic light
  // stayed on and the recogniser kept running. Now it is really off: the voice
  // loop stops and the stream is released; unmute opens it again. Before boot
  // there is nothing to open — ignite checks the flag itself.
  useEffect(
    () =>
      store.subscribe((st, prev) => {
        if (st.muted === prev.muted) return
        if (st.phase === 'offline' || st.phase === 'boot') return
        if (st.muted) closeEars()
        else if (!voice.current) void openEars()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    let lastLevelAt = 0
    const pump = () => {
      raf = requestAnimationFrame(pump)
      // About 30 times a second is plenty for a pulse — the scene smooths it
      // anyway — and every update re-renders whatever reads the level.
      const now = performance.now()
      if (now - lastLevelAt < 33) return
      lastLevelAt = now
      const st = store.getState()
      // While speaking, follow Yonna's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      // Skip changes too small to see.
      if (Math.abs(lvl - st.level) > 0.004) st.setLevel(lvl)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Never while the typing line is open, even if focus wandered off it —
      // a word with "μ" or "γ" in it must not mute or start the camera.
      if (store.getState().typing) return
      // Keys are matched by physical position (e.code), not by the letter they
      // produce, so they work with the Greek keyboard layout too: the M key
      // gives "μ" there, but its code is still KeyM.

      // Option+Space, held: push-to-talk. Talk while it is down; letting go
      // sends the question at once — no wake word, and no waiting for a
      // pause to decide you have finished, which is the fastest way in.
      // Option+Control+Space (the same keys as the global shortcut).
      if (e.code === 'Space' && e.altKey && e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        if (!e.repeat) pttStart()
        return
      }

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.code === 'KeyV' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      // M mutes the microphone, same as the button by the status light.
      if (e.code === 'KeyM' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        store.getState().setMuted(!store.getState().muted)
        return
      }

      if (e.code === 'KeyG' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T opens the typing line — for anything easier written than said, and
      // for Greek. (T used to run a one-line audio test; D's diagnostics
      // panel covers that.)
      if (e.code === 'KeyT' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ph = store.getState().phase
        if (ph === 'offline' || ph === 'boot') return
        e.preventDefault()
        store.getState().setTyping(true)
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    // Push-to-talk ends when either key comes up, or the window loses focus
    // with it held (otherwise the next Option+Space would find it stuck).
    const release = () => pttEnd()
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === 'Alt' || e.key === 'Control') release()
    }
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', release)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', release)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Orb />
      <Hud />
      <TypeBox
        onSubmit={(text) => {
          // A typed question is a turn like a spoken one: stop whatever he is
          // doing first, exactly as talking over him would, then answer it.
          onSpeechStart()
          void respond(text)
        }}
      />
      <Diagnostics />
    </>
  )
}
