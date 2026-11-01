import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * Yonna on the iPhone, as a Home Screen web app — free, nothing to install
 * from an App Store, and it never expires. Served by this Mac over https on
 * the home Wi-Fi (iPhones allow the microphone only on secure pages; the
 * certificate comes from scripts/phone-cert.sh).
 *
 *   https://<mac>.local:8443/app?k=<key>   the app; add it to the Home Screen
 *   POST /phone        {text}             ask; {say} back
 *   POST /phone/audio  (a recording)      heard on this Mac, then asked
 *
 * Every request needs the phone key (~/Library/Application Support/Yonna/
 * phone-key): in the address for the page, as a header for the rest.
 */

const PORT = Number(process.env.YONNA_PHONE_PORT) || 8443
const SUPPORT = join(homedir(), 'Library/Application Support/Yonna')
const TLS = join(SUPPORT, 'phone-tls')
const here = dirname(fileURLToPath(import.meta.url))

/** Wrong keys from one address: after 5, it is shut out for 15 minutes — so
 *  nobody on the Wi-Fi can keep guessing. */
const misses = new Map()
const shutOut = (ip) => (misses.get(ip)?.until ?? 0) > Date.now()
function missed(ip) {
  const m = misses.get(ip) ?? { n: 0, until: 0 }
  m.n += 1
  if (m.n >= 5) {
    m.until = Date.now() + 15 * 60_000
    m.n = 0
    console.warn(`[yonna] phone app: ${ip} shut out for 15 minutes after wrong keys`)
  }
  misses.set(ip, m)
}

/**
 * The lock: the iPhone keeps a strong password in its Passwords and fills it
 * in with Face ID; this Mac keeps only a scrypt hash of it (phone-lock). Once
 * it matches, the page gets a session that lasts until it is closed (12 hours
 * at most) — every request needs it, as well as the phone key. To start over
 * (a new phone, a lost password), delete phone-lock. Off by default: turned
 * on with {"lock": true} in phone.json.
 */
const LOCK = join(SUPPORT, 'phone-lock')
/** The lock is off unless phone.json says {"lock": true}; then the phone link alone opens Yonna. */
function lockOn() {
  try {
    return JSON.parse(readFileSync(join(SUPPORT, 'phone.json'), 'utf8')).lock === true
  } catch {
    return false
  }
}
const sessions = new Map() // session → expires
const SESSION_MS = 12 * 3600_000
const hashOf = (password, salt) => scryptSync(password, salt, 32).toString('hex')
function lockSet(password) {
  const salt = randomBytes(16).toString('hex')
  writeFileSync(LOCK, `${salt}:${hashOf(password, salt)}`, { mode: 0o600 })
}
function lockMatches(password) {
  try {
    const [salt, hash] = readFileSync(LOCK, 'utf8').trim().split(':')
    return same(hashOf(password, salt), hash)
  } catch {
    return false
  }
}
function newSession() {
  const s = randomBytes(32).toString('hex')
  sessions.set(s, Date.now() + SESSION_MS)
  return s
}
function inSession(s) {
  const until = sessions.get(String(s ?? ''))
  if (until && until > Date.now()) return true
  sessions.delete(String(s ?? ''))
  return false
}

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Her answer as speech, in the Mac's voice (as on the Mac), for the phone to
 *  play as audio — which an iPhone plays even on silent. Spoken by the shortcut
 *  helper, which has the voice loaded already (speak); else by `say`. */
async function voiceOf(text, speak) {
  const tag = randomBytes(4).toString('hex')
  const raw = join(tmpdir(), `yonna-voice-${tag}.aiff`)
  const file = join(tmpdir(), `yonna-voice-${tag}.m4a`)
  const run = (cmd, args) =>
    new Promise((ok, fail) => execFile(cmd, args, { timeout: 20000 }, (e) => (e ? fail(e) : ok())))
  try {
    if (speak && (await speak(text.slice(0, 1500), raw))) {
      await run('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', raw, file])
    } else {
      await run('/usr/bin/say', ['--file-format=m4af', '--data-format=aac', '-o', file, '--', text.slice(0, 1500)])
    }
    return `data:audio/mp4;base64,${(await readFile(file)).toString('base64')}`
  } catch {
    return null
  } finally {
    unlink(raw).catch(() => {})
    unlink(file).catch(() => {})
  }
}

/** Her answer as a WAV file's bytes (base64), for the PC helper, which plays
 *  WAV without anything extra installed. */
async function wavOf(text, speak) {
  const tag = randomBytes(4).toString('hex')
  const raw = join(tmpdir(), `yonna-voice-${tag}.aiff`)
  const file = join(tmpdir(), `yonna-voice-${tag}.wav`)
  const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { timeout: 20000 }, (e) => (e ? fail(e) : ok())))
  try {
    if (!(speak && (await speak(text.slice(0, 1500), raw)))) {
      await run('/usr/bin/say', ['-o', raw, '--', text.slice(0, 1500)])
    }
    await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', raw, file])
    return (await readFile(file)).toString('base64')
  } catch {
    return null
  } finally {
    unlink(raw).catch(() => {})
    unlink(file).catch(() => {})
  }
}

/** The app's icon, made once from Yonna.app's. */
function icon() {
  const out = join(SUPPORT, 'phone-icon.png')
  if (!existsSync(out)) {
    const icns = join(homedir(), 'Desktop/Yonna.app/Contents/Resources/AppIcon.icns')
    if (existsSync(icns)) execFile('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '180', icns, '--out', out], () => {})
  }
  return existsSync(out) ? readFileSync(out) : null
}

async function body(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('too big')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

/**
 * Starts the https server, if the certificate exists.
 * ask(text) → answer;  transcribe(path) → text or null;  speak(text, path) →
 * whether it made the sound file;  key() → the phone key;  signIn(password) →
 * the answer after signing in at the PC's sign-in screen.
 */
export function startPhone({ ask, transcribe, speak, key, signIn, pc }) {
  if (!existsSync(join(TLS, 'server.crt'))) {
    console.log('[yonna] phone app: no certificate yet — run scripts/phone-cert.sh')
    return
  }
  const page = () => readFileSync(join(here, 'phone.html'), 'utf8')
  const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self' data:; form-action 'self'"
  const lockPage = (k, error = '') =>
    readFileSync(join(here, 'phone-lock.html'), 'utf8')
      .replace(/__KEY__/g, encodeURIComponent(k))
      .replace(/__MODE__/g, existsSync(LOCK) ? 'unlock' : 'setup')
      .replace(/__ERROR__/g, error.replace(/\\/g, '').replace(/'/g, "\\'"))
  const server = createServer(
    { cert: readFileSync(join(TLS, 'server.crt')), key: readFileSync(join(TLS, 'server.key')) },
    async (req, res) => {
      const url = new URL(req.url ?? '/', 'https://x')
      // What the phone asked for (never the key), to see where setup gets stuck.
      if (req.method === 'GET' && url.pathname !== '/phone/ping') console.log(`[yonna] phone app: ${req.socket?.remoteAddress} GET ${url.pathname}`)
      const send = (code, type, data, extra = {}) => {
        res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra })
        res.end(data)
      }
      const ip = req.socket?.remoteAddress ?? ''
      if (shutOut(ip)) return send(429, 'text/plain', 'Too many tries.')
      try {
        // The page and its manifest: the key comes in the address.
        if (req.method === 'GET' && (url.pathname === '/app' || url.pathname === '/manifest.webmanifest')) {
          const k = url.searchParams.get('k')
          if (!same(k, key())) {
            missed(ip)
            return send(403, 'text/plain', 'This link is not valid.')
          }
          // The lock first, when it's on; the app itself only once it's open.
          if (url.pathname === '/app') {
            if (lockOn()) return send(200, 'text/html; charset=utf-8', lockPage(k), { 'content-security-policy': CSP })
            const app = page().replace(/__KEY__/g, encodeURIComponent(k)).replace(/__SESSION__/g, newSession())
            return send(200, 'text/html; charset=utf-8', app, { 'content-security-policy': CSP })
          }
          return send(
            200,
            'application/manifest+json',
            JSON.stringify({
              name: 'Yonna',
              short_name: 'Yonna',
              start_url: `/app?k=${encodeURIComponent(k)}`,
              display: 'standalone',
              background_color: '#0a0a0b',
              theme_color: '#0a0a0b',
              icons: [{ src: '/icon.png', sizes: '180x180', type: 'image/png' }],
            }),
          )
        }
        // The page checking the Mac is there (its connection light).
        if (req.method === 'GET' && url.pathname === '/phone/ping') {
          if (!same(req.headers['x-yonna-key'], key())) {
            missed(ip)
            return send(403, 'text/plain', '')
          }
          return send(204, 'text/plain', '')
        }
        // The lock's form: the first time it sets the password, then checks it.
        if (req.method === 'POST' && url.pathname === '/phone/unlock') {
          const k = url.searchParams.get('k')
          if (!same(k, key())) {
            missed(ip)
            return send(403, 'text/plain', 'This link is not valid.')
          }
          const password = new URLSearchParams((await body(req, 2048)).toString()).get('password') ?? ''
          if (!existsSync(LOCK)) {
            if (password.length < 8) return send(200, 'text/html; charset=utf-8', lockPage(k, 'Use a strong password — 8 characters or more.'), { 'content-security-policy': CSP })
            lockSet(password)
          } else if (!lockMatches(password)) {
            missed(ip)
            return send(200, 'text/html; charset=utf-8', lockPage(k, "That password didn't match."), { 'content-security-policy': CSP })
          }
          const app = page().replace(/__KEY__/g, encodeURIComponent(k)).replace(/__SESSION__/g, newSession())
          return send(200, 'text/html; charset=utf-8', app, { 'content-security-policy': CSP })
        }
        // A moment of silence: the phone plays it on a touch to unlock its player.
        if (req.method === 'GET' && url.pathname === '/silence.m4a') {
          const f = join(SUPPORT, 'phone-silence.m4a')
          if (!existsSync(f)) {
            await new Promise((ok) =>
              execFile('/usr/bin/say', ['--file-format=m4af', '--data-format=aac', '-o', f, '[[slnc 300]]'], () => ok()),
            )
          }
          return existsSync(f) ? send(200, 'audio/mp4', readFileSync(f), { 'cache-control': 'max-age=86400' }) : send(404, 'text/plain', '')
        }
        if (req.method === 'GET' && (url.pathname === '/icon.png' || url.pathname === '/apple-touch-icon.png')) {
          const png = icon()
          return png ? send(200, 'image/png', png, { 'cache-control': 'max-age=86400' }) : send(404, 'text/plain', '')
        }

        // The PC's password, typed on the phone: passed on to sign in once,
        // never logged or kept.
        if (req.method === 'POST' && url.pathname === '/phone/pc-password') {
          if (!same(req.headers['x-yonna-key'], key())) {
            missed(ip)
            return send(403, 'application/json', '{"say":"This phone is not allowed."}')
          }
          if (lockOn() && !inSession(req.headers['x-yonna-session'])) return send(401, 'application/json', '{"say":"Locked."}')
          const password = String(JSON.parse((await body(req, 1024)).toString() || '{}').password ?? '')
          if (!password) return send(200, 'application/json', '{"say":"No password."}')
          const say = await signIn(password)
          return send(200, 'application/json', JSON.stringify({ heard: '', say, needPassword: /waiting at the sign-in screen/.test(say), audio: await voiceOf(String(say), speak) }))
        }
        // The Windows PC's helper (its Left Ctrl): what was said (WAV) and a
        // picture of its screen — and of its camera, when that window is open —
        // with its own key. Heard here, answered, her voice sent back as WAV.
        if (req.method === 'POST' && url.pathname === '/pc/ask' && pc) {
          if (!same(req.headers['x-yonna-pc-key'], pc.key())) {
            missed(ip)
            return send(403, 'application/json', '{"say":"This PC is not allowed."}')
          }
          const j = JSON.parse((await body(req, 24 * 1024 * 1024)).toString() || '{}')
          let heard = typeof j.text === 'string' ? j.text.trim().slice(0, 500) : '' // asked again, with a picture
          if (!heard) {
            const file = join(tmpdir(), `yonna-pc-${randomBytes(4).toString('hex')}.wav`)
            await writeFile(file, Buffer.from(String(j.wav ?? ''), 'base64'))
            try {
              const text = await transcribe(file)
              if (text === null) return send(200, 'application/json', JSON.stringify({ heard: '', say: "I can't listen right now — Yonna Keys isn't running on the Mac." }))
              heard = text.trim().slice(0, 500)
            } finally {
              unlink(file).catch(() => {})
            }
          }
          // Nothing said: nothing to do, and nothing shown.
          if (!heard) return send(200, 'application/json', JSON.stringify({ heard: '', say: '' }))
          // A question that needs eyes, and no camera picture with it: the PC is
          // asked to open its camera and send the question again with one.
          const needsEyes = /\b(?:what'?s|what is|whats) (?:on|in front of) (?:my|the) (?:desk|table)\b|\bwhat (?:do|can) you see\b|\bwhat am i holding\b|\blook at (?:this|that|my desk)\b|\bcan you see\b|\bhow (?:do|should|can) i (?:connect|plug|set up|attach|put|fix|install)\b|\bwhich (?:port|cable|wire|plug|socket)\b|\bwhat is this\b|\bwhat'?s this\b/i
          if (!j.camera && needsEyes.test(heard)) return send(200, 'application/json', JSON.stringify({ heard, needCamera: true }))
          const pic = (b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })
          const images = [j.camera, j.screen].filter((x) => typeof x === 'string' && x.length > 100).map(pic)
          pc.vision(images, j.camera
            ? "The first picture is from the camera window the user opened on their PC, pointed at their desk, taken just now — use it when they ask about something in front of them (how to connect or set up a thing, what something is); don't describe it unless asked. The second is their PC's screen."
            : "This is the user's Windows PC screen as it was when they asked — use it if the question is about what's on it.")
          const extra = {}
          const say = String(await pc.ask(heard, extra))
          pc.vision([], '') // not left for someone else's next question
          console.log(`[yonna] pc: "${heard.slice(0, 60)}" -> ${say.slice(0, 80)}`)
          return send(200, 'application/json', JSON.stringify({ heard, say, camera: extra.camera ?? null, wav: await wavOf(say, speak) }))
        }
        // Asking: the key comes as a header.
        if (req.method === 'POST' && (url.pathname === '/phone' || url.pathname === '/phone/audio')) {
          if (!same(req.headers['x-yonna-key'], key())) {
            missed(ip)
            return send(403, 'application/json', '{"say":"This phone is not allowed."}')
          }
          if (lockOn() && !inSession(req.headers['x-yonna-session'])) return send(401, 'application/json', '{"say":"Locked."}')
          let heard = ''
          if (url.pathname === '/phone') {
            heard = String(JSON.parse((await body(req, 4096)).toString() || '{}').text ?? '')
          } else {
            const audio = await body(req, 8 * 1024 * 1024)
            const type = req.headers['content-type'] ?? ''
            const ext = /wav/.test(type) ? 'wav' : /webm/.test(type) ? 'webm' : 'm4a'
            const file = join(tmpdir(), `yonna-phone-${randomBytes(4).toString('hex')}.${ext}`)
            await writeFile(file, audio)
            try {
              const text = await transcribe(file)
              if (text === null) return send(200, 'application/json', JSON.stringify({ heard: '', say: "I can't listen right now — Yonna Keys isn't running on your Mac." }))
              heard = text
            } finally {
              unlink(file).catch(() => {})
            }
          }
          heard = heard.trim().slice(0, 500)
          if (!heard) return send(200, 'application/json', JSON.stringify({ heard: '', say: "I didn't catch that." }))
          const extra = {}
          const say = await ask(heard, extra)
          console.log(`[yonna] phone app: "${heard.slice(0, 60)}" -> ${String(say).slice(0, 80)}`)
          // The PC waiting for its password: the page asks for it.
          const needPassword = /waiting at the sign-in screen/.test(String(say))
          return send(200, 'application/json', JSON.stringify({ heard, say, needPassword, call: extra.call, audio: await voiceOf(String(say), speak) }))
        }
        send(404, 'text/plain', 'Not found')
      } catch (err) {
        console.warn(`[yonna] phone app: ${err?.message ?? err}`)
        if (!res.headersSent) send(500, 'application/json', '{"say":"Something went wrong."}')
      }
    },
  )
  server.on('error', (err) => console.warn(`[yonna] phone app: ${err.message}`))
  server.listen(PORT, () => console.log(`[yonna] phone app on https port ${PORT}`))
}
