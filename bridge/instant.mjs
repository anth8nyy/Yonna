import { execFile } from 'node:child_process'
import { closeAll, closeNamed, openNamed } from './apps.mjs'
import { findPlace, forecast, homePlace, setHome, spoken } from './weather.mjs'
import { chance, quick } from './quick.mjs'
import { openMeetingWindow } from './mac.mjs'

/**
 * Instant commands: the simple, common things done with no AI at all.
 *
 * Taken from Atticus, which does the same: "open Spotify", "what time is it",
 * "set a timer for five minutes" do not need a model to understand them, and
 * sending them to one costs a second or two for nothing. These are matched by
 * pattern and done directly — well under a tenth of a second.
 *
 * Deliberately narrow. Only a request that is exactly one of these shapes is
 * taken; anything with more in it ("open Spotify and play my liked songs",
 * "what time is it in Tokyo") goes to Yonna as usual. A name that does not
 * match an installed app is handed back too, so "open YouTube" still reaches
 * the AI, which can open the website instead.
 */

const NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90, half: 0.5,
}
const num = (w) => (/^\d+(\.\d+)?$/.test(w) ? Number(w) : NUMBERS[w])

/** Politeness and fillers around the command, which change nothing. */
function plain(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/^(?:(?:hey|ok|okay)\s+)?(?:yonna[,\s]+)?/, '')
    .replace(/^(?:can you|could you|would you|will you|please|just)\s+/, '')
    .replace(/[\s,]*(?:please|for me|now|thanks|thank you|sir)?[\s.!?]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const SPOKEN_UNITS = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600 }

function say(text, extra = {}) {
  return { handled: true, say: text, ...extra }
}

const osa = (script) =>
  new Promise((resolve) => execFile('/usr/bin/osascript', ['-e', script], (err, out) => resolve(err ? null : String(out).trim())))

let seq = 0

export async function instant(raw) {
  const t = plain(raw)
  if (!t || t.length > 80) return { handled: false }
  // "A random number between 1 and 10" has an "and" that is not a second ask.
  const luck = chance(t)
  if (luck) return say(luck)
  // "I'm getting ready for a meeting", "open the meeting window", "meeting mode".
  if (
    /^(?:i(?:'m| am) )?(?:getting ready|getting ready for|preparing for|about to (?:start|join|have)|joining|going (?:in)?to|starting|heading (?:in)?to|in) (?:a |my |the )?(?:meeting|call|zoom|teams call|google meet)(?: now| soon| in a (?:minute|bit))?$/.test(t) ||
    /^(?:open|show|start) (?:the |my )?meeting(?: window| mode| helper)?$|^meeting mode$/.test(t) ||
    /^(?:i have|i've got) (?:a )?meeting(?: now| soon| in a (?:minute|bit))?$/.test(t)
  ) {
    return say(await openMeetingWindow())
  }

  // More than one thing asked: that is Yonna's job.
  if (/\b(and|then|after|also|but)\b/.test(t)) return { handled: false }

  // The time and the date.
  if (/^(?:what(?:'s| is) the time|what time is it|tell me the time|the time|time)$/.test(t)) {
    const now = new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })
    return say(`It's ${now.replace(/^0/, '')}.`)
  }
  if (/^(?:what(?:'s| is) (?:the )?date(?: today)?|what day is (?:it|today)|what(?:'s| is) today(?:'s date)?)$/.test(t)) {
    const d = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    return say(`It's ${d}.`)
  }

  // The time somewhere else: "what time is it in Tokyo".
  const tz = t.match(/^(?:what(?:'s| is) the time|what time is it) in ([\w .'-]{2,40})$/)
  if (tz) {
    const p = await findPlace(tz[1])
    if (!p?.timeZone) return { handled: false }
    const at = new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: p.timeZone })
    return say(`It's ${at.replace(/^0/, '')} in ${p.name}.`)
  }

  // Where "here" is, for the weather.
  const live = t.match(/^(?:i live in|i'm in|i am in|my city is|set my (?:home|city|location) to) ([\w .'-]{2,40})$/)
  if (live) {
    const p = await setHome(live[1])
    return p ? say(`Got it, ${p.name}.`) : { handled: false }
  }

  // Weather, straight from a weather service: "what's the weather", "weather
  // in London tomorrow", "will it rain tomorrow", "how hot is it".
  const wx =
    t.match(/^(?:what(?:'s| is) the |how(?:'s| is) the |what's |the )?weather(?: going to be)?(?: like)?(?: (today|now|right now|outside|tomorrow))?(?: in ([\w .'-]{2,40}?))?(?: (today|now|tomorrow))?$/) ??
    t.match(/^(?:what(?:'s| is) the )?(?:temperature|temp)(?: outside| now| today)?(?: in ([\w .'-]{2,40}))?$()()/) ??
    t.match(/^how (?:hot|cold|warm) is it(?: outside)?(?: in ([\w .'-]{2,40}))?()()$/)
  const rain = t.match(/^(?:is it going to|will it|is it gonna|does it) rain(?: (today|tomorrow))?(?: in ([\w .'-]{2,40}?))?(?: (today|tomorrow))?$/)
  if (wx || rain) {
    const m = wx ?? rain
    // Which groups hold the day and the place depends on the pattern.
    const parts = m.slice(1).filter(Boolean)
    const dayWord = parts.find((x) => /^(today|now|right now|outside|tomorrow)$/.test(x))
    const placeName = parts.find((x) => x !== dayWord)
    const p = placeName ? await findPlace(placeName) : await homePlace()
    if (!p) return { handled: false }
    const w = await forecast(p).catch(() => null)
    if (!w) return { handled: false }
    const day = dayWord === 'tomorrow' ? 1 : 0
    if (rain) {
      const d = w.days[day]
      const when = day ? 'tomorrow' : 'today'
      return say(
        d.rain >= 50
          ? `Probably, yes — ${d.rain}% chance of rain ${when} in ${w.place}.`
          : d.rain >= 20
            ? `Maybe — ${d.rain}% chance of rain ${when} in ${w.place}.`
            : `Doesn't look like it — ${d.rain ?? 0}% chance ${when} in ${w.place}.`,
      )
    }
    return say(spoken(w, day))
  }

  // Timers: "set a timer for 5 minutes", "10 minute timer", "timer 30 seconds".
  const timer =
    t.match(/^(?:set |start )?(?:a |an )?(?:timer|countdown)(?: for)? ([\w.-]+) (second|sec|minute|min|hour)s?$/) ??
    t.match(/^(?:set |start )?(?:a |an )?([\w.-]+)[ -](second|sec|minute|min|hour)s? (?:timer|countdown)$/)
  if (timer) {
    const n = num(timer[1])
    const unit = SPOKEN_UNITS[timer[2]]
    if (n && unit) {
      const ms = Math.round(n * unit * 1000)
      return say('Timer set.', {
        blade: {
          id: `timer-${Date.now().toString(36)}-i${seq++}`,
          title: 'COUNTDOWN',
          kind: 'timer',
          endsAt: Date.now() + ms,
          durationMs: ms,
          size: 'compact',
          hold: 'sticky',
        },
      })
    }
  }
  if (/^(?:start |set )?(?:a )?stopwatch$/.test(t)) {
    return say('Stopwatch started.', {
      blade: {
        id: `stopwatch-${Date.now().toString(36)}-i${seq++}`,
        title: 'STOPWATCH',
        kind: 'stopwatch',
        startedAt: Date.now(),
        size: 'compact',
        hold: 'sticky',
      },
    })
  }

  // Volume — the Mac's sound, not her microphone.
  const vol = t.match(/^(?:set (?:the )?)?volume (?:to )?(\d{1,3})(?: percent| %|%)?$/)
  if (vol) {
    const v = Math.max(0, Math.min(100, Number(vol[1])))
    await osa(`set volume output volume ${v}`)
    return say(`Volume ${v}.`)
  }
  if (/^(?:turn (?:the )?)?(?:volume|sound|music) up(?: a bit| a little)?$|^turn (?:up|it up) (?:the )?(?:volume|sound|music)?$|^(?:turn it up|louder|a bit louder|make it louder)$|^(?:raise|increase) (?:the )?(?:volume|sound)$/.test(t)) {
    const cur = Number(await osa('output volume of (get volume settings)')) || 0
    await osa(`set volume output volume ${Math.min(100, cur + 15)}`)
    return say('Louder.')
  }
  if (/^(?:turn (?:the )?)?(?:volume|sound|music) down(?: a bit| a little)?$|^turn (?:down|it down) (?:the )?(?:volume|sound|music)?$|^(?:turn it down|quieter|a bit quieter|make it quieter)$|^(?:lower|decrease) (?:the )?(?:volume|sound)$/.test(t)) {
    const cur = Number(await osa('output volume of (get volume settings)')) || 0
    await osa(`set volume output volume ${Math.max(0, cur - 15)}`)
    return say('Quieter.')
  }
  if (/^mute (?:the )?(?:sound|volume|audio|mac)$/.test(t)) {
    await osa('set volume with output muted')
    return say('')
  }
  if (/^unmute (?:the )?(?:sound|volume|audio|mac)$/.test(t)) {
    await osa('set volume without output muted')
    return say('Sound on.')
  }

  // Apps.
  if (/^(?:close|quit) (?:all|everything|all (?:the |my )?(?:apps|applications|windows|programs))$/.test(t)) {
    return say(short(await closeAll()))
  }
  const open = t.match(/^(?:open|launch|start) (?:up )?(?:the )?([\w .'-]{2,30}?)(?: app| application)?$/)
  if (open && open[1].split(' ').length <= 3) {
    const out = await openNamed(open[1])
    // Not an installed app ("open YouTube"): Yonna may know what to do instead.
    if (!/ is open/.test(out)) return { handled: false }
    return say(`${out.split(' is open')[0]}.`)
  }
  const close = t.match(/^(?:close|quit) (?:the )?([\w .'-]{2,30}?)(?: app| application)?$/)
  if (close && close[1].split(' ').length <= 3) {
    const out = await closeNamed(close[1])
    // Not a running app ("close the door", "close the tab"): Yonna decides.
    if (/is not running/.test(out)) return { handled: false }
    return say(short(out))
  }

  // Maths, units, currency, countdowns, today's calendar, music, battery,
  // definitions, sunrise and sunset — see quick.mjs.
  const q = await quick(t)
  if (q != null) return say(q)

  return { handled: false }
}

/** Her answers are spoken: "Closed: Spotify, Safari." reads well enough, but
 *  the long "still open" explanation is cut to its point. */
function short(text) {
  return text.replace(/Still open, probably asking to save unsaved work:/, 'Still open:')
}
