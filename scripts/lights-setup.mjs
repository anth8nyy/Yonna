#!/usr/bin/env node
/**
 * Sets up Yonna's lights: finds the Xiaomi bulbs on the home Wi-Fi, asks for
 * each one's name and token (typed here, not shown), checks the token works
 * by blinking the bulb, and saves them to ~/Library/Application Support/Yonna/
 * lights.json, readable only by this user. Tokens never leave this Mac.
 *
 *   node scripts/lights-setup.mjs                  (or with a bulb's address
 *   node scripts/lights-setup.mjs 192.168.1.37      if the search misses it)
 *
 * The tokens come from the Xiaomi account the bulbs were added to — the
 * Xiaomi cloud tokens extractor lists them with each bulb's address.
 */
import { createInterface } from 'node:readline'
import { call, discover, isOn, lightsConfig, saveLights } from '../bridge/lights.mjs'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((r) => rl.question(q, r))
/** A question whose answer isn't shown while it's typed or pasted. */
function secret(q) {
  return new Promise((resolve) => {
    const write = rl._writeToOutput
    let asked = false
    // The question itself is written; what is typed after it isn't.
    rl._writeToOutput = (text) => {
      if (!asked) { asked = true; write.call(rl, text) }
    }
    rl.question(q, (a) => {
      rl._writeToOutput = write
      process.stdout.write('\n')
      resolve(a.trim())
    })
  })
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('Looking for Xiaomi devices on your Wi-Fi…')
const found = await discover(null, 3000)
// Bulbs named by address too (node scripts/lights-setup.mjs 192.168.1.37):
// some don't answer the search sent to everyone, only one sent to them.
for (const ip of process.argv.slice(2)) {
  if (found.some((d) => d.ip === ip)) continue
  const [d] = await discover(ip, 2000)
  if (d) found.push(d)
  else console.log(`Nothing answered at ${ip}.`)
}
if (!found.length) {
  console.log('None answered. Are the bulbs switched on, and is this Mac on the same Wi-Fi?')
  process.exit(1)
}
const saved = lightsConfig()
const list = []
for (const d of found) {
  const before = saved.find((b) => b.id === d.id)
  console.log(`\nFound one at ${d.ip}${before ? ` (already set up as "${before.name}")` : ''}.`)
  const token = await secret(`  Its token (32 letters and digits — Enter to skip${before ? ', keeping it as it is' : ''}): `)
  if (!token) {
    if (before) list.push({ ...before, ip: d.ip })
    continue
  }
  if (!/^[0-9a-f]{32}$/i.test(token)) {
    console.log('  That isn\'t a token (it should be 32 letters a–f and digits). Skipped.')
    if (before) list.push({ ...before, ip: d.ip })
    continue
  }
  const bulb = { ip: d.ip, id: d.id, token: token.toLowerCase() }
  try {
    const info = await call(bulb, 'miIO.info')
    console.log(`  Token works — it's a ${info?.model ?? 'Xiaomi device'}.`)
    bulb.model = info?.model
  } catch {
    console.log('  It didn\'t accept that token. Check you copied the one for this address. Skipped.')
    if (before) list.push({ ...before, ip: d.ip })
    continue
  }
  // A blink, so you can see which bulb this is.
  try {
    const on = await isOn(bulb)
    await call(bulb, 'set_power', [on ? 'off' : 'on']).catch(() => call(bulb, 'set_properties', [{ siid: 2, piid: 1, value: !on }]))
    await pause(1200)
    await call(bulb, 'set_power', [on ? 'on' : 'off']).catch(() => call(bulb, 'set_properties', [{ siid: 2, piid: 1, value: on }]))
    console.log('  (It just blinked.)')
  } catch {}
  bulb.name = (await ask(`  What do you call it? (like "Desk light")${before ? ` [${before.name}]` : ''}: `)).trim() || before?.name || `Light ${list.length + 1}`
  list.push(bulb)
}
// Bulbs set up before that didn't answer this time are kept.
for (const b of saved) if (!list.some((x) => x.id === b.id)) list.push(b)
saveLights(list)
rl.close()
console.log(`\nSaved ${list.length} light${list.length === 1 ? '' : 's'}: ${list.map((b) => b.name).join(', ') || 'none'}.`)
console.log('Now say "turn on the lights" to Yonna.')
