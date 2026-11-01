import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The lights — Xiaomi / Mi smart bulbs, straight over the home Wi-Fi with
 * Xiaomi's own local protocol (miIO): no Xiaomi servers, no AI.
 *
 * Every bulb only obeys messages sealed with its own token (from the user's
 * Xiaomi account, fetched once — see scripts/lights-setup.mjs). The tokens
 * stay in ~/Library/Application Support/Yonna/lights.json (readable only by
 * this user):
 *
 *   [{"name": "Desk light", "ip": "192.168.1.36", "id": 469830657, "token": "…32 hex…"}]
 *
 * Older bulbs answer the classic commands (set_power, set_bright…); newer
 * ones only the MIoT kind (set_properties). Each is tried, and what worked is
 * remembered for that bulb.
 */

const CONFIG = join(homedir(), 'Library/Application Support/Yonna/lights.json')
const PORT = 54321

export function lightsConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch {
    return []
  }
}

export function saveLights(list) {
  writeFileSync(CONFIG, JSON.stringify(list, null, 2), { mode: 0o600 })
}

const md5 = (...b) => createHash('md5').update(Buffer.concat(b)).digest()

/** The 32-byte "hello" every miIO device answers, with its id and clock. */
const HELLO = Buffer.from('21310020' + 'f'.repeat(56), 'hex')

/** Who answers hello: [{ip, id}] — on the whole network, or one address. */
export function discover(ip = null, ms = 2500) {
  return new Promise((resolve) => {
    const found = new Map()
    const s = createSocket('udp4')
    s.on('message', (b, r) => {
      if (b.length >= 32 && b.readUInt16BE(0) === 0x2131) found.set(r.address, { ip: r.address, id: b.readUInt32BE(8) })
    })
    s.on('error', () => {})
    s.bind(() => {
      s.setBroadcast(true)
      const to = ip ?? broadcastAddress()
      for (let i = 0; i < 3; i++) setTimeout(() => s.send(HELLO, PORT, to), i * 300)
    })
    setTimeout(() => {
      s.close()
      resolve([...found.values()])
    }, ms)
  })
}

function broadcastAddress() {
  // The home network's: the PC's address, or the usual 192.168.1.x.
  try {
    const pc = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Yonna/pc.json'), 'utf8'))
    if (pc.ip) return pc.ip.replace(/\.\d+$/, '.255')
  } catch {}
  return '192.168.1.255'
}

let msgId = Math.floor(Math.random() * 1000)

/**
 * One command to one bulb: hello (for its clock), then the sealed message,
 * then its sealed answer. Resolves the answer's JSON; throws on silence.
 */
export function call(bulb, method, params = []) {
  const token = Buffer.from(bulb.token, 'hex')
  const key = md5(token)
  const iv = md5(key, token)
  return new Promise((resolve, reject) => {
    const s = createSocket('udp4')
    let done = false
    const finish = (err, val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      s.close()
      err ? reject(err) : resolve(val)
    }
    const timer = setTimeout(() => finish(new Error('no answer')), 3000)
    let sent = false
    s.on('error', (e) => finish(e))
    s.on('message', (b) => {
      if (b.length < 32 || b.readUInt16BE(0) !== 0x2131) return
      if (!sent) {
        // Hello's answer: its id and clock, for the real message.
        sent = true
        const id = b.readUInt32BE(8)
        const stamp = b.readUInt32BE(12) + 1
        const c = createCipheriv('aes-128-cbc', key, iv)
        const data = Buffer.concat([c.update(JSON.stringify({ id: ++msgId, method, params })), c.final()])
        const head = Buffer.alloc(32)
        head.writeUInt16BE(0x2131, 0)
        head.writeUInt16BE(32 + data.length, 2)
        head.writeUInt32BE(0, 4)
        head.writeUInt32BE(id, 8)
        head.writeUInt32BE(stamp, 12)
        token.copy(head, 16)
        md5(head, data).copy(head, 16)
        s.send(Buffer.concat([head, data]), PORT, bulb.ip)
        return
      }
      if (b.length === 32) return
      try {
        const d = createDecipheriv('aes-128-cbc', key, iv)
        const text = Buffer.concat([d.update(b.subarray(32)), d.final()]).toString().replace(/\0+$/, '')
        const j = JSON.parse(text)
        j.error ? finish(new Error(j.error.message || 'refused')) : finish(null, j.result)
      } catch (e) {
        finish(new Error('wrong token'))
      }
    })
    s.bind(() => s.send(HELLO, PORT, bulb.ip))
  })
}

/** A bulb that moved to another address (the router gave it a new one): found again by its id. */
async function reach(bulb, method, params) {
  try {
    return await call(bulb, method, params)
  } catch (err) {
    if (err.message !== 'no answer' || !bulb.id) throw err
    const again = (await discover()).find((d) => d.id === bulb.id)
    if (!again || again.ip === bulb.ip) throw err
    bulb.ip = again.ip
    const all = lightsConfig()
    const mine = all.find((b) => b.id === bulb.id)
    if (mine) { mine.ip = again.ip; saveLights(all) }
    return call(bulb, method, params)
  }
}

/*
 * What to say to a bulb, in both dialects. MIoT: service 2 is the light —
 * 1 on, 2 brightness (1–100), 3 colour temperature (K), 4 colour (RGB number).
 */
const ASK = {
  power: (on) => [['set_power', [on ? 'on' : 'off', 'smooth', 400]], ['set_properties', [{ siid: 2, piid: 1, value: on }]]],
  bright: (n) => [['set_bright', [n, 'smooth', 400]], ['set_properties', [{ siid: 2, piid: 2, value: n }]]],
  ct: (k) => [['set_ct_abx', [k, 'smooth', 400]], ['set_properties', [{ siid: 2, piid: 3, value: k }]]],
  rgb: (n) => [['set_rgb', [n, 'smooth', 400]], ['set_properties', [{ siid: 2, piid: 4, value: n }]]],
}

async function tell(bulb, what, value) {
  const [classic, miot] = ASK[what](value)
  const order = bulb.miot ? [miot, classic] : [classic, miot]
  let last
  for (const [method, params] of order) {
    try {
      const r = await reach(bulb, method, params)
      // MIoT answers per property; a code below 0 is a refusal.
      if (Array.isArray(r) && r[0]?.code < 0) throw new Error('refused')
      bulb.miot = method === 'set_properties'
      return true
    } catch (err) {
      last = err
      if (err.message === 'no answer' || err.message === 'wrong token') break
    }
  }
  throw last
}

/** Is it on? (for the setup's test, and "are the lights on?") */
export async function isOn(bulb) {
  try {
    const r = await reach(bulb, 'get_prop', ['power'])
    if (Array.isArray(r) && typeof r[0] === 'string') return r[0] === 'on'
  } catch {}
  const r = await reach(bulb, 'get_properties', [{ siid: 2, piid: 1 }])
  return Boolean(r?.[0]?.value)
}

const COLOURS = {
  red: 0xff0000, orange: 0xff7a00, yellow: 0xffd000, green: 0x00ff40, blue: 0x0040ff, 'light blue': 0x40c0ff,
  cyan: 0x00ffff, purple: 0x8a2be2, violet: 0x8a2be2, pink: 0xff4fa0, magenta: 0xff00ff,
}
const WHITES = { warm: 2700, 'warm white': 2700, cozy: 2700, white: 4000, neutral: 4000, cool: 5500, 'cool white': 5500, daylight: 6500 }
export const colourNames = [...Object.keys(COLOURS), ...Object.keys(WHITES)]

/** The bulbs a phrase means: "the desk light", or all of them. */
function which(name) {
  const all = lightsConfig()
  if (!name) return all
  const n = name.toLowerCase().replace(/^(?:the|my)\s+/, '').replace(/\s+(?:light|lights|lamp|bulb)s?$/, '').trim()
  if (!n || /^(?:all|every)/.test(n)) return all
  return all.filter((b) => b.name.toLowerCase().includes(n))
}

/**
 * Do something with the lights. action: on | off | bright (n 1–100) |
 * colour (a name: red, warm…). name: one bulb ("desk") or all.
 */
export async function lights(action, value = null, name = null) {
  const all = lightsConfig()
  if (!all.length) return "Your lights aren't set up yet — run the lights setup once."
  const bulbs = which(name)
  if (!bulbs.length) return `I don't have a light called ${name}. I have: ${all.map((b) => b.name).join(', ')}.`
  const results = await Promise.allSettled(
    bulbs.map(async (b) => {
      if (action === 'on') return tell(b, 'power', true)
      if (action === 'off') return tell(b, 'power', false)
      await tell(b, 'power', true)
      if (action === 'bright') return tell(b, 'bright', Math.max(1, Math.min(100, Math.round(value))))
      if (action === 'colour') {
        const c = String(value).toLowerCase()
        if (WHITES[c]) return tell(b, 'ct', WHITES[c])
        if (COLOURS[c] != null) return tell(b, 'rgb', COLOURS[c])
        throw new Error('colour')
      }
    }),
  )
  const failed = bulbs.filter((_, i) => results[i].status === 'rejected')
  if (results.some((r) => r.reason?.message === 'colour')) return `I don't know the colour ${value}.`
  const what = bulbs.length === all.length ? (all.length > 1 ? 'Lights' : 'Light') : bulbs.map((b) => b.name).join(' and ')
  const done =
    action === 'on' ? `${what} on.` : action === 'off' ? `${what} off.` :
    action === 'bright' ? `${what} at ${Math.round(value)}%.` : `${what} ${value}.`
  if (!failed.length) return done
  if (failed.length === bulbs.length) return `I couldn't reach ${failed.length > 1 ? 'the lights' : failed[0].name} — are they switched on at the wall?`
  return `${done.replace(/\.$/, '')} — but ${failed.map((b) => b.name).join(' and ')} didn't answer.`
}
