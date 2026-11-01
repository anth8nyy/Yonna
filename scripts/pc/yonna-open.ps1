# Yonna opens an app on the Windows PC: "Yonna, open Valorant on my PC".
#
# Run as the scheduled task "Yonna Open", so the app appears on the screen of
# whoever is signed in (anything started over SSH would run unseen). Yonna
# writes only the app's name to C:\ProgramData\Yonna\open.txt; this looks it up
# among the Start menu's apps and the Desktop's and Start menu's shortcuts,
# and opens the closest match. It never runs anything it is sent — only what
# is already installed. The outcome goes to open-result.txt for Yonna to read.
# Installed by scripts/pc/install.mjs.

$dir = Join-Path $env:ProgramData 'Yonna'
$result = Join-Path $dir 'open-result.txt'
$want = (Get-Content -Raw -ErrorAction SilentlyContinue (Join-Path $dir 'open.txt')).Trim()
function Done($msg) { Set-Content -Path $result -Value $msg -Encoding UTF8; exit }
if (-not $want) { Done 'error: no app name' }

# Letters and digits only, lower case: "VALORANT" = "valorant", "Discord.lnk" = "discord".
function Norm($s) { ($s -replace '\.lnk$', '' -replace '[^\p{L}\p{N}]', '').ToLower() }
$w = Norm $want

# A website ("open YouTube on my PC"): in Brave, or the default browser.
if ($want -match '^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/?=&%#-]*)?$') {
  $brave = @(
    (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe'),
    (Join-Path $env:ProgramFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  try {
    if ($brave) { Start-Process -FilePath $brave -ArgumentList $want; Done "site: Brave" }
    Start-Process $want; Done "site: browser"
  } catch { Done "error: $($_.Exception.Message)" }
}

# Riot's games: started straight into the game, the way the Start menu's
# VALORANT shortcut does — not just Riot Client waiting for Play.
$riot = @{ 'valorant' = 'valorant'; 'league' = 'league_of_legends'; 'leagueoflegends' = 'league_of_legends'; 'lol' = 'league_of_legends' }
if ($riot.ContainsKey($w)) {
  $rc = $null
  try { $rc = (Get-Content -Raw 'C:\ProgramData\Riot Games\RiotClientInstalls.json' | ConvertFrom-Json).rc_default } catch {}
  if (-not $rc) { $rc = 'C:\Riot Games\Riot Client\RiotClientServices.exe' }
  if (Test-Path $rc) {
    $game = if ($riot[$w] -eq 'valorant') { 'VALORANT' } else { 'League of Legends' }
    $already = [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and (Norm $_.ProcessName).StartsWith($w) -and $_.ProcessName -notmatch 'Riot' } | Select-Object -First 1)
    try {
      Start-Process -FilePath $rc -ArgumentList "--launch-product=$($riot[$w])", '--launch-patchline=live'
      if ($already) { Done "already: $game" } else { Done "opened: $game" }
    } catch { Done "error: $($_.Exception.Message)" }
  }
}

$found = @()
# Shortcuts on the desktops and in the Start menus (games like VALORANT put one here).
$places = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu')
)
foreach ($p in $places) {
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Recurse -Include *.lnk, *.url -ErrorAction SilentlyContinue | ForEach-Object {
      $found += [pscustomobject]@{ Name = $_.BaseName; Open = $_.FullName }
    }
  }
}
# Store apps and everything else the Start menu lists.
Get-StartApps -ErrorAction SilentlyContinue | ForEach-Object {
  $found += [pscustomobject]@{ Name = $_.Name; Open = "shell:AppsFolder\$($_.AppID)" }
}

# Exact name first, then a name that starts with it, then one that contains it.
$hit = $found | Where-Object { (Norm $_.Name) -eq $w } | Select-Object -First 1
if (-not $hit) { $hit = $found | Where-Object { (Norm $_.Name).StartsWith($w) } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }
if (-not $hit -and $w.Length -ge 3) { $hit = $found | Where-Object { (Norm $_.Name).Contains($w) } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }
if (-not $hit) { Done "notfound: $want" }

# Already open? A program named like the app ("VALORANT" for the game, not
# the Riot Client its shortcut starts) with a window on the screen — Brave and
# others keep helpers running in the background with no window, which don't
# count. Opened anyway, which brings it forward, but said so.
$n = Norm $hit.Name
$already = $n.Length -ge 3 -and [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and (Norm $_.ProcessName).Contains($n) } | Select-Object -First 1)
try {
  Start-Process -FilePath $hit.Open
  if ($already) { Done "already: $($hit.Name)" } else { Done "opened: $($hit.Name)" }
} catch {
  Done "error: $($_.Exception.Message)"
}
