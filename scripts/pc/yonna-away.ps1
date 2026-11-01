# Yonna on the PC, for when the Mac is closed: the user has left the house.
#
# The iPhone writes "away" to Yonna.txt in iCloud Drive when they leave home
# (a Shortcuts automation) and "home" when it joins the home Wi-Fi. The Mac
# acts on it when it's awake (bridge/away.mjs); a closed Mac can't, so this
# runs every minute as the scheduled task "Yonna Away" and does the same when
# the Mac doesn't answer: ten minutes after "away", unless someone is using
# this PC, the lights go off and the PC shuts down. Each "away" is acted on
# once. The bulbs' tokens are in lights.json beside this, readable only by
# this user. Installed by scripts/pc/install.mjs.

$dir = Join-Path $env:ProgramData 'Yonna'
$file = Join-Path $env:USERPROFILE 'iCloudDrive\iCloud~is~workflow~my~workflows\Yonna.txt'
$doneFile = Join-Path $dir 'away-done.txt'
$mac = '192.168.1.17'
function Log($m) { Add-Content -Path (Join-Path $dir 'away.log') -Value ("{0:s} {1}" -f (Get-Date), $m) }

if (-not (Test-Path $file)) { exit }
$item = Get-Item $file
$word = (Get-Content -Raw $file -ErrorAction SilentlyContinue)
if ($word -notmatch '(?i)away|left|leave') { exit }
$at = $item.LastWriteTimeUtc
if (((Get-Date).ToUniversalTime() - $at).TotalMinutes -lt 10) { exit }
$stamp = $at.ToString('o')
if ((Get-Content -Raw $doneFile -ErrorAction SilentlyContinue) -eq $stamp) { exit }
Set-Content -Path $doneFile -Value $stamp -NoNewline

# The Mac is awake: it does this itself.
if (Test-Connection -ComputerName $mac -Count 2 -Quiet -ErrorAction SilentlyContinue) { Log 'away: the Mac is awake and handles it'; exit }

# Someone using this PC: somebody is home.
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class YonnaIdle {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  public static uint Seconds() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return ((uint)Environment.TickCount - l.dwTime) / 1000; }
}
'@
if ([YonnaIdle]::Seconds() -lt 300) { Log 'away: someone is using the PC - leaving everything on'; exit }

# The lights off, in the bulbs' own protocol (miIO): a hello for the bulb's
# id and clock, then the command sealed with its token. Both of its dialects
# are sent; the bulb answers the one it speaks.
function Bulb($ip, $tokenHex, $json) {
  $token = [byte[]]::new(16); for ($i = 0; $i -lt 16; $i++) { $token[$i] = [Convert]::ToByte($tokenHex.Substring($i * 2, 2), 16) }
  $md5 = [Security.Cryptography.MD5]::Create()
  $key = $md5.ComputeHash($token)
  $iv = $md5.ComputeHash([byte[]]($key + $token))
  $udp = New-Object Net.Sockets.UdpClient
  $udp.Client.ReceiveTimeout = 2500
  $ep = New-Object Net.IPEndPoint ([Net.IPAddress]::Parse($ip)), 54321
  $hello = [byte[]](0x21, 0x31, 0x00, 0x20) + [byte[]](,0xff * 28)
  [void]$udp.Send($hello, $hello.Length, $ep)
  $from = New-Object Net.IPEndPoint ([Net.IPAddress]::Any), 0
  $h = $udp.Receive([ref]$from)
  $aes = [Security.Cryptography.Aes]::Create(); $aes.Key = $key; $aes.IV = $iv
  $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'
  $plain = [Text.Encoding]::UTF8.GetBytes($json)
  $data = $aes.CreateEncryptor().TransformFinalBlock($plain, 0, $plain.Length)
  $len = 32 + $data.Length
  $stamp = ([uint32]$h[12] -shl 24) -bor ([uint32]$h[13] -shl 16) -bor ([uint32]$h[14] -shl 8) -bor [uint32]$h[15]
  $stamp = $stamp + 1
  $head = [byte[]](0x21, 0x31, [byte]($len -shr 8), [byte]($len -band 0xff), 0, 0, 0, 0) + $h[8..11] +
    [byte[]]([byte](($stamp -shr 24) -band 0xff), [byte](($stamp -shr 16) -band 0xff), [byte](($stamp -shr 8) -band 0xff), [byte]($stamp -band 0xff)) + $token
  $sum = $md5.ComputeHash([byte[]]($head + $data))
  $packet = [byte[]]($head[0..15] + $sum + $data)
  [void]$udp.Send($packet, $packet.Length, $ep)
  try { [void]$udp.Receive([ref]$from) } catch {}
  $udp.Close()
}
$bulbs = @()
try { $bulbs = Get-Content -Raw (Join-Path $dir 'lights.json') | ConvertFrom-Json } catch {}
foreach ($b in $bulbs) {
  try {
    Bulb $b.ip $b.token '{"id":1,"method":"set_power","params":["off","smooth",400]}'
    Bulb $b.ip $b.token '{"id":2,"method":"set_properties","params":[{"siid":2,"piid":1,"value":false}]}'
  } catch { Log "away: couldn't reach $($b.name)" }
}
Log 'away: gone ten minutes with the Mac closed - lights off, PC shutting down'
shutdown.exe /s /t 30 /c "Yonna: you've left home - shutting down in 30 seconds."
