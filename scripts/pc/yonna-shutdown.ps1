# Yonna's shutdown window, on the Windows PC.
#
# "Yonna, turn off my PC" runs this (as the scheduled task "Yonna Shutdown",
# so it appears on the screen of whoever is signed in): a small window in
# Yonna's colours counting down from 15 seconds, with Cancel. At zero the PC
# shuts down normally — an app with unsaved work can still hold it up and ask.
# Esc also cancels. With no app open there is no countdown: it shuts down at
# once. Installed by scripts/pc/install.mjs.

# Nothing open on the screen: no countdown, it just shuts down. Yonna reads
# which it was from shutdown-result.txt.
$dir = Join-Path $env:ProgramData 'Yonna'
$keep = 'explorer', 'powershell', 'pwsh', 'conhost', 'sshd', 'searchhost', 'startmenuexperiencehost',
        'shellexperiencehost', 'textinputhost', 'applicationframehost', 'systemsettings', 'lockapp', 'taskmgr'
$open = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($keep -notcontains $_.ProcessName.ToLower()) })
if (-not $open.Count) {
  Set-Content -Path (Join-Path $dir 'shutdown-result.txt') -Value 'now' -Encoding UTF8
  shutdown.exe /s /t 0
  exit
}
Set-Content -Path (Join-Path $dir 'shutdown-result.txt') -Value 'countdown' -Encoding UTF8

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class YonnaDwm {
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
}
'@
[Windows.Forms.Application]::EnableVisualStyles()

# Yonna's palette.
$bg     = [Drawing.Color]::FromArgb(10, 10, 11)    # #0A0A0B
$text   = [Drawing.Color]::FromArgb(237, 237, 235) # #EDEDEB
$muted  = [Drawing.Color]::FromArgb(107, 107, 112) # #6B6B70
$line   = [Drawing.Color]::FromArgb(28, 28, 31)    # #1C1C1F
$accent = [Drawing.Color]::FromArgb(157, 178, 255) # #9DB2FF

$seconds = 15
$form = New-Object Windows.Forms.Form
$form.Text = 'Yonna'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.ClientSize = New-Object Drawing.Size(300, 210)
$form.BackColor = $bg
$form.Opacity = 0.97
$form.KeyPreview = $true

function New-Label($t, $size, $color, $y, $h, $font = 'Segoe UI') {
  $l = New-Object Windows.Forms.Label
  $l.Text = $t
  $l.Font = New-Object Drawing.Font($font, $size)
  $l.ForeColor = $color
  $l.BackColor = [Drawing.Color]::Transparent
  $l.TextAlign = 'MiddleCenter'
  $l.SetBounds(0, $y, 300, $h)
  $l
}

$brand = New-Label 'Y  O  N  N  A' 8 $muted 18 18
$count = New-Label "$seconds" 36 $text 44 64 'Segoe UI Light'
$what  = New-Label 'Shutting down' 10 $muted 108 22

# A thin accent line that shortens with the seconds left.
$bar = New-Object Windows.Forms.Panel
$bar.BackColor = $accent
$bar.SetBounds(60, 140, 180, 2)
$track = New-Object Windows.Forms.Panel
$track.BackColor = $line
$track.SetBounds(60, 140, 180, 2)

$cancel = New-Object Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Font = New-Object Drawing.Font('Segoe UI', 10)
$cancel.FlatStyle = 'Flat'
$cancel.FlatAppearance.BorderSize = 1
$cancel.FlatAppearance.BorderColor = $line
$cancel.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(22, 22, 25)
$cancel.FlatAppearance.MouseDownBackColor = [Drawing.Color]::FromArgb(30, 30, 34)
$cancel.BackColor = $bg
$cancel.ForeColor = $accent
$cancel.Cursor = 'Hand'
$cancel.SetBounds(100, 160, 100, 32)
$form.CancelButton = $cancel

$script:left = $seconds
$script:go = $false
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $script:left--
  if ($script:left -le 0) { $timer.Stop(); $script:go = $true; $form.Close(); return }
  $count.Text = "$($script:left)"
  $bar.Width = [int](180 * $script:left / $seconds)
})
$cancel.Add_Click({ $timer.Stop(); $form.Close() })

# Drag it from anywhere but the button.
$script:drag = $null
foreach ($c in @($form, $brand, $count, $what)) {
  $c.Add_MouseDown({ $script:drag = [Windows.Forms.Cursor]::Position })
  $c.Add_MouseMove({
    if ($script:drag -and [Windows.Forms.Control]::MouseButtons -eq 'Left') {
      $p = [Windows.Forms.Cursor]::Position
      $form.Left += $p.X - $script:drag.X; $form.Top += $p.Y - $script:drag.Y
      $script:drag = $p
    }
  })
  $c.Add_MouseUp({ $script:drag = $null })
}

$form.Controls.AddRange(@($brand, $count, $what, $bar, $track, $cancel))
$form.Add_Shown({
  # Windows 11: rounded corners and the dark frame.
  $round = 2; [void][YonnaDwm]::DwmSetWindowAttribute($form.Handle, 33, [ref]$round, 4)
  $dark = 1; [void][YonnaDwm]::DwmSetWindowAttribute($form.Handle, 20, [ref]$dark, 4)
  $form.Activate()
  $timer.Start()
})
[void]$form.ShowDialog()

if ($script:go) { shutdown.exe /s /t 0 }
