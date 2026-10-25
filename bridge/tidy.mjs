import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Removing the duplicate copies in the user's "message to yourself" thread.
 *
 * Texting your own number shows every message twice — a sent copy (right,
 * blue) and a received copy (left, grey) — and deleting a copy on the Mac
 * deletes it on the iPhone as well. So after each exchange this deletes the
 * user's received echo and Yonna's own sent copy, which leaves the user in
 * blue and Yonna in grey, once each.
 *
 * The pressing is done by "Yonna Messages Cleaner.app" (Accessibility,
 * Messages only); the deciding happens here, so it can change without
 * rebuilding that app. It is deliberately narrow: it only ever deletes a copy
 * of a text that this bridge itself just received or sent, and only when both
 * copies are on screen — so nothing else in Messages can be touched, and a
 * message is never left with no copy at all.
 */

const SUPPORT = join(homedir(), 'Library/Application Support/Yonna')
const HELPER = join(SUPPORT, 'Yonna Messages Cleaner.app')
const DIR = join(SUPPORT, 'cleaner')
const MARK = '⁣'
/** Only exchanges this recent are tidied. */
const REMEMBER_MS = 10 * 60_000

const norm = (s) =>
  String(s ?? '')
    .replaceAll(MARK, '')
    .replace(/￼/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/** A bubble's description is "Me, <text>, 11:39 PM" or "Your iMessage, <text>[, time]". */
const descText = (d) =>
  String(d ?? '')
    .replace(/^(me|your imessage),\s*/i, '')
    .replace(/,\s*\d{1,2}:\d{2}\s*(am|pm)?\s*$/i, '')

async function command(c, timeout = 15_000) {
  const id = `${Date.now()}-${randomUUID().slice(0, 6)}`
  writeFileSync(join(DIR, 'cmd', `${id}.json`), JSON.stringify(c))
  const res = join(DIR, 'res', `${id}.json`)
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (existsSync(res)) {
      try {
        const r = JSON.parse(readFileSync(res, 'utf8'))
        rmSync(res, { force: true })
        return r
      } catch {
        /* still being written */
      }
    }
    await new Promise((r) => setTimeout(r, 80))
  }
  return { ok: false, error: 'timeout' }
}

export function startTidy(handle) {
  const noop = { noteUser() {}, noteYonna() {} }
  if (!handle || !existsSync(HELPER)) return noop
  mkdirSync(join(DIR, 'cmd'), { recursive: true })
  mkdirSync(join(DIR, 'res'), { recursive: true })

  execFile('/usr/bin/pkill', ['-x', 'YonnaCleaner'], () =>
    execFile('/usr/bin/open', ['-n', '-g', '-a', HELPER, '--args', DIR], () => {}),
  )
  const stop = () => execFile('/usr/bin/pkill', ['-x', 'YonnaCleaner'], () => {})
  process.once('exit', stop)

  /** Texts from recent exchanges: normalised text → who wrote it. */
  const recent = new Map()
  const remember = (text, who) => {
    const key = norm(text)
    if (key) recent.set(key, { who, at: Date.now() })
  }

  /** The bubbles on screen, with which side they are on and their text. */
  function bubbles(nodes) {
    const byPath = new Map(nodes.map((n) => [n.path.join('.'), n]))
    return nodes
      .filter((n) => n.id === 'Sticker' && /^(me|your imessage),/i.test(n.desc) && (n.actions ?? []).some((a) => a.label === 'Delete…'))
      .map((n) => {
        const child = byPath.get([...n.path, 0].join('.'))
        const text = child?.id === 'CKBalloonTextView' && child.value ? child.value : descText(n.desc)
        // Messages labels every bubble itself: "Your iMessage, …" is the sent
        // (right, blue) copy and "Me, …" the received (left, grey) one. Read
        // that rather than the position, which shifts with the window layout.
        return {
          node: n,
          key: norm(text),
          right: /^your imessage,/i.test(n.desc),
        }
      })
  }

  /** One deletion: press Delete… on the bubble, then confirm the sheet. */
  async function remove(node) {
    const del = node.actions.find((a) => a.label === 'Delete…')
    const r = await command({ op: 'act', path: node.path, action: del.name })
    if (!r.ok) return false
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 200))
      const d = await command({ op: 'dump', maxDepth: 4 })
      const sheet = d.nodes?.find((n) => n.role === 'AXSheet')
      const btn = sheet && d.nodes.find((n) => n.role === 'AXButton' && n.title === 'Delete' && n.path.join('.').startsWith(sheet.path.join('.')))
      if (btn) return (await command({ op: 'act', path: btn.path, action: 'AXPress' })).ok
    }
    return false
  }

  let running = false
  async function pass() {
    if (running) return
    running = true
    try {
      const now = Date.now()
      for (const [k, v] of recent) if (now - v.at > REMEMBER_MS) recent.delete(k)
      if (!recent.size) return
      // Show the thread, without bringing Messages to the front.
      await new Promise((r) => execFile('/usr/bin/open', ['-g', `imessage://${handle}`], () => r()))
      await new Promise((r) => setTimeout(r, 700))
      for (let round = 0; round < 12; round++) {
        const d = await command({ op: 'dump' })
        if (!d.ok) return
        const list = bubbles(d.nodes).slice(-30)
        let target = null
        for (const [key, { who }] of recent) {
          const copies = list.filter((b) => b.key === key)
          const left = copies.filter((b) => !b.right)
          const right = copies.filter((b) => b.right)
          if (!left.length || !right.length) continue
          // The user's own text: keep the blue copy, drop the grey echo.
          // Yonna's reply: keep the grey copy, drop his blue one.
          target = (who === 'user' ? left : right).at(-1).node
          break
        }
        if (!target) return
        if (!(await remove(target))) return
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch (err) {
      console.error('[yonna] tidy failed:', err?.message ?? err)
    } finally {
      running = false
    }
  }

  // Copies land a few seconds apart; look twice.
  const soon = () => {
    setTimeout(() => void pass(), 4000)
    setTimeout(() => void pass(), 12_000)
  }

  return {
    noteUser(text) {
      remember(text, 'user')
      soon()
    },
    noteYonna(text) {
      remember(text, 'yonna')
      soon()
    },
  }
}
