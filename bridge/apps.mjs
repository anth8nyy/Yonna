import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Opening the user's apps — "open Spotify", "launch Notes".
 *
 * Only ever launches an application bundle that is installed in one of the
 * standard Applications folders, chosen from that list by name. It cannot run
 * a command, open a file, pass arguments or reach anything outside those
 * folders, so asking for "Spotify" can only ever start Spotify. Launching an
 * app the user named changes nothing else, which is why it does not sit behind
 * ALLOW_WRITES.
 */

const ROOTS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  // Safari and a few others live here on recent macOS; /Applications has an alias.
  '/System/Volumes/Preboot/Cryptexes/App/System/Applications',
  join(homedir(), 'Applications'),
]

const ok = (text) => ({ content: [{ type: 'text', text }] })

/** Installed apps, name -> path. One level of subfolders too ("Microsoft Office/…"). */
function installedApps() {
  const apps = new Map()
  const add = (dir, entry) => {
    if (!entry.endsWith('.app')) return
    const name = basename(entry, '.app')
    if (!apps.has(name)) apps.set(name, join(dir, entry))
  }
  for (const root of ROOTS) {
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.endsWith('.app')) add(root, e.name)
      else if (e.isDirectory() && !e.name.startsWith('.')) {
        try {
          for (const sub of readdirSync(join(root, e.name))) add(join(root, e.name), sub)
        } catch {
          /* unreadable folder — skip it */
        }
      }
    }
  }
  return apps
}

const squash = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')

/** Best installed match for a spoken name: exact, then prefix, then contains. */
function findApp(spoken, apps) {
  const want = squash(
    spoken
      .replace(/\.app$/i, '')
      .replace(/^(the|my)\s+/i, '')
      .replace(/\s+(app|application)$/i, ''),
  )
  if (!want) return { matches: [] }
  // Background helpers are apps on disk but never what anyone means.
  const names = [...apps.keys()].filter((n) => !/(handler|helper|uninstall|agent|updater)\b/i.test(n))
  const words = (n) => n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const test of [
    (n) => squash(n) === want,
    (n) => squash(n).startsWith(want),
    // A whole word of the name ("word" → Microsoft Word, not Passwords), then
    // the start of one ("settings" → System Settings). Never the middle of a
    // word: "xcode" is not VEXcode.
    (n) => words(n).includes(want),
    (n) => words(n).some((w) => w.startsWith(want)),
    // Not the reverse (spoken name containing an app's name): "Photoshop"
    // contains "Photos", and opening Photos for it is worse than saying no.
  ]) {
    const hits = names.filter(test)
    if (hits.length) return { matches: hits.sort((a, b) => a.length - b.length) }
  }
  // Nothing by spelling — try by sound. The name came through speech
  // recognition, so "cloud" may well mean Claude and "calender" Calendar.
  const guess = soundsLike(want, names)
  return guess ? { matches: [guess.name], guessed: true } : { matches: [], near: nearest(want, names) }
}

/* ------------------------------------------------------- misheard names */

/** Edit distance: how many letters must change to turn a into b. */
function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]
}

/** Classic Soundex: words that sound alike in English share a code
 *  ("cloud" and "claude" are both C430). */
function soundex(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!w) return ''
  const code = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 }
  let out = w[0].toUpperCase()
  let last = code[w[0]] ?? 0
  for (const ch of w.slice(1)) {
    const c = code[ch] ?? 0
    if (c && c !== last) out += c
    if (ch !== 'h' && ch !== 'w') last = c
    if (out.length === 4) break
  }
  return out.padEnd(4, '0')
}

/** How alike a spoken name is to an app name, 0..~1.2. Compared against the
 *  whole name and each of its words, so "crome" still finds Google Chrome. */
function likeness(want, appName) {
  const parts = [squash(appName), ...appName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)]
  let best = 0
  for (const p of parts) {
    const ratio = 1 - levenshtein(want, p) / Math.max(want.length, p.length)
    const sound = want.length >= 3 && soundex(want) === soundex(p) ? 0.2 : 0
    best = Math.max(best, ratio + sound)
  }
  return best
}

/** Strong enough to act on without asking. Above 0.8 so one wrong letter in
 *  a short word that does not also sound alike ("teams"/"team") is not enough. */
const SURE = 0.85

/** The one app a misheard name almost certainly meant, or null if none is
 *  close enough or two are too close to call. */
function soundsLike(want, names) {
  const ranked = names
    .map((name) => ({ name, score: likeness(want, name) }))
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
  const [first, second] = ranked
  if (!first || first.score < SURE) return null
  // A near-tie is a real ambiguity — unless the runner-up is just a longer
  // name built on the same word, in which case the plain one is meant.
  if (second && first.score - second.score < 0.05) {
    const base = (n) => n.toLowerCase().split(/[^a-z0-9]+/)[0]
    if (base(first.name) !== base(second.name)) return null
  }
  return first
}

/** The closest few, for the model to choose from or offer. */
function nearest(want, names, n = 5) {
  return names
    .map((name) => ({ name, score: likeness(want, name) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.name)
}

/* ------------------------------------------------------------ closing apps */

/**
 * Apps never closed by "close all the apps": Finder, which is the desktop
 * itself and relaunches anyway. Yonna's own window is protected separately,
 * by process — it is an ordinary Chrome to macOS, and the user's real Chrome
 * must still close. Claude closes like anything else: the bridge runs on the
 * claude CLI, not the desktop app, so Yonna carries on without it.
 */
const NEVER_CLOSE = new Set(['com.apple.finder'])

/** Process ids belonging to Yonna's own window. */
function yonnaPids() {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-f', 'Yonna/chrome-profile'], (err, out) =>
      resolve(new Set(String(out ?? '').split(/\s+/).filter(Boolean).map(Number))),
    )
  })
}

/**
 * Running apps, and a polite quit for chosen ones.
 *
 * NSRunningApplication.terminate is the same request as ⌘Q: an app with
 * unsaved work still asks to save rather than losing it. It needs no
 * Automation permission, unlike AppleScript's `quit`, which would put a
 * consent prompt in front of every app the first time.
 */
const RUNNING_JXA = `
ObjC.import('AppKit');
function run(argv) {
  const quit = new Set(argv.map(Number));
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const out = [];
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    if (a.activationPolicy !== $.NSApplicationActivationPolicyRegular) continue;
    const pid = a.processIdentifier;
    if (quit.has(pid)) a.terminate;
    out.push({ pid, name: ObjC.unwrap(a.localizedName), id: ObjC.unwrap(a.bundleIdentifier) });
  }
  return JSON.stringify(out);
}`

function runningApps(quitPids = []) {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', RUNNING_JXA, ...quitPids.map(String)],
      (err, out) => {
        try {
          resolve(err ? [] : JSON.parse(String(out)))
        } catch {
          resolve([])
        }
      },
    )
  })
}

/** Ask the given apps to quit, then report which actually went. */
async function quitApps(targets) {
  if (!targets.length) return { closed: [], stayed: [] }
  await runningApps(targets.map((t) => t.pid))
  let still = targets
  for (let i = 0; i < 12 && still.length; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const alive = new Set((await runningApps()).map((a) => a.pid))
    still = targets.filter((t) => alive.has(t.pid))
  }
  const stayed = new Set(still.map((t) => t.pid))
  return {
    closed: targets.filter((t) => !stayed.has(t.pid)).map((t) => t.name),
    stayed: still.map((t) => t.name),
  }
}

/** What "close all the apps" would quit right now. Exported for testing. */
export { findApp, installedApps }

export async function closeAllTargets() {
  const mine = await yonnaPids()
  return (await runningApps()).filter((a) => !mine.has(a.pid) && !NEVER_CLOSE.has(a.id))
}

/** Quit Yonna's own window, as ⌘Q would. The launcher stops the servers. */
export async function quitYonna() {
  const mine = await yonnaPids()
  const own = (await runningApps()).filter((a) => mine.has(a.pid))
  if (own.length) await runningApps(own.map((a) => a.pid))
  return own.length > 0
}

function describe({ closed, stayed }) {
  const parts = []
  if (closed.length) parts.push(`Closed: ${closed.join(', ')}.`)
  if (stayed.length) {
    parts.push(
      `Still open, probably asking to save unsaved work: ${stayed.join(', ')}.`,
    )
  }
  return parts.join(' ') || 'Nothing to close.'
}

function launch(path) {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-a', path], (err) => resolve(err ? String(err.message ?? err) : null))
  })
}

export function appsServer() {
  return createSdkMcpServer({
    name: 'yonna_apps',
    version: '1.0.0',
    instructions:
      'Opens and closes applications on this Mac by name. Use it whenever the ' +
      'user asks to open, launch, start, close or quit an app, or to close all apps.',
    alwaysLoad: true,
    tools: [
      tool(
        'open_app',
        'Open an application installed on this Mac, by its name — "Spotify", ' +
          '"Notes", "Calculator", "System Settings". Use it whenever the user ' +
          'asks you to open, launch or start an app. Pass the name as heard: it ' +
          'came through speech recognition, so it may be misheard ("cloud" for ' +
          'Claude), and this tool matches by spelling and by sound. If it lists ' +
          'closest names instead, open the one that plainly sounds like what ' +
          'was said, or ask in one short question.',
        { name: z.string().min(1).describe('The application name, e.g. "Spotify".') },
        async ({ name }) => ok(await openNamed(name)),
      ),
      tool(
        'close_app',
        'Quit one running application by name, as ⌘Q would — it still asks ' +
          'to save unsaved work. Use when they ask to close a particular app. ' +
          'Never closes Yonna herself.',
        { name: z.string().min(1).describe('The application name, e.g. "Spotify".') },
        async ({ name }) => ok(await closeNamed(name)),
      ),
      tool(
        'close_all_apps',
        'Quit every open application except Yonna herself and Finder — ' +
          '"close all the apps", "close everything". Each app quits ' +
          'as with ⌘Q, so unsaved work still prompts to save.',
        {},
        async () => ok(await closeAll()),
      ),
      tool(
        'list_apps',
        'List the applications installed on this Mac, optionally filtered by a ' +
          'word. Use it only when you are unsure what an app is called.',
        { filter: z.string().optional().describe('Only names containing this.') },
        async ({ filter }) => {
          const f = filter ? squash(filter) : ''
          const names = [...installedApps().keys()]
            .filter((n) => !f || squash(n).includes(f))
            .sort()
          return ok(names.length ? names.join(', ') : 'No matching applications.')
        },
      ),
    ],
  })
}

/* -------------------------------------------- also used by instant commands */

/** Open an installed app by its spoken name. Returns what happened, in words. */
export async function openNamed(name) {
  const apps = installedApps()
  const { matches, guessed, near } = findApp(name, apps)
  if (!matches.length) {
    return (
      `No application called "${name}" is installed on this Mac.` +
      (near?.length ? ` Closest names: ${near.join(', ')}.` : '')
    )
  }
  if (guessed) {
    const err = await launch(apps.get(matches[0]))
    return err
      ? `${matches[0]} could not be opened: ${err}`
      : `${matches[0]} is open ("${name}" was taken to mean ${matches[0]}).`
  }
  // A clear winner opens; a genuine tie is handed back to choose from.
  const exact = matches.find((m) => squash(m) === squash(name))
  const pick = exact ?? (matches.length === 1 || matches[0].length < matches[1].length ? matches[0] : null)
  if (!pick) return `Several applications match "${name}": ${matches.slice(0, 6).join(', ')}.`
  const err = await launch(apps.get(pick))
  return err ? `${pick} could not be opened: ${err}` : `${pick} is open.`
}

/** Quit one running app by its spoken name. */
export async function closeNamed(name) {
  const mine = await yonnaPids()
  const open = (await runningApps()).filter((a) => !mine.has(a.pid))
  const want = squash(name.replace(/\.app$/i, ''))
  const guess = soundsLike(want, open.map((a) => a.name))
  const hit =
    open.find((a) => squash(a.name) === want) ??
    open.find((a) => squash(a.name).startsWith(want)) ??
    open.find((a) => squash(a.name).includes(want)) ??
    (guess ? open.find((a) => a.name === guess.name) : undefined)
  if (!hit) return `${name} is not running.`
  if (NEVER_CLOSE.has(hit.id)) return `${hit.name} is left open; it is not closed from here.`
  return describe(await quitApps([hit]))
}

/** Quit everything but Yonna and Finder. */
export async function closeAll() {
  const targets = await closeAllTargets()
  if (!targets.length) return 'No other applications are open.'
  return describe(await quitApps(targets))
}
