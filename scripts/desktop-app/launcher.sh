#!/bin/bash
# Yonna — double-click launcher.
#
# Starts the bridge (brain) and the Vite face if they aren't already running,
# opens Yonna's native glass window (Yonna Window.app, see window-app) — or,
# if that is missing, an app-style Chrome window — and stops whatever it
# started once that window is closed.
#
# Built into "Yonna.app" by build.sh, which fills in __REPO__.

REPO="__REPO__"
URL="http://localhost:5173"
HEALTH="http://localhost:8787/health"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SUPPORT="$HOME/Library/Application Support/Yonna"
PROFILE="$SUPPORT/chrome-profile"
WINDOW_APP="$SUPPORT/Yonna Window.app"
LOG="$HOME/Library/Logs/Yonna.log"

# LaunchServices can't tell a script's architecture, so on Apple Silicon it may
# start this under Rosetta — and then Chrome, node and the bridge all inherit
# x86_64: WebGL crawls, and the Agent SDK looks for a darwin-x64 binary that
# isn't installed and the bridge dies on the first connection. Re-exec native.
if [ "$(/usr/sbin/sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
  exec /usr/bin/arch -arm64 /bin/bash "$0" "$@"
fi

# Apps opened from Finder get a bare PATH; node and claude live outside it.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$SUPPORT"
exec >>"$LOG" 2>&1
echo "=== $(date) — launching"

alert() {
  /usr/bin/osascript -e "display alert \"Yonna\" message \"$1\" as critical" >/dev/null
}

up() { /usr/bin/curl -s -o /dev/null -m 1 "$1"; }

if [ ! -d "$WINDOW_APP" ] && [ ! -x "$CHROME" ]; then
  alert "Google Chrome is not installed. Yonna needs Chrome to run."
  exit 1
fi
if [ ! -d "$REPO/node_modules" ]; then
  alert "Could not find the Yonna project at $REPO."
  exit 1
fi

# The main process of Yonna's own Chrome instance, however it was started.
# Matched by profile anywhere on the command line — macOS sometimes relaunches
# it in the background with the arguments in a different order — and with the
# helper processes (renderer, GPU…) excluded.
yonna_chrome_pid() {
  for pid in $(/usr/bin/pgrep -f -- "--user-data-dir=$PROFILE"); do
    case "$(/bin/ps -o command= -p "$pid" 2>/dev/null)" in
      *"Contents/MacOS/Google Chrome --"*) echo "$pid"; return 0 ;;
    esac
  done
  return 1
}

# Visible windows belonging to a process. CoreGraphics reports window owners
# and bounds without any Accessibility or Automation permission.
visible_windows() {
  /usr/bin/osascript -l JavaScript - "$1" <<'JXA' 2>/dev/null
ObjC.import('CoreGraphics');
function run(argv) {
  const pid = parseInt(argv[0], 10);
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID));
  let n = 0;
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    if (w.objectForKey('kCGWindowOwnerPID').intValue !== pid) continue;
    if (w.objectForKey('kCGWindowLayer').intValue !== 0) continue;
    if (w.objectForKey('kCGWindowBounds').objectForKey('Height').doubleValue < 100) continue;
    n++;
  }
  return String(n);
}
JXA
}

activate_pid() {
  /usr/bin/osascript -l JavaScript - "$1" <<'JXA' >/dev/null 2>&1
ObjC.import('AppKit');
function run(argv) {
  $.NSRunningApplication.runningApplicationWithProcessIdentifier(parseInt(argv[0], 10))
    .activateWithOptions($.NSApplicationActivateAllWindows);
}
JXA
}

# Already running, with a live window? Bring it forward and stop there. The
# bridge knows whether a Yonna window is actually connected; a background
# Chrome with nothing in it, or a half-started Yonna, does not count.
OLD=$(/usr/bin/pgrep -x YonnaWindow | head -1)
[ -z "$OLD" ] && OLD=$(yonna_chrome_pid)
if [ -n "$OLD" ] && /usr/bin/curl -s -m 1 "$HEALTH" | grep -q '"windows":[1-9]'; then
  activate_pid "$OLD"
  exit 0
fi

# Anything else is a leftover. Stop ALL of it — old watchers first, so none of
# them can kill the servers this launch is about to start; then Yonna's
# Chrome; then the servers — and wait until each is really gone. The old way
# let a stopping launcher and a starting one overlap, and the window came up
# with no brain behind it.
echo "starting clean"
# An earlier launch of this app, still running.
for pid in $(/usr/bin/pgrep -f "Yonna.app/Contents/MacOS/launcher"); do
  [ "$pid" != "$$" ] && kill "$pid" 2>/dev/null
done
/usr/bin/pkill -f -- "--user-data-dir=$PROFILE" 2>/dev/null
/usr/bin/pkill -x YonnaWindow 2>/dev/null
/usr/bin/pkill -f "bridge/server.mjs" 2>/dev/null
/usr/bin/pkill -f "node_modules/vite/bin/vite.js --port 5173" 2>/dev/null
for _ in $(seq 1 40); do
  if ! /usr/bin/pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null \
     && ! /usr/sbin/lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1 \
     && ! /usr/sbin/lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
/usr/bin/pkill -9 -f -- "--user-data-dir=$PROFILE" 2>/dev/null
/usr/bin/pkill -9 -f "bridge/server.mjs" 2>/dev/null
/usr/bin/pkill -9 -f "node_modules/vite/bin/vite.js --port 5173" 2>/dev/null

started=()
cd "$REPO" || exit 1

if ! up "$HEALTH"; then
  node bridge/server.mjs &
  started+=($!)
fi
if ! up "$URL"; then
  node node_modules/vite/bin/vite.js --port 5173 --strictPort &
  started+=($!)
fi

# Wait up to ~30s for both halves to answer.
for _ in $(seq 1 60); do
  up "$HEALTH" && up "$URL" && break
  sleep 0.5
done
if ! up "$URL"; then
  alert "Yonna did not start. Details are in ~/Library/Logs/Yonna.log"
  for pid in "${started[@]}"; do kill "$pid" 2>/dev/null; done
  exit 1
fi

# A dedicated profile makes this its own Chrome instance, so we can tell when
# it quits, and it remembers the microphone permission separately.
#
# Supervised from a detached background job, and this script exits straight
# away. While the app's own process is alive macOS considers Yonna
# "already running", and a second double-click is sent to it as a reopen event
# that a shell script can never answer — so nothing at all happened.
#
# Started through LaunchServices (`open -n -a`) rather than run directly. A
# process this script spawns is attributed to this unsigned script app for
# privacy purposes, and macOS can neither grant nor even prompt for the camera
# on its behalf — getUserMedia simply never returns, so the hand camera never
# came on. Launched as itself, Chrome asks with its own camera permission.
# The global Option+Space shortcut and its little answer box (keys-helper).
# It keeps running after Yonna closes, so the shortcut can bring her back.
if [ -d "$SUPPORT/Yonna Keys.app" ] && ! /usr/bin/pgrep -x YonnaKeys >/dev/null; then
  /usr/bin/open -g -a "$SUPPORT/Yonna Keys.app"
fi

# The native glass window when it is built; Chrome otherwise.
if [ -d "$WINDOW_APP" ]; then
  /usr/bin/open -n -a "$WINDOW_APP"
  (
    for _ in $(seq 1 40); do /usr/bin/pgrep -x YonnaWindow >/dev/null && break; sleep 0.25; done
    while /usr/bin/pgrep -x YonnaWindow >/dev/null; do sleep 2; done
    echo "window closed — stopping"
    for pid in "${started[@]}"; do kill "$pid" 2>/dev/null; done
  ) </dev/null &
  disown
  exit 0
fi

/usr/bin/open -n -a "Google Chrome" --args \
  --user-data-dir="$PROFILE" \
  --app="$URL" \
  --start-maximized \
  --no-first-run \
  --no-default-browser-check \
  --autoplay-policy=no-user-gesture-required
# Bring it to the front with keyboard focus once its window is up, so G, M and
# Space reach Yonna rather than whatever app was in front before.
for _ in $(seq 1 40); do
  NEW=$(yonna_chrome_pid)
  [ -n "$NEW" ] && [ "$(visible_windows "$NEW")" != "0" ] && break
  sleep 0.25
done
[ -n "$NEW" ] && activate_pid "$NEW"
(
  instance() { yonna_chrome_pid >/dev/null; }
  for _ in $(seq 1 40); do instance && break; sleep 0.25; done
  while instance; do sleep 2; done
  echo "chrome exited — stopping"
  for pid in "${started[@]}"; do kill "$pid" 2>/dev/null; done
) </dev/null &
disown
exit 0
