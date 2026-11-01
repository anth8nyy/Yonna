# Yonna closes apps on the Windows PC: "close Valorant on my PC", "close all
# the apps on my PC", "close everything except Spotify on my PC" — and a
# website ("close YouTube") as its tab in the browser, not the browser.
#
# Run as the scheduled task "Yonna Close", in the signed-in user's session, so
# it can ask windows to close the way clicking X does: an app with unsaved work
# still asks first. Anything that has not closed after a few seconds is left
# alone and reported. Yonna writes the app's name (or * for all, or
# *|Spotify,Discord for all but those) to
# C:\ProgramData\Yonna\close.txt; the outcome goes to close-result.txt.
# Installed by scripts/pc/install.mjs.

$dir = Join-Path $env:ProgramData 'Yonna'
$result = Join-Path $dir 'close-result.txt'
$want = (Get-Content -Raw -ErrorAction SilentlyContinue (Join-Path $dir 'close.txt')).Trim()
function Done($msg) { Set-Content -Path $result -Value $msg -Encoding UTF8; exit }
if (-not $want) { Done 'error: no app name' }
function Norm($s) { ([string]$s -replace '[^\p{L}\p{N}]', '').ToLower() }
# "*|Spotify,Discord": all, except those.
$except = @()
if ($want -like '*|*') { $except = @(($want -split '\|', 2)[1] -split ',' | ForEach-Object { Norm $_ } | Where-Object { $_ }); $want = '*' }
function Kept($p) { foreach ($e in $except) { if ((Norm $p.ProcessName).Contains($e) -or (Norm $p.Description).Contains($e) -or (Norm $p.MainWindowTitle).Contains($e)) { return $true } }; return $false }

# Never closed from here: Windows itself and Yonna's own helpers.
$keep = 'explorer', 'powershell', 'pwsh', 'conhost', 'sshd', 'searchhost', 'startmenuexperiencehost',
        'shellexperiencehost', 'textinputhost', 'applicationframehost', 'systemsettings', 'lockapp', 'taskmgr'

# Apps with a window on the screen.
$apps = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($keep -notcontains $_.ProcessName.ToLower()) }

$browsers = 'brave', 'chrome', 'msedge', 'firefox', 'opera'

# A website ("close YouTube"): its tab closed in the browser — not the whole
# browser, whose window may be named after the tab in front ("YouTube - Brave").
if ($want -ne '*' -and ($browsers -notcontains (Norm $want))) {
  $w = Norm $want
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
  Add-Type @'
using System; using System.Runtime.InteropServices;
public static class YonnaFront {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
}
'@
  $A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.ControlType]
  $isType = { param($t) New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $t) }
  $closedTabs = @()
  foreach ($p in (Get-Process | Where-Object { $browsers -contains $_.ProcessName.ToLower() })) {
    foreach ($win in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $p.Id)))) {
      # The browser's own tab strip, not tabs inside a page.
      $strip = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (& $isType $T::Tab))
      if (-not $strip) { continue }
      for ($guard = 0; $guard -lt 10; $guard++) {
        $tab = $strip.FindAll([System.Windows.Automation.TreeScope]::Children, (& $isType $T::TabItem)) | Where-Object { (Norm $_.Current.Name).Contains($w) } | Select-Object -First 1
        if (-not $tab) { break }
        $name = $tab.Current.Name -replace ' - (Memory usage|Audio playing).*$', ''
        $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        [YonnaFront]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [YonnaFront]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
        [void][YonnaFront]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle)
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.SendKeys]::SendWait('^w') # that tab only
        Start-Sleep -Milliseconds 300
        $closedTabs += $name
      }
    }
  }
  if ($closedTabs.Count) { Done ("closed: " + (($closedTabs | Select-Object -Unique) -join ', ') + "|stayed: ") }
}

if ($want -eq '*') {
  $targets = @($apps | Where-Object { -not (Kept $_) })
} else {
  $w = Norm $want
  # By program name ("valorant", "Discord"), or by what its window says — but a
  # browser only by its own name: its window is named after whatever tab is in front.
  $targets = $apps | Where-Object { (Norm $_.ProcessName).Contains($w) -or (Norm $_.Description).Contains($w) -or
    (($browsers -notcontains $_.ProcessName.ToLower()) -and (Norm $_.MainWindowTitle).Contains($w)) }
  # A game's other processes (VALORANT-Win64-Shipping) go with it.
  $targets = @($targets) + @(Get-Process | Where-Object { (Norm $_.ProcessName).Contains($w) -and $_.MainWindowHandle -eq 0 })
}
$targets = @($targets | Sort-Object Id -Unique)
if (-not $targets.Count) { if ($want -eq '*') { Done 'none' } else { Done "notopen: $want" } }

# Each app by its window: closed the way clicking X does. Its background
# helpers (Brave has twenty) are named after it in the answer, not listed.
$names = @{}
$windows = @($targets | Where-Object { $_.MainWindowHandle -ne 0 })
foreach ($p in $windows) {
  $names[$p.ProcessName] = if ($p.Description) { $p.Description } else { $p.ProcessName }
  [void]$p.CloseMainWindow()
}
Start-Sleep -Seconds 3
# Helpers left behind by an app that has closed (a game's background part):
# stopped all at once.
if ($want -ne '*') {
  $left = @($targets | Where-Object { $_.MainWindowHandle -eq 0 } | ForEach-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue })
  if ($left.Count) { $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
}
$closed = @(); $stayed = @()
foreach ($p in $windows) {
  $label = $names[$p.ProcessName]
  $still = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  if ($still -and $still.MainWindowHandle -ne 0) { $stayed += $label } else { $closed += $label }
}
if (-not $windows.Count -and $want -ne '*') { $closed += $want }
$c = ($closed | Select-Object -Unique) -join ', '
$s = ($stayed | Select-Object -Unique) -join ', '
Done "closed: $c|stayed: $s"
