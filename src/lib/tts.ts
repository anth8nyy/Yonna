import { isGreek, onLang } from './lang'
import {
  env,
  USE_ELEVENLABS,
  BACKEND,
  TTS_ENGINE,
  KOKORO_VOICE,
  BRIDGE_HTTP_URL,
} from '../config'
import * as kokoro from './kokoro'
import { caps } from './capabilities'

/**
 * Speech output.
 *
 * The browser's own speechSynthesis is the default because it is by far the
 * fastest thing available: it runs on-device, so there is no request, no
 * generation wait and no download — speech starts on the next frame. A cloud
 * voice sounds better but costs a few hundred milliseconds per sentence, and in
 * conversation that gap is much more noticeable than the timbre.
 *
 * Either way, text is cut at sentence boundaries as it streams in and spoken a
 * sentence at a time, so Yonna starts talking while Claude is still writing.
 *
 * The queue is an explicit array with a single pump rather than a promise
 * chain. A chain cannot be cut: cancelling mid-sentence left the chain's tail
 * unresolved forever, which wedged the whole assistant. An array can simply be
 * emptied.
 */

type Speaker = {
  /** Feed streamed text in. Complete sentences are spoken as they appear. */
  push: (delta: string) => void
  /** Speak a phrase ahead of anything still queued. Used for filler like
   *  "Working on it, sir" while a tool runs. */
  say: (text: string) => void
  /** No more text coming — flush the remainder and resolve when audio ends. */
  end: () => Promise<void>
  /** Cut it off mid-sentence (barge-in). Always settles `end()`. */
  cancel: () => void
  /** 0..1 output loudness for the visualiser. */
  level: () => number
  /** Resolves the moment sound first comes out — or when the speaker ends or
   *  is cancelled without ever speaking — so the screen can wait for her
   *  voice instead of running ahead of it. */
  started: () => Promise<void>
}

// ---------------------------------------------------------------------------
// What he is saying right now
// ---------------------------------------------------------------------------

let speaking = ''
/** Sentences that finished recently, each with when it stops counting. */
let recent: { text: string; until: number }[] = []

/** Recognition lags the speakers by a few hundred milliseconds, and the browser
 *  recogniser batches whole phrases before it reports them — so a sentence can
 *  arrive at the microphone several seconds after it finished playing. Too
 *  short a tail and the echo of an earlier sentence in the same answer reads
 *  as the user talking, which interrupts him and sends his own words back as a
 *  new question: the answer restarts from the top, again and again. */
const ECHO_TAIL_MS = 6000

/**
 * Why you cannot hear him.
 *
 * Published on `window.__tts`. Speech has exactly four ways to fail silently —
 * the engine never started, the OS voice errored, every line was cancelled by
 * a barge-in, or nothing was ever queued — and from outside the page they are
 * indistinguishable. This tells them apart at a glance.
 */
export const diag = {
  engine: 'system' as 'system' | 'kokoro' | 'elevenlabs' | 'siri',
  /** Utterances handed to an engine — the OS voice or an audio element. */
  spoken: 0,
  /**
   * Of those, how many actually began producing sound.
   *
   * Counted for EVERY engine, which it did not used to be: this was incremented
   * only in speakNative's onstart, so on the ElevenLabs path — the good path,
   * the one a configured machine actually uses — it stayed at zero forever.
   * The diagnostics panel reads this to decide whether he is audible at all, so
   * a working cloud voice reported "no sound produced", and the T self-test
   * raised that as an error on screen. The verdict has to be about sound, not
   * about which code path produced it.
   */
  started: 0,
  /** Genuine engine failures, excluding deliberate cancels. */
  failures: 0,
  /** Last SpeechSynthesis error code, e.g. 'synthesis-failed'. */
  lastError: '',
  /** Set once the OS voice has proved unusable; the cloud voice takes over. */
  nativeBroken: false,
  /** Sentences rescued by the bridge's ElevenLabs proxy. */
  rescued: 0,
  voice: '',
  lastText: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__tts = diag
}

/**
 * Once the OS voice has failed, stop asking it.
 *
 * A broken system voice is not a transient condition — it fails identically on
 * every sentence — so retrying it per line would make the whole answer stutter
 * through the same dead path. After the first real failure everything routes to
 * the bridge's speech proxy instead, which holds an ElevenLabs key already.
 */
let nativeBroken = false
/** The Mac's own voice through the bridge (`say`, the Siri voice Atticus uses)
 *  failed: the browser voice from then on. */
let sayBroken = false

type NativeHandler = { postMessage: (m: unknown) => Promise<unknown> }
/** The native Yonna window (window-app) speaks with `say` itself, with no
 *  request in between to go wrong; in a browser, the bridge does it. */
const nativeVoice = (): NativeHandler | null =>
  (window as unknown as { webkit?: { messageHandlers?: { native?: NativeHandler } } }).webkit?.messageHandlers?.native ?? null
const stopSay = () => {
  const n = nativeVoice()
  if (n) void n.postMessage({ op: 'shush' }).catch(() => {})
  else void fetch(`${BRIDGE_HTTP_URL}/say/stop`, { method: 'POST' }).catch(() => {})
}

let speakingAt = 0

/** When the current sentence started, or 0 if nothing is being spoken. The
 *  voice loop uses this to refuse to interrupt him in his own first syllable. */
export function speakingSince(): number {
  return speaking ? speakingAt : 0
}

function setSpeaking(text: string) {
  if (text) {
    speaking = text
    speakingAt = Date.now()
    return
  }
  if (speaking) {
    const now = Date.now()
    recent = recent.filter((r) => r.until > now)
    recent.push({ text: speaking, until: now + ECHO_TAIL_MS })
  }
  speaking = ''
}

/**
 * What the microphone is likely to be hearing from the speakers right now.
 *
 * The voice loop reads this to recognise itself: the mic stays open while he
 * talks, so it hears every word he says and would otherwise treat his own
 * answer as a barge-in. Includes a short tail of the previous sentence,
 * because the gap between two sentences is exactly when the echo of the first
 * one lands. See `isEcho` in voice.ts.
 */
export function speakingNow(): string {
  const now = Date.now()
  const tail = recent.filter((r) => r.until > now).map((r) => r.text).join(' ')
  return `${speaking} ${tail}`.trim()
}

// ---------------------------------------------------------------------------
// Sentence boundaries
// ---------------------------------------------------------------------------

/** Sentence end, allowing a closing quote or bracket — curly ones included,
 *  since models emit typographic punctuation far more often than ASCII. */
const SENTENCE_END = /([.!?]["'')\]”’]?\s)|(\n\n)/

/** Full stops that are not sentence ends. Cutting on these puts an audible
 *  gap inside "Mr. Stark" and reads as a stutter. */
const ABBREVIATION =
  /(?:^|\s)(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|inc|ltd|co|no|vol|fig|dept|est|min|max|hr|hrs|a\.m|p\.m|u\.s|u\.k|no)\.$/i

/**
 * Nobody punctuates forever, but a model occasionally writes a long clause
 * with no terminator at all — and while it does, nothing is spoken. Past this
 * many characters, cut at the last word boundary and start talking.
 */
const MAX_UNSPOKEN = 220

// ---------------------------------------------------------------------------
// Voice selection
// ---------------------------------------------------------------------------

// .yonna: a voice picked back when this was Yonna (Daniel) must not stick.
const VOICE_PREF_KEY = 'yonna.voice.yonna.2'

/**
 * Rank installed voices by how close they are to the character: Yonna, a
 * woman — clear, warm and level, not a novelty voice.
 *
 * The big win on macOS is an Enhanced/Premium voice. The stock ones are
 * compact voices from a decade ago and sound it; the Enhanced and Premium
 * downloads are free (System Settings → Accessibility → Spoken Content →
 * System Voice → Manage Voices) and once installed they appear here
 * automatically — Zoe, Ava or Serena (Premium) are the ones to get.
 */
function score(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase()
  let s = 0

  // Her voice, chosen by the user: Samantha (Enhanced) above everything.
  if (n.startsWith('samantha') && (n.includes('enhanced') || n.includes('premium'))) return 1000

  // Otherwise the natural-sounding female voices, best first. Samantha is
  // the one every Mac already has.
  if (/\b(zoe|ava|serena|allison|susan|kate|stephanie)\b/.test(n)) s += 90
  else if (n.startsWith('samantha')) s += 85
  else if (n.includes('google uk english female') || n.includes('google us english')) s += 80
  else if (/\b(karen|moira|tessa|fiona|veena)\b/.test(n)) s += 60
  // Newer macOS female voices — casual, but serviceable.
  else if (/\b(flo|sandy|shelley)\b/.test(n)) s += 45

  // Higher-quality variants of whatever matched above.
  if (n.includes('premium')) s += 30
  else if (n.includes('enhanced')) s += 20

  if (/en[-_](gb|us)/i.test(v.lang)) s += 10
  else if (/^en/i.test(v.lang)) s += 5

  // Voices that clearly are not her.
  if (/grandma|grandpa|bubbles|jester|bells|boing|whisper|zarvox|superstar|trinoids|wobble|bahh|organ|cellos|bad news|good news/.test(n)) {
    s -= 200
  }
  // Male-presenting names across the English sets.
  if (/\b(daniel|oliver|arthur|jamie|malcolm|reed|rocko|eddy|fred|albert|ralph|junior|aman|rishi|alex|tom|aaron|gordon|lee|nathan|evan)\b/.test(n)) {
    s -= 200
  }

  return s
}

/** Only voices that scored on a name match, not merely on being English —
 *  otherwise the picker cycles through a dozen US novelty voices. */
const USABLE = 40

/** Best-first list of usable voices — also what the voice picker cycles. */
export function candidateVoices(): SpeechSynthesisVoice[] {
  // Greek: every Greek voice installed, male first, then higher quality.
  // macOS ships Melina; Nikos and the Enhanced/Premium versions are free
  // downloads in System Settings → Accessibility → Read & Speak.
  if (isGreek()) {
    // Yonna is a man: Nikos (a free download) beats Melina whatever quality
    // either is installed at, then the higher-quality download wins.
    const rank = (v: SpeechSynthesisVoice) =>
      (/nikos|νίκος/i.test(v.name) ? 10 : 0) +
      (/premium/i.test(v.name) ? 2 : /enhanced/i.test(v.name) ? 1 : 0) +
      (v.localService ? 0.5 : 0)
    return speechSynthesis
      .getVoices()
      .filter((v) => /^el/i.test(v.lang))
      .sort((a, b) => rank(b) - rank(a))
  }
  return speechSynthesis
    .getVoices()
    .filter((v) => /^en/i.test(v.lang))
    .map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s >= USABLE)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v)
}

let cachedVoice: SpeechSynthesisVoice | null | undefined

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice
  const all = speechSynthesis.getVoices()
  if (!all.length) return null // not loaded yet — try again next utterance

  // Honour an explicit choice made with the voice picker. A saved name that no
  // longer resolves is dropped rather than left to resurrect itself silently
  // if that voice is ever reinstalled.
  const saved = localStorage.getItem(isGreek() ? `${VOICE_PREF_KEY}.el` : VOICE_PREF_KEY)
  if (saved) {
    const hit = all.find((v) => v.name === saved)
    if (hit) return (cachedVoice = hit)
    localStorage.removeItem(isGreek() ? `${VOICE_PREF_KEY}.el` : VOICE_PREF_KEY)
  }

  cachedVoice =
    candidateVoices()[0] ??
    all.find((v) => (isGreek() ? /^el/i : /^en/i).test(v.lang)) ??
    null
  return cachedVoice
}

/** What the HUD should show. Reports the engine actually in use rather than
 *  always naming a speechSynthesis voice that a cloud or neural engine has
 *  quietly replaced. */
export function currentVoiceName(): string {
  if (USE_ELEVENLABS || caps().tts) return 'ElevenLabs'
  if (BACKEND === 'bridge' && !sayBroken && !isGreek()) return 'Siri (the Mac voice)'
  if (TTS_ENGINE === 'kokoro' && !kokoro.isUnavailable()) {
    return KOKORO_VOICE.replace(/^bm_/, '')
  }
  return pickVoice()?.name ?? 'default'
}

/** Step to the next candidate — lets you audition voices on your own machine
 *  rather than trusting a ranking to be right about how they sound. */
export function cycleVoice(): string {
  const list = candidateVoices()
  if (!list.length) return 'default'
  const now = pickVoice()
  const i = list.findIndex((v) => v.name === now?.name)
  const next = list[(i + 1) % list.length]
  localStorage.setItem(isGreek() ? `${VOICE_PREF_KEY}.el` : VOICE_PREF_KEY, next.name)
  cachedVoice = next
  return next.name
}

// A language switch means a different voice: pick afresh.
onLang(() => {
  cachedVoice = undefined
})

// Voices load asynchronously in Chrome; the first call usually returns nothing.
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', () => {
    cachedVoice = undefined
    pickVoice()
  })
  pickVoice()
}

// ---------------------------------------------------------------------------
// Shared output analyser
// ---------------------------------------------------------------------------

/**
 * One AudioContext for every sentence ever spoken.
 *
 * Blink caps a document at roughly six concurrent hardware contexts. Building
 * one per sentence and never closing it meant the visualiser died partway
 * through the first long answer, silently, because the constructor throw was
 * caught and ignored.
 */
let outCtx: AudioContext | null = null

function outputContext(): AudioContext | null {
  try {
    if (!outCtx) outCtx = new AudioContext()
    if (outCtx.state === 'suspended') void outCtx.resume()
    return outCtx
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------

/**
 * Nudge the delivery toward Yonna's cadence.
 *
 * speechSynthesis ignores SSML, so punctuation is the only prosody control
 * available — the engine pauses on commas and full stops. Making sure the
 * vocative "sir" is always set off by a comma buys the small beat before it
 * that does most of the characterisation.
 */
function shape(text: string): string {
  return (
    text
      // Models leak markdown even when told not to, and a synthesiser will
      // happily read "https colon slash slash" out loud. Strip the syntax and
      // keep the words.
      .replace(/^\s*Sources?:.*$/gim, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) -> label
      // Stop before trailing punctuation, so "See https://x.com." keeps the
      // full stop that ends the sentence rather than having it eaten.
      .replace(/https?:\/\/[^\s]*[^\s.,;:!?)\]]/g, '')
      .replace(/[*_`#>]+/g, '')
      .replace(/^\s*[-•]\s+/gm, '')
      // (A comma used to be forced in before every "sir" for a butler's beat.
      // It made a pause that sounded unnatural, and she no longer says sir.)
      .replace(/\s+/g, ' ')
      .trim()
  )
}


type Item = {
  text: string
  /** Generation starts one sentence ahead, not all at once. */
  audio?: Promise<string | null> | null
}

export function createSpeaker(): Speaker {
  const queue: Item[] = []
  let buffer = ''
  let cancelled = false
  let outLevel = 0
  let pumping = false
  /**
   * Greek: finished sentences waiting while he is still speaking. Spoken as
   * one utterance the moment he is free, so an answer comes out as the first
   * sentence straight away and then the rest in one flowing piece — instead of
   * a gap between every sentence, or silence until the whole answer is written.
   */
  let held = ''
  /** Nothing has been spoken yet in this answer — see "speak sooner" in push. */
  let first = true
  let markStarted: () => void = () => {}
  const startedP = new Promise<void>((r) => (markStarted = r))

  let currentAudio: HTMLAudioElement | null = null
  let nativeInFlight = false
  let sayInFlight = false
  let drained: Array<() => void> = []

  const settleDrained = () => {
    const waiting = drained
    drained = []
    for (const r of waiting) r()
  }

  const enqueue = (sentence: string, priority = false) => {
    if (cancelled) return
    // Shape once here so both engines get the same text — stripped markdown,
    // and the comma before "sir" that buys the beat.
    const text = shape(sentence)
    if (!text) return

    const item: Item = { text }
    if (priority) {
      // Genuinely ahead of the queue this time. The old `say()` appended to the
      // same chain and only appeared to preempt because it was called when the
      // queue happened to be empty.
      queue.unshift(item)
    } else {
      queue.push(item)
    }
    void pump()
  }

  /** null means "no audio pipeline, use the system voice directly". */
  function synthesise(text: string): Promise<string | null> | null {
    // Prefer the ElevenLabs voice whenever the bridge reports it is available —
    // for a demo the timbre is worth the round trip, and this is what makes the
    // premium path automatic with no flag to set. It falls back to the browser
    // voice on any failure, so a student without a key still hears him speak.
    // `nativeBroken` latches on once the system voice has proved unusable.
    if (USE_ELEVENLABS || caps().tts || nativeBroken) {
      // Recorded at the moment the tier is chosen rather than only when the
      // native voice latches over. Without this the panel reported 'system'
      // for a session that had spoken every one of its sentences through
      // ElevenLabs, which makes the one field naming the engine useless
      // exactly when you are trying to work out which engine is at fault.
      diag.engine = 'elevenlabs'
      return fetchCloudAudio(text).catch(() => null)
    }
    if (TTS_ENGINE === 'kokoro' && !kokoro.isUnavailable()) {
      diag.engine = 'kokoro'
      return kokoro.speak(text).catch(() => null)
    }
    diag.engine = 'system'
    return null
  }

  /** Start generating an item's audio if it hasn't begun. */
  const prime = (item: Item | undefined) => {
    if (item && item.audio === undefined) item.audio = synthesise(item.text)
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        if (cancelled) break
        let item = queue.shift()
        if (!item && held.trim()) {
          const next = held
          held = ''
          enqueue(next)
          item = queue.shift()
        }
        if (!item) break

        prime(item)
        // Exactly one sentence ahead. Priming the whole queue fires every
        // request at once — four parallel cloud POSTs, or four concurrent
        // generations against a single ONNX session.
        prime(queue[0])

        await speakOne(item)
      }
    } finally {
      pumping = false
      if (cancelled || !queue.length) settleDrained()
    }
  }

  async function speakOne(item: Item): Promise<void> {
    if (cancelled) return
    setSpeaking(item.text)
    try {
      const url = item.audio ? await item.audio : null
      if (cancelled) return
      // A failed generation is not a failed turn — drop to the system voice.
      if (url) {
        await playUrl(url, item.text)
        return
      }

      // The Mac's Siri voice, as Atticus speaks — English only: it cannot do Greek.
      if ((BACKEND === 'bridge' || nativeVoice()) && !sayBroken && !isGreek()) {
        const said = await speakSay(item.text)
        // Not said and not broken: it was cut off (a newer line, a barge-in).
        // Saying it again in another voice would only talk over that.
        if (said || cancelled || !sayBroken) return
      }

      const spoke = await speakNative(item.text)
      if (spoke || cancelled) return

      // The OS voice produced no sound. That is not recoverable by retrying it,
      // so latch it off and rescue this sentence through the bridge's speech
      // proxy — which already holds an ElevenLabs key borrowed from the MCP
      // config. Losing the better timbre is a far smaller failure than a
      // assistant that answers in silence.
      if (!nativeBroken) {
        nativeBroken = true
        diag.nativeBroken = true
        diag.engine = 'elevenlabs'
        console.warn('[yonna] system voice is not producing sound — using the bridge speech proxy from here on')
      }
      const rescue = await fetchCloudAudio(item.text).catch(() => null)
      if (rescue && !cancelled) {
        diag.rescued++
        await playUrl(rescue, item.text)
      }
    } finally {
      if (speaking === item.text) setSpeaking('')
    }
  }

  /** Said by the Mac itself (bridge → `say`). True once it has been spoken. */
  const speakSay = async (text: string): Promise<boolean> => {
    sayInFlight = true
    diag.engine = 'siri'
    diag.spoken++
    // `say` reports no loudness either: the same speech-like envelope.
    let raf = 0
    let t = 0
    const tick = () => {
      t += 0.08
      outLevel = 0.35 + Math.abs(Math.sin(t * 2.1)) * 0.3 + Math.abs(Math.sin(t * 5.7)) * 0.2
      raf = requestAnimationFrame(tick)
    }
    // Sound starts a beat after the request; close enough for the screen.
    const startTimer = setTimeout(() => {
      markStarted()
      tick()
    }, 150)
    try {
      const n = nativeVoice()
      if (n) return (await n.postMessage({ op: 'say', text })) === true
      const r = await fetch(`${BRIDGE_HTTP_URL}/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const { ok } = (await r.json()) as { ok: boolean }
      return ok
    } catch (err) {
      // The Mac voice may well be speaking already even though the answer
      // never came back: silence it, or the browser voice saying the same
      // line on top of it is two voices at once.
      stopSay()
      if (!cancelled) {
        sayBroken = true
        console.warn(`[yonna] the Mac voice failed (${String(err)}) — using the browser voice from here on`)
      }
      return false
    } finally {
      clearTimeout(startTimer)
      cancelAnimationFrame(raf)
      outLevel = 0.12
      sayInFlight = false
    }
  }

  const speakNative = (text: string) =>
    new Promise<boolean>((resolve) => {
      // Chrome's speechSynthesis wedges after cancel().
      //
      // This is the single most likely reason a whole session goes silent. The
      // engine is a global singleton, `cancel()` can leave its queue in a state
      // where every subsequent speak() is accepted and then never spoken — no
      // error, no events, just silence for the rest of the page's life. Barge-in
      // calls cancel() constantly now that the microphone stays open, so what
      // used to be a rare quirk became the common case.
      //
      // resume() is the documented un-wedge. It is a no-op when nothing is
      // paused, so it is safe to fire before every utterance.
      speechSynthesis.resume()

      const u = new SpeechSynthesisUtterance(text)
      const voice = pickVoice()
      if (voice) u.voice = voice
      u.lang = voice?.lang ?? (isGreek() ? 'el-GR' : 'en-GB')
      // Deliberate, and deliberately invariant — the character's pace does not
      // change with stakes, and that steadiness is most of the effect. This
      // lands around 130 wpm, below the median for film dialogue.
      // Greek at a natural conversational pace; the slow, measured delivery is
      // the English butler's, and in Greek it only sounded laboured.
      // 0.92 was a deliberately slow butler's pace; it read as laboured rather
      // than measured, so both languages now speak at a natural rate.
      u.rate = isGreek() ? 1.0 : 0.98
      // Her voice as it is: not pitched up to sound "female" or down for
      // gravitas — either one reads as an effect rather than a person.
      u.pitch = 1

      // speechSynthesis exposes no amplitude, so drive the reactor from a
      // synthetic envelope. It only has to look like speech, not match it.
      let raf = 0
      let t = 0
      const tick = () => {
        t += 0.08
        outLevel =
          0.35 +
          Math.abs(Math.sin(t * 2.1)) * 0.3 +
          Math.abs(Math.sin(t * 5.7)) * 0.2
        raf = requestAnimationFrame(tick)
      }
      tick()

      let done = false
      let started = false
      let watchdog: ReturnType<typeof setTimeout> | null = null
      let keepalive: ReturnType<typeof setInterval> | null = null

      const finish = () => {
        if (done) return
        done = true
        nativeInFlight = false
        if (watchdog) clearTimeout(watchdog)
        if (keepalive) clearInterval(keepalive)
        cancelAnimationFrame(raf)
        // Held rather than zeroed, so the orb doesn't collapse in the gap
        // between two sentences of the same answer.
        outLevel = 0.12
        // The whole point of the boolean: `true` only if sound actually began.
        resolve(started)
      }

      u.onstart = () => {
        markStarted()
        started = true
        diag.started++
        diag.lastError = ''
        if (watchdog) clearTimeout(watchdog)
        // Chrome stops speaking after roughly fifteen seconds unless the engine
        // is nudged. A pause/resume pair is the standard keepalive and is
        // inaudible; without it long answers cut off mid-sentence.
        keepalive = setInterval(() => {
          if (done) return
          speechSynthesis.pause()
          speechSynthesis.resume()
        }, 5000)
      }
      u.onend = finish
      // Swallowing this was a mistake. When the OS voice fails there is no
      // other signal at all — no exception, no silence you can detect from
      // code — so an unlogged onerror turns a broken voice into an unexplained
      // quiet app, which is exactly the bug that took three attempts to find.
      u.onerror = (e) => {
        const code = String((e as SpeechSynthesisErrorEvent).error ?? 'unknown')
        diag.lastError = code
        // 'interrupted' and 'canceled' are us, cancelling deliberately on a
        // barge-in. Everything else means the engine could not speak.
        if (code !== 'interrupted' && code !== 'canceled') {
          diag.failures++
          console.error(`[yonna] speech failed (${code}) on voice "${u.voice?.name ?? 'default'}"`)
        }
        finish()
      }

      // If `start` never arrives the engine has swallowed the utterance, and
      // nothing else will ever tell us — no error fires. Un-wedge and try once
      // more; if that also goes nowhere, resolve rather than hang, because a
      // silent sentence is recoverable and a stuck queue is not.
      watchdog = setTimeout(() => {
        if (done || started) return
        console.warn('[yonna] speech did not start — un-wedging the engine')
        speechSynthesis.cancel()
        speechSynthesis.resume()
        try {
          speechSynthesis.speak(u)
        } catch {
          finish()
          return
        }
        watchdog = setTimeout(() => {
          if (done || started) return
          console.error('[yonna] speech engine is not responding — switching to the cloud voice')
          diag.failures++
          diag.lastError = diag.lastError || 'no-start'
          finish()
        }, 1500)
      }, 700)
      diag.spoken++
      diag.lastText = text.slice(0, 60)
      diag.voice = u.voice?.name ?? 'default'
      nativeInFlight = true
      speechSynthesis.speak(u)
    })

  const playUrl = (url: string, text: string) =>
    new Promise<void>((resolve) => {
      const audio = new Audio(url)
      currentAudio = audio
      // The generated path is an engine speaking just as much as the OS voice
      // is, so it keeps the same books. `spoken` counts the hand-off, `started`
      // is only incremented once the element reports it is actually playing —
      // see the onplaying handler below.
      diag.spoken++
      diag.lastText = text.slice(0, 60)
      diag.voice = diag.engine === 'kokoro' ? KOKORO_VOICE : 'ElevenLabs'

      let read: (() => number) | null = null
      const ctx = outputContext()
      if (ctx) {
        try {
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          ctx.createMediaElementSource(audio).connect(analyser)
          analyser.connect(ctx.destination)
          const bins = new Uint8Array(analyser.frequencyBinCount)
          read = () => {
            analyser.getByteFrequencyData(bins as Uint8Array<ArrayBuffer>)
            let sum = 0
            for (let i = 2; i < bins.length; i++) sum += bins[i]
            return Math.min(1, (sum / (bins.length - 2) / 255) * 3.5)
          }
        } catch {
          /* the analyser is a nice-to-have */
        }
      }

      let raf = 0
      const tick = () => {
        outLevel = read ? read() : 0.4
        raf = requestAnimationFrame(tick)
      }
      tick()

      let done = false
      const finish = () => {
        if (done) return
        done = true
        cancelAnimationFrame(raf)
        outLevel = 0.12
        URL.revokeObjectURL(url)
        if (currentAudio === audio) currentAudio = null
        resolve()
      }
      // Sound is genuinely coming out. This is the cloud/neural counterpart of
      // SpeechSynthesisUtterance.onstart, and it is what makes the diagnostics
      // verdict — and the T self-test — tell the truth on the premium path.
      audio.onplaying = () => {
        diag.started++
        diag.lastError = ''
      }
      audio.onended = finish
      audio.onerror = () => {
        // A decode or network failure on a blob we already hold is rare, but
        // silent when it happens: the sentence simply never plays and the queue
        // moves on. Count it rather than letting it look like nothing was said.
        diag.failures++
        diag.lastError = 'audio-element'
        finish()
      }
      // The one that matters for barge-in: cancel() pauses the element, and a
      // paused element never fires `ended`. Without this the promise never
      // settles and every await behind it hangs for the life of the page.
      audio.onpause = finish
      audio.onplaying = () => markStarted()
      void audio.play().catch((err) => {
        diag.failures++
        diag.lastError = String((err as Error)?.name ?? 'play-rejected')
        finish()
      })
    })

  return {
    say(text) {
      enqueue(text, true)
    },
    push(delta) {
      if (cancelled) return
      buffer += delta

      // Complete sentences start speaking at once if he is quiet, and otherwise
      // gather into `held` to follow as one piece — so an answer flows instead
      // of stopping between every sentence. See `held`. (Was Greek-only; in
      // English the gaps sounded just as unnatural.)
      let from = 0
      for (;;) {
        const m = SENTENCE_END.exec(buffer.slice(from))
        if (!m) break
        const cut = from + m.index + m[0].length
        // "Mr. Stark" is not two sentences: look past the abbreviation.
        if (ABBREVIATION.test(buffer.slice(0, cut).trimEnd())) {
          from = cut
          continue
        }
        held += buffer.slice(0, cut)
        buffer = buffer.slice(cut)
        from = 0
      }
      // Speak sooner: the very first words of an answer need not wait for the
      // end of a long first sentence. At its first comma or dash, once there
      // are a few words, she starts. Not when the next word is "sir" — a
      // lone "sir." spoken on its own afterwards sounds broken — and only once
      // that next word has arrived, so that can be checked.
      if (first && !held) {
        const clause = /^(.*?\S)([,;:]|\s[–—])\s+(\S+)/s.exec(buffer)
        if (clause && clause[1].split(/\s+/).length >= 4 && !/^sir\b/i.test(clause[3])) {
          const cut = clause[1].length + clause[2].length
          held = buffer.slice(0, cut)
          buffer = buffer.slice(cut)
        } else {
          // No comma yet: start anyway once a few words are in, breaking just
          // before a joining word — where a person would naturally breathe —
          // so the split does not land in the middle of a phrase.
          const words = buffer.split(/\s+/).filter(Boolean)
          // Only whole words: the last one may still be arriving.
          const complete = /\s$/.test(buffer) ? words.length : words.length - 1
          if (complete >= 6) {
            const joint = /\s(and|but|so|because|which|that|who|with|in|at|on|for|to|from|about|after|before|when|while|if|than|or|until|since)\s/gi
            let cut = -1
            for (let m; (m = joint.exec(buffer)); ) {
              const before = buffer.slice(0, m.index).split(/\s+/).filter(Boolean).length
              if (before >= 4) {
                cut = m.index
                break
              }
            }
            // A long run with no joint at all: just go, at the last whole word.
            if (cut < 0 && complete >= 10) cut = buffer.trimEnd().lastIndexOf(' ')
            if (cut > 0) {
              held = buffer.slice(0, cut)
              buffer = buffer.slice(cut)
            }
          }
        }
      }
      // A long run with no full stop would otherwise sit unspoken: cut it at a
      // word boundary and let it start.
      if (!held && buffer.length > MAX_UNSPOKEN) {
        const cut = buffer.lastIndexOf(' ', MAX_UNSPOKEN)
        if (cut > 40) {
          held = buffer.slice(0, cut)
          buffer = buffer.slice(cut)
        }
      }
      if (held.trim() && !pumping && !queue.length) {
        const next = held
        held = ''
        first = false
        enqueue(next)
      }
    },
    async end() {
      if (held.trim() || buffer.trim()) {
        const rest = held + buffer
        held = ''
        buffer = ''
        if (rest.trim()) enqueue(rest)
      }
      if (cancelled) return markStarted()
      if (!pumping && !queue.length) return markStarted()
      await new Promise<void>((resolve) => drained.push(resolve))
      // Nothing ever sounded (a voice failure): do not hold the screen hostage.
      markStarted()
    },
    cancel() {
      markStarted()
      if (cancelled) return
      cancelled = true
      buffer = ''
      held = ''
      queue.length = 0
      // Keep the echo tail: the words already in the air still have to be
      // recognised and discarded, even though he has stopped adding to them.
      setSpeaking('')

      // Only reach for the global cancel if this speaker actually has a native
      // utterance out — speechSynthesis.cancel() is document-wide and would
      // otherwise silence an unrelated speaker mid-word.
      if (nativeInFlight) {
        nativeInFlight = false
        speechSynthesis.cancel()
        // Always pair the cancel with a resume — see the note in speakNative.
        // Leaving the engine cancelled is what silences every later sentence.
        speechSynthesis.resume()
      }
      if (sayInFlight) {
        sayInFlight = false
        stopSay()
      }
      if (currentAudio) {
        currentAudio.pause()
        currentAudio = null
      }
      outLevel = 0
      settleDrained()
    },
    level: () => outLevel,
    started: () => startedP,
  }
}

/** Only used when USE_ELEVENLABS is on. Bridge proxy first (it already holds
 *  the key), then a direct key, then null to fall back to the native voice. */
async function fetchCloudAudio(text: string): Promise<string | null> {
  if (BACKEND === 'bridge') {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (res.ok) return URL.createObjectURL(await res.blob())
    } catch {
      /* fall through */
    }
  }

  if (env.elevenKey) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${env.elevenVoiceId}/stream` +
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': env.elevenKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (res.ok) return URL.createObjectURL(await res.blob())
    } catch {
      /* fall through */
    }
  }

  return null
}
