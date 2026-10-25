import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startTidy } from './tidy.mjs'

/**
 * Texting Yonna over iMessage.
 *
 * The user messages their own number from their phone; on this Mac that lands
 * in the Messages database, where "Yonna Messages.app" (a native helper — see
 * scripts/desktop-app/messages-helper) picks it up and appends it to an inbox
 * file. This module reads that inbox, asks Yonna exactly as the window does —
 * over the bridge's own WebSocket, so it is the same brain, tools and memory —
 * and drops the answer in the outbox for the helper to send back.
 *
 * One connection for all of it, kept open, so a conversation by text carries
 * on from message to message: "Shall I delete it?" … "yes" works.
 *
 * Configured by ~/Library/Application Support/Yonna/messages/config.json
 * ({"handles": ["+30…"]}); without that file this does nothing.
 */

const SUPPORT = join(homedir(), 'Library/Application Support/Yonna')
const HELPER = join(SUPPORT, 'Yonna Messages.app')
const DIR = join(SUPPORT, 'messages')
const INBOX = join(DIR, 'inbox.jsonl')
const OUTBOX = join(DIR, 'outbox')
const STATUS = join(DIR, 'status.json')

/** Strip panel markup down to its words, for a reply that cannot show it. */
const plain = (html) =>
  String(html ?? '')
    .replace(/<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()

function send(text) {
  mkdirSync(OUTBOX, { recursive: true })
  writeFileSync(join(OUTBOX, `${Date.now()}-${randomUUID().slice(0, 6)}.json`), JSON.stringify({ text }))
}

export function startIMessage(port) {
  if (!existsSync(join(DIR, 'config.json'))) return
  if (!existsSync(HELPER)) {
    console.log('[yonna] iMessage: helper app missing — rebuild the desktop app')
    return
  }
  mkdirSync(OUTBOX, { recursive: true })
  // The helper only ever appends to the inbox; it cannot create it. Without
  // this, every message was read correctly and then silently dropped.
  if (!existsSync(INBOX)) writeFileSync(INBOX, '')

  // Start the helper, and stop it again when the bridge goes.
  execFile('/usr/bin/pkill', ['-x', 'YonnaMessages'], () =>
    execFile('/usr/bin/open', ['-n', '-g', '-a', HELPER, '--args', DIR], () => {}),
  )
  const stop = () => execFile('/usr/bin/pkill', ['-x', 'YonnaMessages'], () => {})
  process.once('exit', stop)
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      stop()
      setTimeout(() => process.exit(0), 200)
    })
  }

  // Removing the duplicate copies a self-chat shows. See tidy.mjs.
  let handle = ''
  try {
    handle = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8')).handles?.[0] ?? ''
  } catch {
    /* no handle, no tidying */
  }
  const tidy = startTidy(handle)

  // Only messages that arrive from now on — never replay an old inbox.
  let offset = existsSync(INBOX) ? statSync(INBOX).size : 0
  let lastStatus = ''
  const queue = []
  let busy = false

  /* ---------------------------------------------------------- the brain */

  let ws = null
  let current = null // { text, panels, resolve }

  const connect = () =>
    new Promise((resolve) => {
      if (ws?.readyState === WebSocket.OPEN) return resolve(ws)
      const sock = new WebSocket(`ws://localhost:${port}/?client=imessage`, { headers: { Origin: 'http://localhost:5173' } })
      sock.on('open', () => {
        ws = sock
        resolve(sock)
      })
      sock.on('message', (raw) => {
        let d
        try {
          d = JSON.parse(raw)
        } catch {
          return
        }
        if (!current) return
        if (d.type === 'text') current.text += d.text ?? ''
        else if (d.type === 'panel' || d.type === 'blade') {
          const html = d.panel?.html ?? d.blade?.html
          if (html) current.panels.push(plain(html))
        } else if (d.type === 'done' || d.type === 'error') {
          const said = (d.type === 'done' ? d.text || current.text : d.message || 'Something went wrong.').trim()
          current.resolve({ said, panels: current.panels })
          current = null
        }
      })
      sock.on('close', () => {
        if (ws === sock) ws = null
        current?.resolve({ said: 'I lost my connection mid-answer, sir. Try again.', panels: [] })
        current = null
      })
      sock.on('error', () => resolve(null))
    })

  async function answer(text) {
    const sock = await connect()
    if (!sock) return 'My brain is not reachable at the moment, sir.'
    const reply = await new Promise((resolve) => {
      current = { text: '', panels: [], resolve }
      sock.send(JSON.stringify({ type: 'ask', text: `[iMessage] ${text}`, id: `imsg-${randomUUID()}` }))
      // A text conversation can wait, but not for ever.
      setTimeout(() => {
        if (current?.resolve === resolve) {
          current = null
          resolve({ said: 'That took too long, sir. Ask me again.', panels: [] })
        }
      }, 180_000)
    })
    // What was put on screen is part of the answer when the words alone are
    // thin — the headlines, the schedule — since there is no screen here.
    const extra = reply.panels.filter((p) => p && !reply.said.includes(p.slice(0, 40)))
    return [reply.said, ...extra].filter(Boolean).join('\n\n').slice(0, 3000)
  }

  async function drain() {
    if (busy) return
    busy = true
    while (queue.length) {
      const text = queue.shift()
      console.log('[yonna] iMessage in')
      tidy.noteUser(text)
      try {
        const reply = await answer(text)
        send(reply)
        tidy.noteYonna(reply)
        console.log('[yonna] iMessage reply queued')
      } catch (err) {
        console.error('[yonna] iMessage failed:', err?.message ?? err)
      }
    }
    busy = false
  }

  /* ------------------------------------------------------------- the inbox */

  setInterval(() => {
    try {
      const status = readFileSync(STATUS, 'utf8')
      const s = JSON.parse(status)
      const note = s.ok ? 'ok' : s.error
      if (note !== lastStatus) {
        lastStatus = note
        console.log(`[yonna] iMessage: ${s.ok ? 'watching for messages' : note}`)
      }
    } catch {
      /* helper not up yet */
    }

    if (!existsSync(INBOX)) return
    const size = statSync(INBOX).size
    if (size < offset) offset = 0 // the file was replaced
    if (size === offset) return
    const buf = Buffer.alloc(size - offset)
    const fd = openSync(INBOX, 'r')
    readSync(fd, buf, 0, buf.length, offset)
    closeSync(fd)
    const chunk = buf.toString('utf8')
    const end = chunk.lastIndexOf('\n')
    if (end === -1) return // a line still being written
    offset += Buffer.byteLength(chunk.slice(0, end + 1))
    for (const line of chunk.slice(0, end).split('\n')) {
      try {
        const m = JSON.parse(line)
        if (m.text) queue.push(m.text)
      } catch {
        /* a torn line — skip it */
      }
    }
    void drain()
  }, 1000)
}
