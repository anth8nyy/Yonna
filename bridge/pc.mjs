import { execFile } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { closest, flat } from './names.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The other computer — a Windows PC on the home network, by cable.
 *
 *   on   Wake-on-LAN: the "magic packet" (the PC's network address sixteen
 *        times) broadcast on the home network. The PC needs Wake-on-LAN on in
 *        its BIOS and network adapter.
 *   off  SSH into Windows' own OpenSSH Server with a key made only for Yonna
 *        (~/.ssh/yonna_pc), then the "Yonna Shutdown" task: a window on the
 *        PC counting down 15 seconds with a Cancel button (scripts/pc,
 *        installed by scripts/pc/install.mjs). With nobody signed in there is
 *        no screen to show it on, so it is a plain 15-second shutdown.
 *   cancel  stops either.
 *   open    "open Valorant on my PC": the "Yonna Open" task finds the app by
 *           name among what is installed and opens it on the PC's screen.
 *
 * Set up in ~/Library/Application Support/Yonna/pc.json:
 *   {"name": "my PC", "mac": "AA:BB:CC:DD:EE:FF", "ip": "192.168.1.30", "user": "Anthony"}
 */

const CONFIG = join(homedir(), 'Library/Application Support/Yonna/pc.json')
const KEY = join(homedir(), '.ssh/yonna_pc')

/** The PC's name for the start of a sentence: "Your PC", "Gaming PC". */
const Name = (pc) => {
  const n = pc?.name || 'your PC'
  return n[0].toUpperCase() + n.slice(1)
}

export function pcConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch {
    return null
  }
}

/** Whether the PC answers on the home network right now. */
export function pcIsOn(pc = pcConfig()) {
  if (!pc?.ip) return Promise.resolve(false)
  return new Promise((resolve) =>
    execFile('/sbin/ping', ['-c', '1', '-t', '1', pc.ip], { timeout: 3000 }, (err) => resolve(!err)),
  )
}

/** Turn the PC on. */
export async function wakePc() {
  const pc = pcConfig()
  if (await pcIsOn(pc)) return `${Name(pc)} is already on.`
  const mac = String(pc?.mac ?? '').replace(/[^0-9a-f]/gi, '')
  if (mac.length !== 12) return "I don't know your PC's network address yet — it needs setting up once."
  const bytes = Buffer.from(mac, 'hex')
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)])
  // To everyone on the network, and to the PC's own address, on both usual ports.
  const targets = ['255.255.255.255']
  if (pc.ip) targets.push(pc.ip.replace(/\.\d+$/, '.255'))
  await new Promise((resolve) => {
    const s = createSocket('udp4')
    s.bind(() => {
      s.setBroadcast(true)
      let left = targets.length * 2
      for (const host of targets)
        for (const port of [9, 7])
          s.send(packet, port, host, () => {
            if (--left === 0) {
              s.close()
              resolve()
            }
          })
    })
  })
  return `Turning on ${pc.name || 'your PC'}.`
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Who is at the PC: "yes" (someone signed in — its desktop is there),
 * "nobody" (at the sign-in screen) or "away" (not answering yet: booting).
 */
function signedIn(pc) {
  return new Promise((resolve) =>
    execFile('/usr/bin/ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', `${pc.user}@${pc.ip}`, 'quser'],
      { timeout: 8000 }, (err, out) => {
        if (!err && /active/i.test(String(out))) return resolve('yes')
        // ssh itself failing (255) or timing out: the PC isn't up yet.
        resolve(err && (err.code === 255 || err.killed) ? 'away' : 'nobody')
      }),
  )
}

/**
 * Signing in at the sign-in screen with the user's password, without keeping
 * it. Windows can't be typed into there from outside — that is what keeps
 * malware out — so instead the PC restarts once with automatic sign-in for
 * exactly one sign-in (AutoLogonCount 1: Windows then turns it off and deletes
 * the password itself, and Yonna deletes it again to be sure).
 *
 * The password travels only inside the SSH connection, as input — never on a
 * command line or in a script, where Windows could log it — and is checked
 * against the account before anything changes.
 */
const SIGN_IN = `
$p = [Console]::In.ReadLine()
Add-Type -AssemblyName System.DirectoryServices.AccountManagement
$ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')
if (-not $ctx.ValidateCredentials($env:USERNAME, $p)) { 'wrong'; exit }
$k = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
Set-ItemProperty -Path $k -Name AutoAdminLogon -Value '1'
Set-ItemProperty -Path $k -Name DefaultUserName -Value $env:USERNAME
Set-ItemProperty -Path $k -Name DefaultDomainName -Value $env:COMPUTERNAME
Set-ItemProperty -Path $k -Name DefaultPassword -Value $p
Set-ItemProperty -Path $k -Name AutoLogonCount -Value 1 -Type DWord
$p = $null
'ok'
shutdown.exe /r /t 0
`
const FORGET = `
$k = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
Remove-ItemProperty -Path $k -Name DefaultPassword -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $k -Name AutoLogonCount -ErrorAction SilentlyContinue
Set-ItemProperty -Path $k -Name AutoAdminLogon -Value '0'
`
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64')

function psOnPc(pc, script, input = '') {
  return new Promise((resolve) => {
    const child = execFile('/usr/bin/ssh',
      ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${pc.user}@${pc.ip}`,
        `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded(script)}`],
      { timeout: 20000 }, (err, out) => resolve(String(out ?? '').trim() || (err ? 'fail' : '')))
    child.stdin.end(input)
  })
}

/** "ok" (signed in, at the desktop), "wrong" (not the password) or "fail". */
async function signInPc(pc, password) {
  const r = await psOnPc(pc, SIGN_IN, `${password}\n`)
  password = null
  if (/^wrong/.test(r)) return 'wrong'
  if (!/^ok/.test(r)) return 'fail'
  // Down for the restart, back up, signed in.
  for (let i = 0; i < 30 && (await pcIsOn(pc)); i++) await pause(2000)
  for (let i = 0; i < 60; i++) {
    await pause(3000)
    if ((await signedIn(pc)) === 'yes') {
      await psOnPc(pc, FORGET)
      await pause(8000) // a moment for the desktop to settle
      return 'ok'
    }
  }
  await psOnPc(pc, FORGET)
  return 'fail'
}

/**
 * The PC on and at its desktop, turning it on if it is off: "on" (it already
 * was), "woke" (turned on and signed in now), "locked" (waiting at the sign-in
 * screen), "wrong" (the password given wasn't right) or "off" (didn't come on).
 * At the sign-in screen it asks for the password with askPassword (the Mac's
 * box), when there is one.
 */
export async function pcReady(pc = pcConfig(), askPassword = null) {
  if ((await pcIsOn(pc)) && (await signedIn(pc)) === 'yes') return 'on'
  let woke = false
  if (!(await pcIsOn(pc))) {
    await wakePc()
    woke = true
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await pause(3000); up = await pcIsOn(pc) }
    if (!up) return 'off'
  }
  // Booting until it answers; then a few seconds for a sign-in of its own.
  let state = 'away'
  for (let i = 0; i < 40 && state === 'away'; i++) { state = await signedIn(pc); if (state === 'away') await pause(3000) }
  for (let i = 0; i < 5 && state !== 'yes'; i++) { await pause(3000); state = await signedIn(pc) }
  if (state === 'yes') { await pause(woke ? 8000 : 0); return woke ? 'woke' : 'on' }
  if (!askPassword) return 'locked'
  const password = await askPassword()
  if (!password) return 'locked'
  const r = await signInPc(pc, password)
  return r === 'ok' ? 'woke' : r === 'wrong' ? 'wrong' : 'locked'
}

const LOCKED = (pc) =>
  `${Name(pc)} is on, but waiting at the sign-in screen for your password.`
const WRONG = "That wasn't your PC's password — nothing changed."

/** "Open my PC": on, and all the way to its desktop. */
export async function openPc(askPassword = null) {
  const pc = pcConfig()
  if (!pc?.mac) return "I don't know your PC's network address yet — it needs setting up once."
  const r = await pcReady(pc, askPassword)
  if (r === 'wrong') return WRONG
  if (r === 'on') return `${Name(pc)} is already on and ready.`
  if (r === 'woke') return `${Name(pc)} is on and at the desktop.`
  if (r === 'locked') return LOCKED(pc)
  return `${Name(pc)} didn't turn on — is it plugged in, with Wake-on-LAN on?`
}

/** Runs a command on the PC; null when it worked, else what went wrong. */
function onPc(pc, command) {
  return new Promise((resolve) =>
    execFile(
      '/usr/bin/ssh',
      [
        '-i', KEY,
        '-o', 'BatchMode=yes', // never asks for a password
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=accept-new',
        `${pc.user}@${pc.ip}`,
        command,
      ],
      { timeout: 15000 },
      (err, stdout, stderr) => resolve(err ? String(stderr || err.message) : null),
    ),
  )
}

function trouble(pc, out, doing) {
  if (/timed out|No route|Connection refused|Host is down/i.test(out)) return `${Name(pc)} isn't answering — it may already be off.`
  if (/Permission denied/i.test(out)) return "Your PC didn't accept Yonna's key — the PC setup needs finishing."
  return `I couldn't ${doing} your PC.`
}

/**
 * Minutes since someone used the PC's keyboard or mouse: 0 when it's in use
 * now, null when nobody is signed in or it can't be asked. (Windows' own
 * sign-in list says it: "none" or "." for under a minute, "7", "1:05", "2+03".)
 */
export function pcIdleMinutes(pc = pcConfig()) {
  return new Promise((resolve) =>
    execFile('/usr/bin/ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', `${pc.user}@${pc.ip}`, 'quser'],
      { timeout: 8000 }, (err, out) => {
        const line = String(out ?? '').split(/\r?\n/).find((l) => /\bactive\b/i.test(l))
        if (err || !line) return resolve(null)
        const idle = line.trim().split(/\s+/).slice(-3)[0] // the column before the sign-in date and time
        if (/^(?:none|\.)$/i.test(idle)) return resolve(0)
        const m = idle.match(/^(?:(\d+)\+)?(?:(\d+):)?(\d+)$/)
        resolve(m ? (Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3])) : null)
      }),
  )
}

/**
 * Shut the PC down. Apps open on its screen: a 15-second countdown window with
 * Cancel. Nothing open, or nobody signed in: it just shuts down.
 */
export async function shutdownPc() {
  const pc = pcConfig()
  if (!pc?.ip || !pc?.user) return "I can't reach your PC yet — shutting it down needs setting up once."
  if (!existsSync(KEY)) return "Yonna's key for the PC is missing — it needs setting up again."
  if (!(await pcIsOn(pc))) return `${Name(pc)} is already off.`
  const reply = await pcTask(pc, 'Yonna Shutdown', 'shutdown', 'go', 6000)
  if (reply === 'countdown') return `${Name(pc)} shuts down in 15 seconds — there's a Cancel button on its screen.`
  if (reply === 'now') return `Shutting down ${pc.name || 'your PC'}.`
  if (/^fail: /.test(reply)) return trouble(pc, reply, 'shut down')
  // Nobody signed in (or the task missing): nothing to lose, straight off.
  const out = await onPc(pc, 'shutdown /s /t 0')
  return out === null ? `Shutting down ${pc.name || 'your PC'}.` : trouble(pc, out, 'shut down')
}

/** Stop a shutdown that is counting down. */
export async function cancelShutdownPc() {
  const pc = pcConfig()
  if (!pc?.ip || !pc?.user) return "Your PC isn't set up yet."
  const out = await onPc(pc, 'schtasks /end /tn "Yonna Shutdown" >nul 2>&1 & shutdown /a >nul 2>&1 & exit /b 0')
  return out === null ? `Cancelled — ${pc.name || 'your PC'} stays on.` : trouble(pc, out, 'reach')
}

/**
 * Runs one of Yonna's tasks on the PC (scripts/pc) with a name for it, and
 * waits for its answer. Only a name crosses over — never a command.
 */
async function pcTask(pc, task, file, value, waitMs) {
  const v = String(value).replace(/'/g, "''")
  const ps =
    "$d=Join-Path $env:ProgramData 'Yonna'; $r=Join-Path $d '" + file + "-result.txt'; " +
    "if (-not (quser 2>$null)) { 'nobody'; exit }; " +
    `Remove-Item $r -ErrorAction SilentlyContinue; Set-Content -Path (Join-Path $d '${file}.txt') -Value '${v}' -Encoding UTF8; ` +
    `schtasks /run /tn '${task}' | Out-Null; ` +
    `for ($i=0; $i -lt ${Math.round(waitMs / 250)} -and -not (Test-Path $r); $i++) { Start-Sleep -Milliseconds 250 }; ` +
    "if (Test-Path $r) { Get-Content -Raw $r } else { 'timeout' }"
  return new Promise((resolve) =>
    execFile(
      '/usr/bin/ssh',
      ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${pc.user}@${pc.ip}`,
        `powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`],
      { timeout: waitMs + 10000 },
      // Windows starts the file with an invisible byte-order mark: dropped.
      (err, stdout, stderr) => resolve(err ? `fail: ${stderr || err.message}` : String(stdout).replace(/^\uFEFF/, '').trim()),
    ),
  )
}

const cleanName = (app) => String(app ?? '').replace(/[^\p{L}\p{N} .&+'-]/gu, '').trim().slice(0, 60)

/*
 * The PC's app names (its Start menu and Desktop), read from it at most once a
 * day and kept in pc-apps.json — so a misheard name ("Valant") can be put
 * right before it is sent ("VALORANT").
 */
const APPS = join(homedir(), 'Library/Application Support/Yonna/pc-apps.json')
let appsRead = 0
async function pcApps(pc) {
  let names = []
  try { names = JSON.parse(readFileSync(APPS, 'utf8')) } catch {}
  let fresh = false
  try { fresh = Date.now() - statSync(APPS).mtimeMs < 86_400_000 } catch {}
  if ((fresh && names.length) || Date.now() - appsRead < 600_000) return names
  appsRead = Date.now()
  const ps =
    "$n=@(); foreach ($p in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), " +
    "[Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'))) { if (Test-Path $p) { " +
    "$n += (Get-ChildItem -Path $p -Recurse -Include *.lnk, *.url -ErrorAction SilentlyContinue).BaseName } }; " +
    "$n += (Get-StartApps -ErrorAction SilentlyContinue).Name; ($n | Where-Object { $_ } | Sort-Object -Unique) -join [char]10"
  const out = await new Promise((resolve) =>
    execFile('/usr/bin/ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${pc.user}@${pc.ip}`,
      `powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`],
      { timeout: 20000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout))),
  )
  const read = out.replace(/^\uFEFF/, '').split(/\r?\n/).map((x) => x.trim())
    // Uninstallers, help files and the like aren't what anyone asks to open.
    .filter((x) => x && !/uninstall|readme|help|documentation|website|license|release notes/i.test(x))
  if (read.length) {
    names = read
    writeFileSync(APPS, JSON.stringify(names))
  }
  return names
}

/** A misheard app name put right from the PC's own list ("Valant" → VALORANT). */
async function pcName(pc, name) {
  const names = await pcApps(pc)
  if (!names.length) return name
  const f = flat(name)
  // Already the start of (or inside) a real name: leave it for the PC to find.
  if (names.some((n) => flat(n).includes(f))) return name
  return closest(name, names) ?? name
}

/** Close one app on the PC by name, or all of them (app = '*'), but those in `except`. */
export async function closeOnPc(app, except = []) {
  const pc = pcConfig()
  if (!pc?.ip || !pc?.user) return "Your PC isn't set up yet."
  if (!(await pcIsOn(pc))) return `${Name(pc)} is off.`
  let name = app === '*' ? '*' : cleanName(app)
  if (!name) return 'Which app?'
  if (name !== '*') name = await pcName(pc, name)
  const keep = app === '*' ? await Promise.all(except.map(cleanName).filter(Boolean).map((e) => pcName(pc, e))) : []
  const reply = await pcTask(pc, 'Yonna Close', 'close', keep.length ? `*|${keep.join(',')}` : name, 25000)
  const where = pc.name || 'your PC'
  if (reply === 'none') return keep.length ? `Nothing else is open on ${where}.` : `Nothing is open on ${where}.`
  if (/^notopen/.test(reply)) return `${name} is already closed on ${where}.`
  if (reply === 'nobody') return `Nobody is signed in on ${where}.`
  const m = reply.match(/^closed:\s*(.*?)\|stayed:\s*(.*)$/s)
  if (m) {
    const closed = m[1].trim()
    const stayed = m[2].trim()
    const parts = []
    if (closed) parts.push(app === '*' ? `Closed ${keep.length ? 'everything else' : 'everything'} on ${where}: ${closed}.` : `Closed ${closed}.`)
    if (keep.length) parts.push(`Kept ${keep.join(' and ')}.`)
    if (stayed) parts.push(`Still open, probably asking to save: ${stayed}.`)
    return parts.join(' ') || `Nothing closed on ${where}.`
  }
  if (/^fail: /.test(reply)) return trouble(pc, reply, 'reach')
  return `I couldn't close that on ${where}.`
}

/** Websites Yonna opens in Brave on the PC; more in pc.json's "sites". */
const SITES = {
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  'google mail': 'https://mail.google.com',
  google: 'https://www.google.com',
  netflix: 'https://www.netflix.com',
  twitch: 'https://www.twitch.tv',
}

/** The site's address for a spoken name ("YouTube", "eSchool"), else null. */
export function siteFor(name) {
  const key = String(name ?? '').toLowerCase().replace(/[^a-z0-9. ]/g, '').replace(/\s+/g, ' ').trim()
  const sites = { ...SITES, ...Object.fromEntries(Object.entries(pcConfig()?.sites ?? {}).map(([k, v]) => [k.toLowerCase(), v])) }
  const url = sites[key] ?? sites[key.replace(/ /g, '')] ?? sites[key.replace(/ /g, '-')]
  if (url) return url
  // Said as an address: "open eschool.gr on my PC".
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(key.replace(/ dot /g, '.').replace(/ /g, ''))) return `https://${key.replace(/ dot /g, '.').replace(/ /g, '')}`
  return null
}

/** Open a website in Brave on the PC's screen. */
export async function openSiteOnPc(url, label) {
  const pc = pcConfig()
  if (!pc?.ip || !pc?.user) return "Your PC isn't set up yet."
  if (!/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\/?=&%#-]*)?$/.test(url)) return "That isn't a website I can open."
  const reply = await pcTask(pc, 'Yonna Open', 'open', url, 10000)
  const where = pc.name || 'your PC'
  if (/^site: /.test(reply)) return `Opening ${label} in ${reply.slice(6).trim()} on ${where}.`
  if (reply === 'nobody') return `Nobody is signed in on ${where}, so there's no screen to open it on.`
  if (/^fail: /.test(reply)) return trouble(pc, reply, 'reach')
  return `I couldn't open ${label} on ${where}.`
}

/** Open an app on the PC's screen, by name: "Valorant", "Discord", "Steam". */
export async function openOnPc(app, askPassword = null) {
  // "YouTube in Brave" is YouTube.
  app = String(app ?? '').replace(/\s+(?:in|on|with|using) (?:the )?brave(?: browser)?$/i, '')
  const pc = pcConfig()
  if (!pc?.ip || !pc?.user) return "Your PC isn't set up yet."
  // Only a name crosses over — letters, digits and a few marks — never a command.
  let name = String(app ?? '').replace(/[^\p{L}\p{N} .&+'-]/gu, '').trim().slice(0, 60)
  if (!name) return 'Which app?'
  // Off or at the sign-in screen: on and to the desktop first.
  const ready = await pcReady(pc, askPassword)
  if (ready === 'wrong') return WRONG
  if (ready === 'off') return `${Name(pc)} didn't turn on — is it plugged in, with Wake-on-LAN on?`
  if (ready === 'locked') return LOCKED(pc)
  const site = siteFor(app)
  if (site) {
    const said = String(app).trim()
    const label = { youtube: 'YouTube', gmail: 'Gmail', netflix: 'Netflix', twitch: 'Twitch', google: 'Google', eschool: 'eSchool' }[said.toLowerCase().replace(/ /g, '')] ?? said
    return (ready === 'woke' ? `I turned ${pc.name || 'your PC'} on. ` : '') + (await openSiteOnPc(site, label))
  }
  // Misheard ("Valant"): the closest of the PC's own app names.
  name = (await pcName(pc, name)).replace(/'/g, "''")
  const ps =
    "$d=Join-Path $env:ProgramData 'Yonna'; $r=Join-Path $d 'open-result.txt'; " +
    "if (-not (quser 2>$null)) { 'nobody'; exit }; " +
    `Remove-Item $r -ErrorAction SilentlyContinue; Set-Content -Path (Join-Path $d 'open.txt') -Value '${name}' -Encoding UTF8; ` +
    "schtasks /run /tn 'Yonna Open' | Out-Null; " +
    "for ($i=0; $i -lt 40 -and -not (Test-Path $r); $i++) { Start-Sleep -Milliseconds 250 }; " +
    "if (Test-Path $r) { Get-Content -Raw $r } else { 'timeout' }"
  const reply = await new Promise((resolve) =>
    execFile(
      '/usr/bin/ssh',
      ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${pc.user}@${pc.ip}`,
        `powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`],
      { timeout: 25000 },
      (err, stdout, stderr) => resolve(err ? `fail: ${stderr || err.message}` : String(stdout).replace(/^\uFEFF/, '').trim()),
    ),
  )
  if (/^opened: /.test(reply)) return `${ready === 'woke' ? `I turned ${pc.name || 'your PC'} on. ` : ''}Opening ${reply.slice(8).trim()} on ${pc.name || 'your PC'}.`
  if (/^already: /.test(reply)) return `${reply.slice(9).trim()} is already open on ${pc.name || 'your PC'}.`
  if (/^notfound/.test(reply)) return `I couldn't find ${name} on ${pc.name || 'your PC'}.`
  if (reply === 'nobody') return `Nobody is signed in on ${pc.name || 'your PC'}, so there's no screen to open it on.`
  if (/^fail: /.test(reply)) return trouble(pc, reply, 'reach')
  return `I couldn't open ${name} on ${pc.name || 'your PC'}.`
}

