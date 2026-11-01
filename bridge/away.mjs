import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lights, lightsConfig } from './lights.mjs'
import { pcIdleMinutes, pcIsOn, shutdownPc } from './pc.mjs'

/**
 * Leaving the house: ten minutes after the iPhone says "away", the lights go
 * off, the PC shuts down if it's on, and this Mac goes to sleep.
 *
 * Where the phone is comes from the iPhone itself: two Shortcuts automations,
 * "When I leave Home" and "When I arrive Home", save the word "away" or "home"
 * to a file in iCloud Drive (Shortcuts' own folder, or iCloud Drive/Yonna).
 * That works on mobile data too, so Wi-Fi turned off or dropping out is never
 * mistaken for leaving. Coming back within the ten minutes cancels it; so
 * does someone using this Mac or the PC when the time comes (then somebody
 * is home).
 */

const FILES = [
  join(homedir(), 'Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Yonna.txt'),
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Yonna/Yonna.txt'),
]
const AFTER_MS = 10 * 60_000

/** The phone's latest word and when it was written, or null. */
function presence() {
  let best = null
  for (const f of FILES) {
    if (!existsSync(f)) continue
    try {
      const at = statSync(f).mtimeMs
      const word = readFileSync(f, 'utf8').toLowerCase()
      const state = /away|left|leave/.test(word) ? 'away' : /home|arriv/.test(word) ? 'home' : null
      if (state && (!best || at > best.at)) best = { state, at }
    } catch {}
  }
  return best
}

/** Seconds since anyone touched this Mac's keyboard, mouse or trackpad. */
function idleSeconds() {
  return new Promise((resolve) =>
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], (err, out) => {
      const m = String(out ?? '').match(/"HIDIdleTime" = (\d+)/)
      resolve(err || !m ? Infinity : Number(m[1]) / 1e9)
    }),
  )
}

let handled = 0 // the "away" already acted on (its time)

async function check() {
  const p = presence()
  if (!p || p.state !== 'away' || p.at === handled) return
  if (Date.now() - p.at < AFTER_MS) return
  handled = p.at
  if ((await idleSeconds()) < 5 * 60) {
    console.log('[yonna] away: the phone left, but someone is using this Mac — leaving everything on')
    return
  }
  const pcOn = await pcIsOn()
  const pcIdle = pcOn ? await pcIdleMinutes() : null
  if (pcIdle !== null && pcIdle < 5) {
    console.log('[yonna] away: the phone left, but someone is using the PC — leaving everything on')
    return
  }
  console.log('[yonna] away: gone ten minutes — lights off, PC off, Mac to sleep')
  if (lightsConfig().length) console.log(`[yonna] away: ${await lights('off').catch((e) => e.message)}`)
  if (pcOn) console.log(`[yonna] away: ${await shutdownPc().catch((e) => e.message)}`)
  // A moment for the PC's command to go before this Mac sleeps.
  setTimeout(() => execFile('/usr/bin/pmset', ['sleepnow'], () => {}), 20_000)
}

export function watchAway() {
  // An "away" from before this started (the Mac was asleep, say) is old news.
  handled = presence()?.state === 'away' ? presence().at : 0
  setInterval(() => void check(), 30_000)
}
