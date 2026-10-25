import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { playFrom, playOnSpotify, setShuffle, spotifyControl } from './spotify.mjs'

/**
 * Doing things on the Mac that the user asks for in so many words:
 *
 *   Spotify    play a song, artist, album or one of their playlists; shuffle;
 *              play, pause, next, previous
 *   Trash      clear files off the Desktop, Downloads… — moved to the Trash,
 *              never deleted, so anything can be put back
 *   Drafts     write an email (Gmail) or an iMessage and leave it open,
 *              unsent: the user reads it and presses Send themselves
 *
 * Nothing here sends anything or destroys anything.
 */

const ok = (text) => ({ content: [{ type: 'text', text }] })
const HOME = homedir()

const run = (cmd, args) =>
  new Promise((done) => execFile(cmd, args, (err, out) => done(err ? null : String(out).trim())))

/* ------------------------------------------------------------------- trash */

/** Where macOS saves screenshots: the Desktop unless changed in the
 *  Screenshot app's Options. */
function screenshotFolder() {
  try {
    const out = execFileSync('/usr/bin/defaults', ['read', 'com.apple.screencapture', 'location'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out) return normalize(out.startsWith('~') ? join(HOME, out.slice(1)) : out)
  } catch {
    /* not set */
  }
  return join(HOME, 'Desktop')
}

/** The only places files may be cleared from: the user's own folders, and
 *  wherever their screenshots go, as long as it is inside their home folder. */
const CLEARABLE = ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Movies', 'Music'].map((d) => join(HOME, d))
{
  const shots = screenshotFolder()
  if (shots.startsWith(HOME + '/') && !CLEARABLE.some((r) => shots === r || shots.startsWith(r + '/'))) CLEARABLE.push(shots)
}

/** Screenshot and screen-recording file names, English and Greek macOS. */
const SHOT = /^(screen ?shot|screen recording|στιγμιότυπο οθόνης|εγγραφή οθόνης)/i

function place(p) {
  const full = normalize(isAbsolute(p) ? p : p.startsWith('~') ? join(HOME, p.slice(1)) : resolve(HOME, 'Desktop', p))
  const inside = CLEARABLE.find((root) => full === root || full.startsWith(root + '/'))
  return { full, ok: Boolean(inside) && !CLEARABLE.includes(full) }
}

/** Spaces as macOS writes them in names (screenshots have a narrow no-break
 *  space before "PM") versus as a model types them back: the same. */
const loose = (n) => n.normalize('NFC').replace(/[\u00a0\u202f\u2007]/g, ' ').toLowerCase()

/** The file actually on disk for a path whose name may differ only in its
 *  spaces or capitals; null if there is none. */
function onDisk(full) {
  if (existsSync(full)) return full
  const dir = dirname(full)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const want = loose(basename(full))
  const hit = names.find((n) => loose(n) === want)
  return hit ? join(dir, hit) : null
}

/** A name that is free in the Trash ("shot.png" → "shot 2.png"). */
function freeInTrash(name) {
  const trash = join(HOME, '.Trash')
  let target = join(trash, name)
  for (let n = 2; existsSync(target); n++) {
    const ext = extname(name)
    target = join(trash, `${basename(name, ext)} ${n}${ext}`)
  }
  return target
}

function listFolder(folder, match) {
  const where = place(folder.endsWith('/') ? folder : folder + '/x').full.replace(/\/x$/, '')
  if (!CLEARABLE.some((r) => where === r || where.startsWith(r + '/'))) return null
  const re = match ? new RegExp(match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i') : null
  return readdirSync(where)
    .filter((n) => !n.startsWith('.') && (!re || re.test(n)))
    .map((n) => {
      const s = statSync(join(where, n))
      return { name: n, path: join(where, n), kind: s.isDirectory() ? 'folder' : 'file', modified: s.mtime.toISOString().slice(0, 16) }
    })
}

/* ----------------------------------------------------------------- meeting */

/** Opens the meeting window in the shortcut helper (meeting.swift), where the
 *  user picks Translate, Answer or Save. Nothing starts listening by itself. */
export async function openMeetingWindow() {
  await run('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("local.yonna.meeting.open", $(), $(), true); "ok"',
  ])
  return 'The meeting window is open.'
}

/* ------------------------------------------------------------------ drafts */

/** A contact's phone number or email, for a name said aloud. */
async function handleFor(who) {
  if (/^[+\d][\d\s()-]{5,}$/.test(who) || who.includes('@')) return who.replace(/[\s()-]/g, '')
  const q = who.replace(/"/g, '')
  const out = await run('/usr/bin/osascript', [
    '-e',
    `tell application "Contacts"
      set found to (every person whose name contains "${q}")
      if (count of found) is 0 then return ""
      set p to item 1 of found
      if (count of phones of p) > 0 then return value of item 1 of phones of p
      if (count of emails of p) > 0 then return value of item 1 of emails of p
      return ""
    end tell`,
  ])
  return out ? out.replace(/[\s()-]/g, '') : null
}

export function macServer() {
  return createSdkMcpServer({
    name: 'yonna_mac',
    version: '1.0.0',
    instructions:
      'Spotify playback, clearing files to the Trash, and writing email or iMessage drafts that the ' +
      'user sends themselves. Never sends; never deletes permanently.',
    alwaysLoad: true,
    tools: [
      tool(
        'spotify_play',
        'Play something on Spotify: a song, an artist, an album, or one of the user\'s own playlists ' +
          '("my gym playlist", "liked songs" — theirs is chosen over a public one with the same name). ' +
          'shuffle=true plays it shuffled; from_start=true plays a playlist or album in order from its ' +
          'first song. Says what is now playing.',
        {
          what: z.string().min(1).describe('What to play, as said: "Blinding Lights", "my chill playlist", "some Daft Punk".'),
          shuffle: z.boolean().optional(),
          from_start: z.boolean().optional(),
        },
        async ({ what, shuffle, from_start }) =>
          ok(
            (shuffle || from_start ? await playFrom(what, { shuffle: Boolean(shuffle) }) : await playOnSpotify(what)) ??
              'Nothing to play.',
          ),
      ),
      tool(
        'spotify_control',
        'Control what Spotify is playing now: play, pause, next, previous, shuffle_on, shuffle_off.',
        { action: z.enum(['play', 'pause', 'next', 'previous', 'shuffle_on', 'shuffle_off']) },
        async ({ action }) =>
          ok(action === 'shuffle_on' ? await setShuffle(true) : action === 'shuffle_off' ? await setShuffle(false) : await spotifyControl(action)),
      ),
      tool(
        'list_files',
        'List what is in one of the user\'s folders (Desktop by default; also Downloads, Documents, ' +
          'Pictures, Movies, Music, or a folder inside them), optionally only names matching a pattern ' +
          'like "Screenshot*". Use it before move_to_trash to find the exact files.',
        {
          folder: z.string().optional().describe('"~/Desktop" (default), "~/Downloads", …'),
          match: z.string().optional().describe('Name pattern; * and ? wildcards.'),
        },
        async ({ folder, match }) => {
          let list
          try {
            list = listFolder(folder ?? '~/Desktop', match)
          } catch (err) {
            return ok(
              err?.code === 'EPERM' || err?.code === 'EACCES'
                ? 'macOS is not letting me into that folder. They can allow it in System Settings → Privacy & Security → Files and Folders.'
                : 'That folder does not exist.',
            )
          }
          if (!list) return ok('That folder is not one I can look in.')
          if (!list.length) return ok('Nothing there.')
          return ok(JSON.stringify(list.slice(0, 200)))
        },
      ),
      tool(
        'find_screenshots',
        'List the screenshots and screen recordings the Mac has saved (wherever it saves them, and on the ' +
          'Desktop), newest first, with exact paths for move_to_trash. older_than_days keeps only older ones.',
        { older_than_days: z.number().optional() },
        async ({ older_than_days }) => {
          const seen = new Set()
          const found = []
          for (const dir of [screenshotFolder(), join(HOME, 'Desktop')]) {
            if (seen.has(dir)) continue
            seen.add(dir)
            let names = []
            try {
              names = readdirSync(dir)
            } catch {
              continue
            }
            for (const n of names) {
              if (!SHOT.test(n)) continue
              const s = statSync(join(dir, n))
              if (older_than_days && Date.now() - s.mtimeMs < older_than_days * 86_400_000) continue
              found.push({ name: n, path: join(dir, n), at: s.mtime.toISOString().slice(0, 16), ms: s.mtimeMs })
            }
          }
          found.sort((a, b) => b.ms - a.ms)
          if (!found.length) return ok('No screenshots found.')
          return ok(JSON.stringify(found.slice(0, 300).map(({ ms, ...f }) => f)))
        },
      ),
      tool(
        'move_to_trash',
        'Move files or folders the user asked to get rid of into the Trash — never deleted, they can be ' +
          'put back. Only inside Desktop, Downloads, Documents, Pictures, Movies, Music and the screenshot ' +
          'folder. Use exact paths from list_files or find_screenshots. If what they meant is unclear, or it ' +
          'is a lot of files they did not name, ask first.',
        { paths: z.array(z.string()).min(1).max(500) },
        async ({ paths }) => {
          const moved = []
          const refused = []
          for (const p of paths) {
            const { full: asked, ok: allowed } = place(p)
            const full = allowed ? onDisk(asked) : null
            if (!full) {
              refused.push(`${basename(asked)} (${allowed ? 'not found' : 'not a folder I may clear'})`)
              continue
            }
            try {
              renameSync(full, freeInTrash(basename(full)))
              moved.push(basename(full))
            } catch (err) {
              refused.push(`${basename(full)} (${err?.code ?? 'failed'})`)
            }
          }
          return ok(
            `Moved to the Trash: ${moved.length}${moved.length ? ` (${moved.slice(0, 8).join(', ')}${moved.length > 8 ? '…' : ''})` : ''}.` +
              (refused.length ? ` Not moved: ${refused.slice(0, 8).join(', ')}.` : ''),
          )
        },
      ),
      tool(
        'open_meeting_window',
        'Open the meeting window — when they say they are getting ready for, joining or about to start a ' +
          'meeting or call. In it they choose Translate (into Greek), Answer (suggested replies) or Save (a ' +
          'Word file); it all runs on this Mac only. Then just say it is open.',
        {},
        async () => ok(await openMeetingWindow()),
      ),
      tool(
        'draft_email',
        'Write an email and open it in Gmail, ready but NOT sent — the user reads it and presses Send. ' +
          'For a reply, put the sender in "to" and "Re: <their subject>" as the subject. Write it in the ' +
          'user\'s voice, short and natural, signed off as they would.',
        {
          to: z.string().optional().describe('Email address(es), comma-separated.'),
          subject: z.string().default(''),
          body: z.string().min(1),
          cc: z.string().optional(),
        },
        async ({ to, subject, body, cc }) => {
          const q = new URLSearchParams({ view: 'cm', fs: '1', su: subject, body })
          if (to) q.set('to', to)
          if (cc) q.set('cc', cc)
          await run('/usr/bin/open', [`https://mail.google.com/mail/?${q.toString().replace(/\+/g, '%20')}`])
          return ok('The draft is open in Gmail, not sent. Tell them it is ready to check and send.')
        },
      ),
      tool(
        'draft_imessage',
        'Write an iMessage and open it in Messages, ready but NOT sent — the user reads it and presses ' +
          'Return to send. "to" is a phone number, an email, or a contact\'s name.',
        { to: z.string().min(1), text: z.string().min(1) },
        async ({ to, text }) => {
          const handle = await handleFor(to)
          if (!handle) return ok(`I could not find ${to} in Contacts. Ask for their number.`)
          await run('/usr/bin/open', [`sms:${handle}&body=${encodeURIComponent(text)}`])
          return ok('The message is written in Messages, not sent. Tell them it is ready to check and send.')
        },
      ),
    ],
  })
}
