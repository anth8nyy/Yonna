import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeAllTargets } from './apps.mjs'

/**
 * Shutting this Mac down — "shut down my Mac", "close my Mac", also from the
 * iPhone.
 *
 * Nothing open: it shuts down straight away (after a moment, so the answer
 * reaches the phone first). Apps open: a 15-second countdown on the Mac's
 * screen with Cancel, as on the PC; "cancel the shutdown" stops it too. The
 * shutdown itself is the normal one — an app with unsaved work still asks.
 */

let countdown = null // the countdown's dialog, while it is up

const ICON = join(homedir(), 'Desktop/Yonna.app/Contents/Resources/AppIcon.icns')

function shutDownNow() {
  // loginwindow's own "shut down" event; System Events as a backup.
  execFile('/usr/bin/osascript', ['-e', 'tell application "loginwindow" to «event aevtshut»'], (err) => {
    if (err) execFile('/usr/bin/osascript', ['-e', 'tell application "System Events" to shut down'], () => {})
  })
}

export async function shutdownMac() {
  if (countdown) return 'Your Mac is already counting down to shut down.'
  const open = await closeAllTargets()
  if (!open.length) {
    setTimeout(shutDownNow, 2000)
    return 'Shutting down your Mac.'
  }
  const icon = existsSync(ICON) ? ` with icon (POSIX file "${ICON}")` : ''
  countdown = execFile(
    '/usr/bin/osascript',
    ['-e',
      `display dialog "Your Mac shuts down in 15 seconds." with title "Yonna" buttons {"Cancel", "Shut Down"} ` +
        `default button "Shut Down" cancel button "Cancel" giving up after 15${icon}`],
    (err) => {
      const cancelled = countdown === null || err
      countdown = null
      // Cancel (or "cancel the shutdown") ends with an error; time up or Shut Down doesn't.
      if (!cancelled) shutDownNow()
    },
  )
  return 'Your Mac shuts down in 15 seconds — there\'s a Cancel button on its screen.'
}

/** Whether the Mac is counting down. */
export const macCountingDown = () => countdown !== null

export function cancelShutdownMac() {
  if (!countdown) return 'Your Mac isn\'t shutting down.'
  const c = countdown
  countdown = null
  c.kill()
  return 'Cancelled — your Mac stays on.'
}
