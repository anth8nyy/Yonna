import { execFile } from 'node:child_process'
import { closeAll, closeNamed, installedApps, nameList, openApps, openNamed } from './apps.mjs'
import { closest } from './names.mjs'
import { findPlace, forecast, homePlace, setHome, spoken } from './weather.mjs'
import { chance, quick } from './quick.mjs'
import { openMeetingWindow } from './mac.mjs'
import { cancelShutdownPc, closeOnPc, openOnPc, openPc, pcIsOn, shutdownPc, siteFor, wakePc } from './pc.mjs'
import { cancelShutdownMac, macCountingDown, shutdownMac } from './macpower.mjs'
import { colourNames, lights } from './lights.mjs'
import { callFromMac, whoToCall } from './calls.mjs'

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
    .replace(/^(?:i want you to|i want to|i'd like you to|i would like you to|i need you to|go ahead and|can you please|could you please|please can you)\s+/, '')
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

/**
 * Several commands in one — "turn off the lights and close all my apps",
 * "make the one light blue and the other one purple": each done in turn.
 * Only when the first part is a command; then a part that isn't is left out
 * and said so. Song and artist names keep their "and" ("play Simon and
 * Garfunkel").
 */
export async function instant(raw, opts = {}) {
  const r = await several(raw, opts)
  return r.handled ? { ...r, say: briefly(plain(raw), r.say) } : r
}

/**
 * A command that worked is answered "Done." — not a list of what was closed,
 * not the request said back. A reply says more only when it's worth hearing:
 * it didn't work, it was already so, there's a choice to make, a call is
 * being placed, or it answers a question (time, weather, what's open…).
 */
function briefly(t, reply) {
  const command = /^(?:open|close|quit|exit|launch|start|run|play|pause|resume|skip|turn|switch|put|shut|power|kill|dim|brighten|make|change|cancel|wake|boot|go to|lights?\b|light \d|\d light)/.test(t)
  if (!command || /\b(?:timer|alarm|remind)/.test(t)) return reply
  if (!reply || /\?|\b(?:couldn't|can't|cannot|isn't|aren't|wasn't|didn't|don't|not|no|nobody|nothing|already|which|failed|unable|missing|allow|waiting|sign-in|password|still open|calling|I turned)\b/i.test(reply)) return reply
  return ack()
}

/** "Done." and its friends, never the same twice in a row. */
const ACKS = ['Done.', 'Got it.', 'Okay.', 'All set.', 'There you go.', 'On it.', 'Done.', 'Sure.']
let lastAck = ''
function ack() {
  let a
  do a = ACKS[Math.floor(Math.random() * ACKS.length)]
  while (a === lastAck)
  lastAck = a
  return a
}

async function several(raw, opts = {}) {
  const t = plain(raw)
  if (!t || /^play /.test(t) || chance(t) || !/ (?:and|then|and then|also) /.test(t)) return one(raw, opts)
  const parts = t
    .split(/,? (?:and then|and also|then|and|also) /)
    .map((p) => p.trim())
    .filter(Boolean)
    // "the one light … the other one": the first and the second.
    .map((p) => p.replace(/\b(?:the )?(?:one|first) (?:light|lamp|bulb)\b/, 'light 1').replace(/\b(?:the )?(?:other|second) (?:one|light|lamp|bulb)\b/, 'light 2'))
  if (parts.length < 2 || parts.length > 4) return one(raw, opts)
  const first = await one(parts[0], opts)
  if (!first.handled) return one(raw, opts)
  const said = [first.say]
  for (const p of parts.slice(1)) {
    const r = await one(p, opts)
    said.push(r.handled ? r.say : `I didn't do "${p}" — ask me that on its own.`)
  }
  return say(said.filter(Boolean).join(' '))
}

/** When the lights were last asked about: a bare "red" or "brighter" right after means them. */
let lightsAt = 0

async function one(raw, { askPassword = null, from = 'mac' } = {}) {
  let t = plain(raw)
  // Only thanks (which plain() takes away as politeness): nothing left to do.
  if (!t && /\b(?:thanks|thank you|cheers)\b/i.test(String(raw))) return say('Anytime.')
  // Only her name ("Hey Yonna"): she's listening.
  if (!t && /\b(?:hey|hi|hello|ok|okay|yonna)\b/i.test(String(raw))) t = 'hello'
  if (!t || t.length > 80) return { handled: false }
  // Hello and thanks: no need to think about those.
  if (/^(?:(?:hi|hello|hey|hey there|hi there|yo|good (?:morning|afternoon|evening))(?: yonna)?|yonna)$/.test(t)) {
    const h = new Date().getHours()
    return say(`${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}. What can I do?`)
  }
  if (/^(?:thanks|thank you|thank you so much|thanks a lot|cheers|great thanks|perfect thanks)(?: yonna)?$/.test(t)) return say('Anytime.')
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

  // "Close all apps except Spotify and Safari" — on this Mac, or with "on my
  // PC" on the PC. Before the check below: its "and" is a list, not two asks.
  const PC_ = '(?:my |the )?(?:other )?(?:pc|computer|windows(?: pc| computer)?|desktop)'
  // "Close all apps except Spotify and Discord on my PC" / "…on my PC except Spotify".
  const ALL = '(?:close|quit|shut) (?:down )?(?:all|everything|all (?:of )?(?:the |my )?(?:open )?(?:apps|applications|windows|programs|games))'
  const pcBut = t.match(new RegExp(`^${ALL} (?:except|but|apart from|other than) (.+?) (?:on|in|at) ${PC_}$`)) ||
    t.match(new RegExp(`^${ALL} (?:on|in|at) ${PC_} (?:except|but|apart from|other than) (.+)$`))
  if (pcBut) return say(await closeOnPc('*', nameList(pcBut[1])))
  const macBut = t.match(/^(?:close|quit|shut) (?:down )?(?:all|everything|all (?:of )?(?:the |my )?(?:open )?(?:apps|applications|windows|programs)) (?:except|but|apart from|other than) (?:for )?(.+?)$/)
  if (macBut && !/ (?:on|in|at) (?:my |the )?(?:other )?(?:pc|computer|windows|desktop)/.test(t)) return say(short(await closeAll(nameList(macBut[1]))))

  // The lights: "turn on the lights", "desk light off", "dim the lights",
  // "lights to 40%", "make the lights red". Before the check below — "turn
  // the lights on and off" isn't a thing, but "red and…" phrasing sometimes is.
  const LIGHT = '(?:the |my |all (?:of )?(?:the |my )?)?((?:[a-z0-9]+ ){0,2}?)(?:lights?|lamps?|bulbs?)'
  const named = (m) => (m && m.trim() ? m.trim() : null)
  // "Light 2" is the bulb called that: said as "2 light", like "desk light".
  t = t.replace(/\b(lights?|lamps?|bulbs?) (\d{1,2}|one|two|three)\b(?! ?(?:%|percent))/, (_, w, n) => `${{ one: 1, two: 2, three: 3 }[n] ?? n} ${w}`)
  let lm
  // Right after a lights command, "red", "brighter", "50%" mean the lights.
  if (Date.now() - lightsAt < 120_000) {
    if (new RegExp(`^(?:make (?:it|them) |now |and )?(${colourNames.join('|')})(?: please)?$`).test(t)) t = `lights ${t.replace(/^(?:make (?:it|them) |now |and )/, '')}`
    else if (/^(?:brighter|more|up)$/.test(t)) t = 'make the lights bright'
    else if (/^(?:dimmer|darker|less|down|dim)$/.test(t)) t = 'dim the lights'
    else if (/^(?:to )?(\d{1,3}) ?(?:%|percent)$/.test(t)) t = `lights ${t.replace(/^to /, '')}`
  }
  if ((lm = t.match(new RegExp(`^(?:turn|switch|put) on ${LIGHT}$|^(?:turn|switch|put) ${LIGHT} on$|^${LIGHT} on$|^open ${LIGHT}$`)))) {
    lightsAt = Date.now()
    return say(await lights('on', null, named(lm[1] ?? lm[2] ?? lm[3] ?? lm[4])))
  }
  if ((lm = t.match(new RegExp(`^(?:turn|switch|put) off ${LIGHT}$|^(?:turn|switch|put) ${LIGHT} off$|^${LIGHT} off$|^(?:kill|close) ${LIGHT}$`)))) {
    lightsAt = Date.now()
    return say(await lights('off', null, named(lm[1] ?? lm[2] ?? lm[3] ?? lm[4])))
  }
  if ((lm = t.match(new RegExp(`^dim ${LIGHT}$|^(?:make|turn|set) ${LIGHT} (?:dim|dimmer|low|darker)$|^${LIGHT} (?:dim|low)$`)))) {
    lightsAt = Date.now()
    return say(await lights('bright', 25, named(lm[1] ?? lm[2] ?? lm[3])))
  }
  if ((lm = t.match(new RegExp(`^brighten ${LIGHT}$|^(?:make|turn|set) ${LIGHT} (?:bright|brighter|full|max(?:imum)?)(?: brightness)?$|^${LIGHT} (?:bright|full|max)$|^${LIGHT} (?:to |at )?full brightness$`)))) {
    lightsAt = Date.now()
    return say(await lights('bright', 100, named(lm[1] ?? lm[2] ?? lm[3] ?? lm[4])))
  }
  if ((lm = t.match(new RegExp(`^(?:set|turn|put|make)? ?${LIGHT} (?:to |at )?(\\d{1,3}) ?(?:%|percent)?(?: brightness)?$`))) && !/\b(?:on|off)\b/.test(lm[1] ?? '')) {
    lightsAt = Date.now()
    return say(await lights('bright', Number(lm[2]), named(lm[1])))
  }
  const COLOUR = `(${colourNames.sort((a, b) => b.length - a.length).join('|')})`
  if ((lm = t.match(new RegExp(`^(?:make|turn|set|change|put) ${LIGHT} (?:to )?${COLOUR}$|^${LIGHT} ${COLOUR}$|^${COLOUR} ${LIGHT}$`)))) {
    const colour = lm[2] ?? lm[4] ?? lm[5]
    lightsAt = Date.now()
    return say(await lights('colour', colour, named(lm[1] ?? lm[3] ?? lm[6])))
  }

  // "Call George", "call mum on my phone": from the user's Contacts. Asked on
  // the iPhone, the phone itself dials (it asks for one tap); asked here, the
  // Mac calls through the iPhone.
  const callWho = t.match(/^(?:call|phone|ring|dial)(?: up)? (?!me\b)(.+?)(?: (?:on|from|with|using) my (?:phone|iphone|mobile|cell))?$/)
  if (callWho) {
    if (from === 'phone') {
      const who = await whoToCall(callWho[1])
      return say(who.say, who.tel ? { call: `tel:${who.tel}` } : {})
    }
    return say(await callFromMac(callWho[1]))
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
  if (/^(?:close|quit|shut) (?:down )?(?:all|everything|all (?:of )?(?:the |my )?(?:open )?(?:apps|applications|windows|programs))(?: (?:on|in) (?:my |the |this )?(?:mac|macbook|laptop))?$/.test(t)) {
    return say(short(await closeAll()))
  }
  // "Open my Mac", "wake up my MacBook": its screen on (from the phone, say).
  if (/^(?:open|wake(?: up)?|turn on|switch on) (?:my |the )?(?:mac|macbook|laptop)(?: screen)?$/.test(t)) {
    execFile('/usr/bin/caffeinate', ['-u', '-t', '5'], () => {})
    return say('Your Mac is awake.')
  }

  // "Shut down my Mac", "close my MacBook" (from the phone, say).
  const MAC = '(?:my |the |this )?(?:mac|macbook|laptop)'
  if (new RegExp(`^(?:shut down|shutdown|turn off|switch off|power off|close) ${MAC}$|^(?:turn|switch|power|shut) ${MAC} (?:off|down)$`).test(t)) {
    return say(await shutdownMac())
  }
  if (new RegExp(`^(?:cancel|stop|abort) (?:the )?(?:shutdown|shut down) (?:of|on) ${MAC}$|^(?:don'?t|do not) (?:shut down|turn off|close) ${MAC}$|^keep ${MAC} on$`).test(t)) {
    return say(cancelShutdownMac())
  }
  // "Cancel the shutdown" with the Mac counting down: the Mac's.
  if (macCountingDown() && /^(?:cancel|stop|abort) (?:the )?(?:shutdown|shut down)$|^cancel(?: it)?$/.test(t)) {
    return say(cancelShutdownMac())
  }

  // The other computer: "turn on my PC", "shut down my computer".
  const PC = '(?:my |the )?(?:other )?(?:pc|computer|windows(?: pc| computer)?|desktop)'
  // "Open my PC": on and all the way to its desktop, ready for "open Valorant".
  if (new RegExp(`^(?:open|open up|get) ${PC}(?: ready)?$`).test(t)) return say(await openPc(askPassword))
  if (new RegExp(`^(?:turn on|switch on|start(?: up)?|wake(?: up)?|boot(?: up)?|power on) ${PC}$|^(?:turn|switch|power) ${PC} on$`).test(t)) {
    return say(await wakePc())
  }
  if (new RegExp(`^(?:shut down|shutdown|turn off|switch off|power off) ${PC}$|^(?:turn|switch|power|shut) ${PC} (?:off|down)$`).test(t)) {
    return say(await shutdownPc())
  }
  // "Close all the apps on my PC", "close Valorant on my computer".
  if (new RegExp(`^(?:close|quit|shut) (?:down )?(?:all|everything|all (?:of )?(?:the |my )?(?:open )?(?:apps|applications|windows|programs|games)) (?:on|in|at) ${PC}$`).test(t)) {
    return say(await closeOnPc('*'))
  }
  const offPc = t.match(new RegExp(`^(?:close|quit|exit|stop) (?:the )?(.+?) (?:on|in|at) ${PC}$`))
  if (offPc) return say(await closeOnPc(offPc[1]))
  // "Open Valorant on my PC", "launch Discord on the computer".
  const onPc = t.match(new RegExp(`^(?:open|launch|start|run|play|go to) (?:up )?(.+?) (?:on|in|at) ${PC}$`))
  if (onPc) return say(await openOnPc(onPc[1], askPassword))
  if (new RegExp(`^(?:cancel|stop|abort) (?:the )?(?:shutdown|shut down)(?: of ${PC})?$|^(?:don'?t|do not) (?:shut down|turn off) ${PC}$|^keep ${PC} on$`).test(t)) {
    return say(await cancelShutdownPc())
  }
  // "What apps are open?", "which apps do I have open", "what's running".
  if (/^(?:what|which) (?:apps|applications|programs)(?: do i have| are| have i got)? (?:open|running)(?: right now)?$|^what(?:'s| is) (?:open|running)(?: right now)?$|^(?:list|show) (?:my |the )?open (?:apps|applications)$/.test(t)) {
    return say(await openApps())
  }
  const open = t.match(/^(?:open|launch|start) (?:up )?(?:the )?([\p{L}\d .'-]{2,30}?)(?: app| application)?$/u)
  if (open && open[1].split(' ').length <= 3) {
    let out = await openNamed(open[1])
    // Misheard ("open Spotfy"): the closest app this Mac has, if one clearly is.
    if (!/ is (?:already )?open/.test(out) && !siteFor(open[1])) {
      const near = closest(open[1], [...installedApps().keys()])
      if (near) out = await openNamed(near)
    }
    if (/ is already open/.test(out)) return say(out)
    if (!/ is open/.test(out)) {
      // A website ("open YouTube"): in this Mac's browser.
      const site = siteFor(open[1])
      if (site) {
        execFile('/usr/bin/open', [site], () => {})
        return say(`Opening ${open[1]}.`)
      }
      // Not on this Mac but the PC is on ("open Brave"): there, if it has it.
      if (await pcIsOn()) {
        const there = await openOnPc(open[1])
        if (!/couldn't|isn't set up|Nobody/.test(there)) return say(there)
      }
      return { handled: false }
    }
    return say(`${out.split(' is open')[0]}.`)
  }
  const close = t.match(/^(?:close|quit) (?:the )?([\p{L}\d .'-]{2,30}?)(?: app| application)?$/u)
  if (close && close[1].split(' ').length <= 3) {
    const out = await closeNamed(close[1])
    // Not a running app ("close the door", "close the tab"): Yonna decides.
    if (/is already closed/.test(out)) return say(out)
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
