import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Weather, straight from a weather service.
 *
 * Asked for the weather, Yonna used to search the web, read the results and
 * summarise them — several seconds for one number. This asks Open-Meteo (free,
 * no key) directly: about a quarter of a second. Simple questions ("what's the
 * weather", "will it rain tomorrow in London") are answered with no AI at all
 * — see instant.mjs — and the `weather` tool gives the AI the same data when a
 * question needs more thought.
 *
 * "Here" is found once from the internet connection's rough location (city
 * level) and saved, or set by saying "I live in …".
 */

const HOME_FILE = join(homedir(), 'Library/Application Support/Yonna/home.json')
const DAY_MS = 24 * 3600 * 1000

const get = async (url, ms = 4000) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'Yonna/1.0' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/* ------------------------------------------------------------------- places */

/** A place by name: { name, lat, lon, timeZone }, or null. */
export async function findPlace(name) {
  const q = String(name ?? '').trim()
  if (!q) return null
  const j = await get(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`,
  ).catch(() => null)
  const p = j?.results?.[0]
  return p ? { name: p.name, lat: p.latitude, lon: p.longitude, timeZone: p.timezone } : null
}

let home = null

/** Where the user is: saved, or looked up once from the connection. */
export async function homePlace() {
  if (home && (home.fixed || Date.now() - home.at < DAY_MS)) return home
  try {
    const saved = JSON.parse(await readFile(HOME_FILE, 'utf8'))
    if (saved?.lat != null && (saved.fixed || Date.now() - saved.at < DAY_MS)) return (home = saved)
  } catch {
    /* not saved yet */
  }
  const fromIp = async () => {
    const a = await get('https://ipwho.is/?fields=success,city,latitude,longitude,timezone', 3000).catch(() => null)
    if (a?.success) return { name: a.city, lat: a.latitude, lon: a.longitude, timeZone: a.timezone?.id }
    const b = await get('https://get.geojs.io/v1/ip/geo.json', 3000).catch(() => null)
    if (b?.latitude) return { name: b.city, lat: Number(b.latitude), lon: Number(b.longitude), timeZone: b.timezone }
    return null
  }
  const p = await fromIp()
  if (!p) return home
  home = { ...p, at: Date.now(), fixed: false }
  await save(home)
  return home
}

/** "I live in Athens": remembered for good, until changed. */
export async function setHome(name) {
  const p = await findPlace(name)
  if (!p) return null
  home = { ...p, at: Date.now(), fixed: true }
  await save(home)
  return home
}

async function save(h) {
  await mkdir(dirname(HOME_FILE), { recursive: true }).catch(() => {})
  await writeFile(HOME_FILE, JSON.stringify(h)).catch(() => {})
}

/* ------------------------------------------------------------------ weather */

const SKY = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy',
  51: 'drizzly', 53: 'drizzly', 55: 'drizzly', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rainy', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snowy', 75: 'heavy snow', 77: 'snow grains',
  80: 'showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
}
const sky = (code) => SKY[code] ?? 'mixed'

const cache = new Map()

/** Now and the next few days at a place. Cached for ten minutes. */
export async function forecast(place) {
  const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data
  const j = await get(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
      '&timezone=auto&forecast_days=4',
  )
  const days = (j.daily?.time ?? []).map((date, i) => ({
    date,
    sky: sky(j.daily.weather_code[i]),
    high: Math.round(j.daily.temperature_2m_max[i]),
    low: Math.round(j.daily.temperature_2m_min[i]),
    rain: j.daily.precipitation_probability_max?.[i] ?? null,
    sunrise: j.daily.sunrise?.[i],
    sunset: j.daily.sunset?.[i],
  }))
  const data = {
    place: place.name,
    now: {
      temp: Math.round(j.current.temperature_2m),
      feels: Math.round(j.current.apparent_temperature),
      sky: sky(j.current.weather_code),
      wind: Math.round(j.current.wind_speed_10m),
    },
    days,
  }
  cache.set(key, { at: Date.now(), data })
  return data
}

/** One spoken line, casual, the way she talks now. `day` is 0 today, 1 tomorrow. */
export function spoken(w, day = 0) {
  const d = w.days[day]
  if (day === 0) {
    const rain = d?.rain >= 40 ? `, with ${d.rain}% chance of rain` : ''
    const feels = Math.abs(w.now.feels - w.now.temp) >= 3 ? ` but feels like ${w.now.feels}` : ''
    return `It's ${w.now.temp} degrees${feels} and ${w.now.sky} in ${w.place} — up to ${d.high} today${rain}.`
  }
  const when = day === 1 ? 'Tomorrow' : new Date(d.date).toLocaleDateString('en-GB', { weekday: 'long' })
  const rain = d.rain >= 40 ? `, ${d.rain}% chance of rain` : d.rain != null && d.rain < 15 ? ', no rain' : ''
  return `${when} in ${w.place}: ${d.sky}, ${d.high} degrees, down to ${d.low}${rain}.`
}

/* --------------------------------------------------------------- the AI tool */

export function weatherServer() {
  return createSdkMcpServer({
    name: 'yonna_weather',
    version: '1.0.0',
    instructions: 'Current weather and the forecast for the next three days, from a weather service.',
    alwaysLoad: true,
    tools: [
      tool(
        'weather',
        'The weather now and for the next three days, anywhere — straight from a ' +
          'weather service, in a fraction of a second. ALWAYS use this for any ' +
          'question about weather, temperature, rain, wind or what to wear; never ' +
          'search the web for it. Omit place for where the user is.',
        { place: z.string().optional().describe('A city or place name. Omit for the user\'s own location.') },
        async ({ place }) => {
          try {
            const p = place ? await findPlace(place) : await homePlace()
            if (!p) return { content: [{ type: 'text', text: `I couldn't find "${place ?? 'your location'}".` }] }
            const w = await forecast(p)
            return { content: [{ type: 'text', text: JSON.stringify(w) }] }
          } catch (err) {
            return { content: [{ type: 'text', text: `The weather service didn't answer: ${err?.message ?? err}` }] }
          }
        },
      ),
    ],
  })
}
