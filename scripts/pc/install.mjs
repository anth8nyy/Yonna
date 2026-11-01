#!/usr/bin/env node
/**
 * Puts Yonna's helpers on the Windows PC, over Yonna's SSH key: the
 * shutdown window (yonna-shutdown.ps1), opening apps (yonna-open.ps1),
 * closing them (yonna-close.ps1), the lights-and-PC-off when the user has
 * left home with the Mac closed (yonna-away.ps1, every minute), and holding
 * Left Ctrl to talk to Yonna from the PC (yonna-talk.ps1):
 *
 *   node scripts/pc/install.mjs
 *
 * Copies them to C:\ProgramData\Yonna and registers the scheduled tasks
 * "Yonna Shutdown", "Yonna Open" and "Yonna Close", run as the signed-in user (interactive,
 * so windows and apps show on their screen; no password stored). The PC must be on
 * and set up as in bridge/pc.mjs.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pc = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Yonna/pc.json'), 'utf8'))
const b64 = (f) => Buffer.from(readFileSync(join(here, f), 'utf8'), 'utf8').toString('base64')
const lights = (() => {
  try { return readFileSync(join(homedir(), 'Library/Application Support/Yonna/lights.json'), 'utf8') } catch { return '[]' }
})()
// The away task checks whether this Mac is awake: its address on the home network.
const macIp = (() => {
  try { return execFileSync('/usr/sbin/ipconfig', ['getifaddr', 'en0'], { encoding: 'utf8' }).trim() } catch { return '192.168.1.17' }
})()
const away = Buffer.from(readFileSync(join(here, 'yonna-away.ps1'), 'utf8').replace("$mac = '192.168.1.17'", `$mac = '${macIp}'`), 'utf8').toString('base64')
// The Left Ctrl helper (yonna-talk.ps1): this Mac's address, the PC's own key,
// and the print of this Mac's https certificate, which it trusts alone.
const pcKey = (() => {
  try { return readFileSync(join(homedir(), 'Library/Application Support/Yonna/pc-key'), 'utf8').trim() } catch { return '' }
})()
const certPrint = (() => {
  try {
    const out = execFileSync('/usr/bin/openssl', ['x509', '-noout', '-fingerprint', '-sha1', '-in', join(homedir(), 'Library/Application Support/Yonna/phone-tls/server.crt')], { encoding: 'utf8' })
    return out.split('=')[1].replace(/:/g, '').trim()
  } catch { return '' }
})()
const talk = Buffer.from(readFileSync(join(here, 'yonna-talk.ps1'), 'utf8').replace('__MAC__', macIp).replace('__KEY__', pcKey).replace('__PRINT__', certPrint), 'utf8').toString('base64')

// Run on the PC as PowerShell; the window's script travels as base64 so no quoting can break it.
const ps = `
$dir = Join-Path $env:ProgramData 'Yonna'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$who = '${pc.user}'
$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
foreach ($t in @(@('Yonna Shutdown', 'yonna-shutdown.ps1', '${b64('yonna-shutdown.ps1')}'), @('Yonna Open', 'yonna-open.ps1', '${b64('yonna-open.ps1')}'), @('Yonna Close', 'yonna-close.ps1', '${b64('yonna-close.ps1')}'))) {
  $file = Join-Path $dir $t[1]
  [IO.File]::WriteAllText($file, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($t[2])))
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$file\`""
  Register-ScheduledTask -TaskName $t[0] -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  'installed: ' + $t[0]
}
# "Yonna Away": every minute, for when the Mac is closed (yonna-away.ps1).
# Started through a tiny VBScript so no window flashes up each minute.
$file = Join-Path $dir 'yonna-away.ps1'
[IO.File]::WriteAllText($file, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${away}')))
$vbs = Join-Path $dir 'yonna-away.vbs'
$q = [char]34
[IO.File]::WriteAllText($vbs, 'CreateObject(' + $q + 'WScript.Shell' + $q + ').Run ' + $q + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $q + $q + $file + $q + $q + $q + ', 0, False')
# The bulbs' tokens, for turning the lights off: readable only by this user (and admins).
$lj = Join-Path $dir 'lights.json'
[IO.File]::WriteAllText($lj, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(lights).toString('base64')}')))
icacls $lj /inheritance:r /grant:r "$($who):(R,W)" "Administrators:F" "SYSTEM:F" | Out-Null
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ($q + $vbs + $q)
# Every minute, for years, and again from each sign-in.
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $who
$logon.Repetition = $every.Repetition
$awaySettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Yonna Away' -Action $action -Trigger @($every, $logon) -Principal $principal -Settings $awaySettings -Force | Out-Null
'installed: Yonna Away'
# "Yonna Talk": Left Ctrl to talk, from each sign-in, unseen (yonna-talk.ps1).
# Its key is in the script, so only this user (and admins) may read it.
$file = Join-Path $dir 'yonna-talk.ps1'
[IO.File]::WriteAllText($file, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${talk}')))
icacls $file /inheritance:r /grant:r "$($who):(R,W)" "Administrators:F" "SYSTEM:F" | Out-Null
$vbs = Join-Path $dir 'yonna-talk.vbs'
[IO.File]::WriteAllText($vbs, 'CreateObject(' + $q + 'WScript.Shell' + $q + ').Run ' + $q + 'powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File ' + $q + $q + $file + $q + $q + $q + ', 0, False')
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ($q + $vbs + $q)
$talkSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Yonna Talk' -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $who) -Principal $principal -Settings $talkSettings -Force | Out-Null
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like '*yonna-talk.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName 'Yonna Talk'
'installed: Yonna Talk'
`
// Sent through the connection's input: too long for Windows' command line.
const out = execFileSync(
  '/usr/bin/ssh',
  ['-i', join(homedir(), '.ssh/yonna_pc'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${pc.user}@${pc.ip}`,
    'powershell -NoProfile -NonInteractive -Command -'],
  { encoding: 'utf8', timeout: 60000, input: ps + '\nexit\n' },
)
console.log(out.trim())
