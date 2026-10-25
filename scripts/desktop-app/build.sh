#!/bin/bash
# Builds "Yonna.app" (default: on the Desktop) from launcher.sh.
#   bash scripts/desktop-app/build.sh [destination-folder]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST="${1:-$HOME/Desktop}"
APP="$DEST/Yonna.app"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

sed "s|__REPO__|$REPO|" "$HERE/launcher.sh" >"$APP/Contents/MacOS/launcher"
chmod +x "$APP/Contents/MacOS/launcher"

cat >"$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Yonna</string>
  <key>CFBundleDisplayName</key><string>Yonna</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>local.yonna.desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>LSRequiresNativeExecution</key><true/>
</dict>
</plist>
PLIST

# Icon: render the SVG with headless Chrome, then build an .icns.
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --user-data-dir="$WORK/chrome" \
  --window-size=1024,1024 --screenshot="$WORK/icon.png" "file://$HERE/icon.html" >/dev/null 2>&1
ICONSET="$WORK/AppIcon.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

touch "$APP"
echo "Built: $APP"

# Native helper apps: real compiled apps with their own usage descriptions,
# because macOS only grants (or even asks for) Calendar, Reminders, Messages
# and Automation access to one of those. Each is rebuilt only when its source
# changes — a new binary has a new signature, and macOS would ask for every
# permission all over again.
SUPPORT="$HOME/Library/Application Support/Yonna"

# A fixed local signing identity, as Atticus does. Signed with it, a rebuilt
# helper is still the same app to macOS, so its permissions (Microphone,
# Speech Recognition, Screen Recording) survive rebuilds. Ad hoc signing made
# every rebuild a stranger that had to be granted everything again. Made once;
# if it cannot be made, signing falls back to ad hoc.
SIGN_ID=$(security find-identity -p codesigning | awk '/Yonna Local Signing/{print $2; exit}')
if [ -z "$SIGN_ID" ]; then
  K=$(mktemp -d)
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -subj "/CN=Yonna Local Signing" \
    -addext "extendedKeyUsage=critical,codeSigning" -addext "keyUsage=critical,digitalSignature" \
    -keyout "$K/k.pem" -out "$K/c.pem" 2>/dev/null &&
    /usr/bin/openssl pkcs12 -export -inkey "$K/k.pem" -in "$K/c.pem" -out "$K/y.p12" -passout pass:yonna 2>/dev/null &&
    security import "$K/y.p12" -P yonna -T /usr/bin/codesign >/dev/null 2>&1 || true
  rm -rf "$K"
  SIGN_ID=$(security find-identity -p codesigning | awk '/Yonna Local Signing/{print $2; exit}')
fi

build_helper() { # <name> <executable> <bundle id> <source dir> <plist extras> [swiftc flags...]
  local name="$1" exe="$2" id="$3" src="$4" extras="$5"; shift 5
  local helper="$SUPPORT/$name.app"
  if [ -x "$helper/Contents/MacOS/$exe" ] && [ -z "$(find "$src" -newer "$helper/Contents/MacOS/$exe" -type f)" ]; then
    echo "Up to date: $helper"
    return
  fi
  rm -rf "$helper"
  mkdir -p "$helper/Contents/MacOS" "$helper/Contents/Resources"
  # Every .swift file in the folder (the keys helper has its meeting window
  # in meeting.swift), and any page beside the box.
  xcrun swiftc -O -o "$helper/Contents/MacOS/$exe" "$src"/*.swift "$@"
  for page in "$src"/*.html; do
    [ -e "$page" ] && [ "$(basename "$page")" != box.html ] && cp "$page" "$helper/Contents/Resources/"
  done
  cp "$APP/Contents/Resources/AppIcon.icns" "$helper/Contents/Resources/AppIcon.icns"
  # The keys helper's box: its page, with the thinking-orbs engine inlined.
  if [ -f "$src/box.html" ]; then
    /usr/bin/python3 - "$src/box.html" "$REPO/node_modules/thinking-orbs/dist/index-B8WsUNf5.js" "$helper/Contents/Resources/box.html" <<'PY'
import sys
page, orbs, out = sys.argv[1:4]
html = open(page).read().replace("/*ORBS*/", open(orbs).read())
open(out, "w").write(html)
PY
  fi
  cat >"$helper/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleExecutable</key><string>$exe</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>$id</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
$extras
</dict>
</plist>
PLIST
  codesign --force --sign "${SIGN_ID:--}" "$helper" >/dev/null 2>&1
  # Registered, so System Settings can list it for permissions.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$helper" >/dev/null 2>&1
  echo "Built: $helper"
}

build_helper "Yonna Calendar" YonnaCalendar local.yonna.calendar "$HERE/calendar-helper" '
  <key>NSCalendarsFullAccessUsageDescription</key><string>Yonna reads your schedule to you and adds, changes or removes events when you ask.</string>
  <key>NSCalendarsUsageDescription</key><string>Yonna reads your schedule to you and adds, changes or removes events when you ask.</string>
  <key>NSRemindersFullAccessUsageDescription</key><string>Yonna creates, changes and deletes reminders when you ask.</string>
  <key>NSRemindersUsageDescription</key><string>Yonna creates, changes and deletes reminders when you ask.</string>'

build_helper "Yonna Messages" YonnaMessages local.yonna.messages "$HERE/messages-helper" '
  <key>NSAppleEventsUsageDescription</key><string>Yonna sends his replies to you through Messages.</string>' -lsqlite3

build_helper "Yonna Messages Cleaner" YonnaCleaner local.yonna.cleaner "$HERE/cleaner-helper" ''

# Yonna's main window as a native Mac app on glass (window-app), opened by the
# launcher in place of Chrome. It listens with the Mac's own recogniser.
build_helper "Yonna Window" YonnaWindow local.yonna.window "$HERE/window-app" "
  <key>NSMicrophoneUsageDescription</key><string>Yonna listens for her name and your questions.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Yonna turns what you say into text, on this Mac.</string>
  <key>NSCameraUsageDescription</key><string>Yonna uses the camera for hand gestures and when you ask her to look.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>"
# Shown as plain "Yonna" in the Dock and the menu bar.
WIN="$SUPPORT/Yonna Window.app"
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$WIN/Contents/Info.plist" 2>/dev/null)" != "Yonna" ]; then
  /usr/libexec/PlistBuddy -c 'Set :CFBundleName Yonna' -c 'Set :CFBundleDisplayName Yonna' "$WIN/Contents/Info.plist"
  codesign --force --sign "${SIGN_ID:--}" "$WIN" >/dev/null 2>&1
fi

# Option+Space from any app, screenshots, and the answer box. Screen Recording
# is asked for by macOS itself the first time it takes a screenshot.
build_helper "Yonna Keys" YonnaKeys local.yonna.keys "$HERE/keys-helper" "
  <key>YonnaRepo</key><string>$REPO</string>
  <key>NSMicrophoneUsageDescription</key><string>Yonna listens while you hold fn.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Yonna turns what you say while holding fn into text, on this Mac.</string>"
