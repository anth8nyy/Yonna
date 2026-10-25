import { execFile } from 'node:child_process'
import { agenda } from './calendar.mjs'
import { forecast, homePlace } from './weather.mjs'
import { playFrom, playOnSpotify, setShuffle } from './spotify.mjs'

/**
 * More instant answers — the everyday questions a model is slow for and a
 * calculator, a table or one quick lookup is not. Called by instant.mjs; each
 * returns a spoken line, or null to let Yonna think about it instead.
 *
 *   maths        "what's 15% of 80", "12 times 7", "square root of 144"
 *   units        "5 miles in km", "how many cm in an inch", "100 F to C"
 *   currency     "50 dollars in euros" (Frankfurter, the ECB's daily rates)
 *   countdowns   "how many days until Christmas", "days until 25 December"
 *   calendar     "what's on today", "what do I have today"
 *   music        "pause", "next song", "what's playing" (Spotify)
 *   battery      "how much battery do I have"
 *   words        "what does serendipity mean", "define ephemeral"
 *   sun          "when is sunset", "what time is sunrise"
 *   chance       "flip a coin", "roll a die", "random number between 1 and 10"
 */

const get = async (url, ms = 3000) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'Yonna/1.0' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}
const sh = (file, args) =>
  new Promise((resolve) => execFile(file, args, (err, out) => resolve(err ? null : String(out).trim())))
const osa = (script) => sh('/usr/bin/osascript', ['-e', script])

const WORDNUM = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, a: 1, an: 1, half: 0.5,
}
const toNum = (w) => {
  const s = String(w).replace(/,/g, '')
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : WORDNUM[s]
}

/** Spoken numbers: 3.0 → "3", 3.14159 → "3.14", 1234567 → "1,234,567". */
const say = (n) => {
  if (!Number.isFinite(n)) return null
  const r = Math.abs(n) >= 100 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100
  return r.toLocaleString('en-GB', { maximumFractionDigits: 2 })
}

/* -------------------------------------------------------------------- maths */

function maths(t) {
  let m
  if ((m = t.match(/^(?:what(?:'s| is) )?(\d[\d,.]*)\s*(?:%|percent) of (\d[\d,.]*)$/))) {
    return `${say((toNum(m[1]) * toNum(m[2])) / 100)}.`
  }
  if ((m = t.match(/^(?:what(?:'s| is) )?(?:the )?square root of (\d[\d,.]*)$/))) return `${say(Math.sqrt(toNum(m[1])))}.`
  if ((m = t.match(/^(?:what(?:'s| is) )?(\d[\d,.]*) (?:squared)$/))) return `${say(toNum(m[1]) ** 2)}.`
  if ((m = t.match(/^(?:what(?:'s| is) )?(\d[\d,.]*) cubed$/))) return `${say(toNum(m[1]) ** 3)}.`

  const e = t
    .replace(/^(?:what(?:'s| is)|calculate|how much is|work out)\s+/, '')
    .replace(/\bmultiplied by\b|\btimes\b|\bx\b|×/g, '*')
    .replace(/\bdivided by\b|\bover\b|÷/g, '/')
    .replace(/\bplus\b/g, '+')
    .replace(/\bminus\b/g, '-')
    .replace(/\bto the power of\b|\^/g, '**')
    .replace(/(\d),(\d{3})/g, '$1$2')
  // Only digits and arithmetic, and at least one operator: nothing else can run.
  if (!/^[\d\s.+\-*/()]+$/.test(e) || !/\d\s*(?:\*\*|[+\-*/])\s*[\d(]/.test(e)) return null
  try {
    const v = Function(`"use strict"; return (${e})`)()
    return typeof v === 'number' && Number.isFinite(v) ? `${say(v)}.` : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------- units */

// Each unit: [dimension, factor to the base unit]. Temperature is handled apart.
const UNITS = {
  mm: ['len', 0.001], millimetre: ['len', 0.001], millimeter: ['len', 0.001],
  cm: ['len', 0.01], centimetre: ['len', 0.01], centimeter: ['len', 0.01],
  m: ['len', 1], metre: ['len', 1], meter: ['len', 1],
  km: ['len', 1000], kilometre: ['len', 1000], kilometer: ['len', 1000],
  inch: ['len', 0.0254], in: ['len', 0.0254], foot: ['len', 0.3048], feet: ['len', 0.3048], ft: ['len', 0.3048],
  yard: ['len', 0.9144], mile: ['len', 1609.344],
  mg: ['mass', 0.001], milligram: ['mass', 0.001], g: ['mass', 1], gram: ['mass', 1],
  kg: ['mass', 1000], kilo: ['mass', 1000], kilogram: ['mass', 1000],
  ounce: ['mass', 28.3495], oz: ['mass', 28.3495], pound: ['mass', 453.592], lb: ['mass', 453.592],
  stone: ['mass', 6350.29], ton: ['mass', 1e6], tonne: ['mass', 1e6],
  ml: ['vol', 0.001], millilitre: ['vol', 0.001], milliliter: ['vol', 0.001],
  l: ['vol', 1], litre: ['vol', 1], liter: ['vol', 1],
  cup: ['vol', 0.24], pint: ['vol', 0.473176], gallon: ['vol', 3.78541],
  teaspoon: ['vol', 0.00492892], tablespoon: ['vol', 0.0147868],
  'km/h': ['speed', 1], kph: ['speed', 1], mph: ['speed', 1.609344], 'm/s': ['speed', 3.6], knot: ['speed', 1.852],
}
const TEMP = { c: 'c', celsius: 'c', centigrade: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' }
const unitOf = (w) => {
  const s = w.replace(/^degrees? /, '').replace(/\.$/, '')
  if (TEMP[s]) return { temp: TEMP[s] }
  const single = s.replace(/(?<=..)(es|s)$/, '')
  const u = UNITS[s] ?? UNITS[single] ?? UNITS[s.replace(/s$/, '')]
  return u ? { dim: u[0], f: u[1], name: s } : null
}
const plural = (n, name) => (Math.abs(n) === 1 || name.length <= 3 || /\//.test(name) ? name : name.replace(/(?<!s)$/, 's'))

function units(t) {
  let m =
    t.match(/^(?:convert |what(?:'s| is) |how much is )?(-?[\d.,]+|a|an|one|half) ([a-z/ ]+?) (?:to|in|into|in to) ([a-z/ ]+?)$/) ??
    null
  let amount
  let from
  let to
  if (m) [, amount, from, to] = m
  else if ((m = t.match(/^how many ([a-z/ ]+?) (?:are )?(?:in|per) (?:a |an |one )?(-?[\d.,]+ )?([a-z/ ]+?)$/))) {
    to = m[1]
    amount = (m[2] ?? '1').trim()
    from = m[3]
  } else return null
  const n = toNum(amount)
  const a = unitOf(from)
  const b = unitOf(to)
  if (n == null || !a || !b) return null
  if (a.temp || b.temp) {
    if (!a.temp || !b.temp) return null
    const c = a.temp === 'c' ? n : a.temp === 'f' ? ((n - 32) * 5) / 9 : n - 273.15
    const out = b.temp === 'c' ? c : b.temp === 'f' ? (c * 9) / 5 + 32 : c + 273.15
    const names = { c: 'Celsius', f: 'Fahrenheit', k: 'kelvin' }
    return `${say(n)} degrees ${names[a.temp]} is ${say(out)} ${names[b.temp]}.`
  }
  if (a.dim !== b.dim) return null
  const out = (n * a.f) / b.f
  return `${say(n)} ${plural(n, a.name)} is ${say(out)} ${plural(out, b.name)}.`
}

/* ----------------------------------------------------------------- currency */

const CUR = {
  dollar: 'USD', dollars: 'USD', usd: 'USD', buck: 'USD', bucks: 'USD',
  euro: 'EUR', euros: 'EUR', eur: 'EUR',
  pound: 'GBP', pounds: 'GBP', quid: 'GBP', gbp: 'GBP', sterling: 'GBP',
  yen: 'JPY', jpy: 'JPY', franc: 'CHF', francs: 'CHF', chf: 'CHF',
  lira: 'TRY', yuan: 'CNY', renminbi: 'CNY', rupee: 'INR', rupees: 'INR',
  'canadian dollar': 'CAD', 'canadian dollars': 'CAD', 'australian dollar': 'AUD', 'australian dollars': 'AUD',
  krona: 'SEK', kronor: 'SEK', krone: 'NOK', zloty: 'PLN', forint: 'HUF', won: 'KRW', peso: 'MXN', pesos: 'MXN',
}
const CUR_NAME = { USD: 'dollars', EUR: 'euros', GBP: 'pounds', JPY: 'yen', CHF: 'Swiss francs', TRY: 'lira', CNY: 'yuan', INR: 'rupees', CAD: 'Canadian dollars', AUD: 'Australian dollars', SEK: 'kronor', NOK: 'kroner', PLN: 'zloty', HUF: 'forint', KRW: 'won', MXN: 'pesos' }

async function currency(t) {
  const m =
    t.match(/^(?:convert |how much is |what(?:'s| is) )?([\d.,]+|a|an|one) ([a-z ]+?) (?:to|in|into) ([a-z ]+?)$/) ??
    t.match(/^how many ([a-z ]+?) (?:is|are|for|in) ([\d.,]+|a|an|one) ([a-z ]+?)$/)?.slice(0, 4)
  if (!m) return null
  let [, amount, from, to] = m
  if (/^how many/.test(t)) [to, amount, from] = [m[1], m[2], m[3]]
  const a = CUR[from.trim()]
  const b = CUR[to.trim()]
  const n = toNum(amount)
  if (!a || !b || n == null || a === b) return null
  const j = await get(`https://api.frankfurter.dev/v1/latest?amount=${n}&from=${a}&to=${b}`).catch(() => null)
  const v = j?.rates?.[b]
  if (v == null) return null
  return `${say(n)} ${CUR_NAME[a]} is about ${say(v)} ${CUR_NAME[b]}.`
}

/* --------------------------------------------------------------- countdowns */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const EVENTS = {
  christmas: [11, 25], 'christmas day': [11, 25], 'christmas eve': [11, 24], 'new year': [0, 1], "new year's": [0, 1],
  "new year's day": [0, 1], "new year's eve": [11, 31], halloween: [9, 31], "valentine's day": [1, 14], valentines: [1, 14],
}

function countdown(t) {
  const m =
    t.match(/^how (?:many|long) (?:days |weeks )?(?:is it |are there )?(?:left )?(?:until|till|til|to|before) (.+)$/) ??
    t.match(/^(?:days|how many days) (?:left )?(?:until|till|til|to) (.+)$/)
  if (!m) return null
  let target = m[1].replace(/^the /, '').trim()
  let md = EVENTS[target]
  if (!md) {
    const d =
      target.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)$/) ?? target.match(/^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/)?.reverse()
    if (!d) return null
    const day = Number(d[1])
    const mon = MONTHS.indexOf(d[2])
    if (mon < 0 || !day) return null
    md = [mon, day]
  }
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let when = new Date(now.getFullYear(), md[0], md[1])
  if (when < today) when = new Date(now.getFullYear() + 1, md[0], md[1])
  const days = Math.round((when - today) / 86400000)
  if (days === 0) return "It's today."
  if (days === 1) return "It's tomorrow."
  const weekday = when.toLocaleDateString('en-GB', { weekday: 'long' })
  return `${days} days — it's on a ${weekday}.`
}

/* ----------------------------------------------------------------- calendar */

async function today(t) {
  if (!/^(?:what(?:'s| is| do i have)(?: on)?(?: my (?:schedule|calendar|agenda))? (?:for )?today|what(?:'s| is) on(?: my (?:schedule|calendar))?(?: today)?|what do i have(?: on)? today|do i have anything today|my (?:schedule|agenda) today)$/.test(t))
    return null
  const a = await agenda().catch(() => null)
  if (!a?.ok) return null
  const now = Date.now()
  const at = (iso) => new Date(iso.length === 16 ? `${iso}:00` : iso)
  const left = (a.events ?? []).filter((e) => e.allDay || at(e.end).getTime() > now)
  if (!left.length) return a.events?.length ? "Nothing else today — you're done." : 'Nothing on today.'
  const time = (iso) => at(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '')
  const items = left.slice(0, 5).map((e) => (e.allDay ? e.title : `${e.title} at ${time(e.start)}`))
  const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]
  return `You've got ${list}.`
}

/* -------------------------------------------------------------------- music */

async function music(t) {
  const spotify = (cmd) => osa(`tell application "Spotify" to ${cmd}`)
  const running = (await osa('application "Spotify" is running')) === 'true'
  // A bare "stop" is how they interrupt her, so it never pauses the music:
  // only "pause", or "stop the music".
  if (/^pause(?: the)?(?: music| spotify| song| playing| it| this)?$|^stop (?:the )?(?:music|spotify|song|playing|playback)$|^stop playing(?: music)?$/.test(t)) {
    if (!running) return null
    await spotify('pause')
    return ''
  }
  if (/^(?:play|resume|continue|unpause)(?: the)?(?: music| spotify| playing)?$/.test(t)) {
    await spotify('play')
    return ''
  }
  if (/^(?:next|skip)(?: song| track| one| this(?: song| track| one)?| it)?$|^skip(?: to the next)?(?: song| track| one)?$|^play the next (?:song|track|one)$|^(?:go to the )?next (?:song|track)$/.test(t)) {
    if (!running) return null
    await spotify('next track')
    return ''
  }
  if (/^(?:previous|last|go back)(?: song| track)?$|^play the (?:previous|last) (?:song|track)$/.test(t)) {
    if (!running) return null
    // Past the first few seconds, Spotify's "previous" only restarts the song:
    // back to the start first, so it always goes to the song before.
    await spotify('set player position to 0')
    await spotify('previous track')
    return ''
  }
  // Shuffle on and off: "shuffle", "shuffle the songs", "play in order".
  if (/^(?:turn on |put on |enable )?shuffle(?: on| the songs| the music| them| it)?$|^(?:put it |play )on shuffle$|^mix (?:it|them|the songs) up$|^(?:don'?t|do not) play (?:them |the songs )?(?:in|by) order$/.test(t)) {
    return setShuffle(true)
  }
  if (/^(?:turn off|stop|disable) shuffl(?:e|ing)$|^shuffle off$|^(?:no shuffle|unshuffle)$|^play (?:it |them |the songs )?(?:in|by) order$/.test(t)) {
    return setShuffle(false)
  }
  // "play my gym playlist from the beginning", "start this playlist over",
  // "shuffle my chill playlist", "play Summer bangers on shuffle".
  const fromStart =
    t.match(/^(?:play|start|restart)(?: me)? (.*?) (?:from the (?:beginning|start|top|first song)|over|again from the (?:beginning|start)|in order)$/) ??
    t.match(/^(?:restart|start over)(?: the| this)?( playlist| album)?$/)
  if (fromStart) return playFrom(fromStart[1]?.trim() ?? '', { shuffle: false })
  const shuffled =
    t.match(/^shuffle(?: play)? (?!on$|off$|the songs$|the music$|them$|it$)(.+?)(?: on spotify)?$/) ??
    t.match(/^play (.+?) (?:on shuffle|shuffled|in shuffle|randomly|in random order)$/)
  if (shuffled) return playFrom(shuffled[1], { shuffle: true })

  // "play Blinding Lights", "play some Daft Punk on Spotify", "put on lofi".
  const ask = t.match(/^(?:play|put on|listen to)(?: me)? (.+?)(?: on spotify)?$/)
  if (ask && !/^(?:the )?(?:music|spotify|playing|it|something)$/.test(ask[1])) {
    return playOnSpotify(ask[1])
  }
  // "what's playing", "what's playing on my Spotify", "what song is this",
  // "what am I listening to", "who's singing".
  const where = "(?: (?:on|in) (?:my |the )?spotify)?(?: right(?: now)?| now)?"
  if (
    new RegExp(`^what(?:'s| is) (?:this|playing|this song|the song|the song playing|that song|on)${where}$`).test(t) ||
    new RegExp(`^what (?:song|track|music) is (?:this|that|playing|on)${where}$`).test(t) ||
    new RegExp(`^what am i listening to${where}$`).test(t) ||
    /^who(?:'s| is) (?:this|singing|this song by)$/.test(t)
  ) {
    if (!running) return 'Nothing is playing.'
    const v = await spotify('(name of current track) & " — " & (artist of current track)')
    return v ? `That's ${v.replace(' — ', ' by ')}.` : null
  }
  return null
}

/* ------------------------------------------------------------- the rest */

async function battery(t) {
  if (!/^(?:how much |what(?:'s| is) (?:my |the )?)?battery(?: level| percentage| life)?(?: (?:do i have|have i got|is left|left))?$|^how much battery (?:do i have|is left|have i got)(?: left)?$/.test(t))
    return null
  const out = await sh('/usr/bin/pmset', ['-g', 'batt'])
  const m = out?.match(/(\d+)%;\s*([a-z ]+);\s*(\d+:\d+)?/)
  if (!m) return null
  const [, pct, state, left] = m
  if (/charging|charged|finishing/.test(state) && !/discharging/.test(state)) return `${pct}%, and charging.`
  if (left && left !== '0:00') {
    const [h, mm] = left.split(':').map(Number)
    return `${pct}% — about ${h ? `${h} hour${h > 1 ? 's' : ''}` : ''}${h && mm ? ' and ' : ''}${mm ? `${mm} minutes` : ''} left.`
  }
  return `${pct}%.`
}

async function define(t) {
  const m = t.match(/^(?:what does ([a-z'-]+) mean|define ([a-z'-]+)|(?:what(?:'s| is) )?the meaning of ([a-z'-]+)|what is the definition of ([a-z'-]+))$/)
  if (!m) return null
  const word = m.slice(1).find(Boolean)
  const j = await get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, 2000).catch(() => null)
  let def = j?.[0]?.meanings?.[0]?.definitions?.[0]?.definition
  if (!def) {
    // Backup: Wiktionary, whose definitions come as small bits of HTML.
    const w = await get(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`, 2500).catch(() => null)
    const html = w?.en?.flatMap((e) => e.definitions ?? []).find((d) => d.definition?.trim())?.definition
    def = html?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  }
  if (!def) return null
  return `${word[0].toUpperCase()}${word.slice(1)}: ${def.replace(/\.$/, '')}.`
}

async function sun(t) {
  const m = t.match(/^(?:when(?:'s| is)|what time is) (?:the )?(sunset|sunrise)(?: today| tomorrow)?$|^when does the sun (set|rise)(?: today| tomorrow)?$/)
  if (!m) return null
  const which = (m[1] ?? m[2]).startsWith('set') || m[1] === 'sunset' ? 'sunset' : 'sunrise'
  const day = / tomorrow$/.test(t) ? 1 : 0
  const p = await homePlace()
  if (!p) return null
  const w = await forecast(p).catch(() => null)
  const iso = w?.days?.[day]?.[which]
  if (!iso) return null
  const time = new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `${which === 'sunset' ? 'Sunset' : 'Sunrise'} is at ${time}${day ? ' tomorrow' : ''}.`
}

export function chance(t) {
  if (/^(?:flip|toss) a coin$|^heads or tails$/.test(t)) return Math.random() < 0.5 ? 'Heads.' : 'Tails.'
  if (/^roll (?:a )?(?:die|dice)$/.test(t)) return `${1 + Math.floor(Math.random() * 6)}.`
  const m = t.match(/^(?:pick |give me |choose )?(?:a )?random number (?:between|from) (\d+) (?:and|to) (\d+)$/)
  if (m) {
    const lo = Math.min(+m[1], +m[2])
    const hi = Math.max(+m[1], +m[2])
    return `${lo + Math.floor(Math.random() * (hi - lo + 1))}.`
  }
  return null
}

/** Try each, cheapest first. A string (even '') is an answer; null is not. */
export async function quick(t) {
  for (const f of [maths, units, countdown]) {
    const r = f(t)
    if (r != null) return r
  }
  for (const f of [currency, today, music, battery, sun, define]) {
    const r = await f(t)
    if (r != null) return r
  }
  return null
}
