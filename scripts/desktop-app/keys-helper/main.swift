// Yonna Keys — the global shortcut (hold fn, or the keys in keys.json), and the little box it shows.
//
// Hold fn (or Option+Control+Space) in any app and talk; let go to send. A small box at the
// top left of the screen shows what you said and then her answer, which she
// also speaks — like Atticus. Her window does not need to be open: this app
// listens itself (Apple's on-device speech recognition), asks the brain
// directly, and speaks with the system voice. If the brain is not running it
// starts just the brain, in the background, with no window.
//
// Each press also takes a screenshot of the screen the mouse is on, so she can
// see what you are looking at. The pointer is marked with a red ring; if you
// draw a loop with the mouse while holding the keys, the loop is drawn in red
// and a close-up of what is inside it is attached as well — "what is this?"
// then means the thing you circled.
//
// It talks to the bridge (ws://localhost:8787/?client=keys) as a conversation
// of its own.
//
// Permissions: Microphone and Speech Recognition (asked for once, by macOS),
// and Screen Recording for the screenshots. The shortcut and the mouse need
// none.

import AppKit
import AVFoundation
import CoreAudio
import CoreImage
import Carbon.HIToolbox
import Foundation
import ScreenCaptureKit
import Speech
import WebKit

let BRIDGE = URL(string: ProcessInfo.processInfo.environment["YONNA_BRIDGE"] ?? "ws://localhost:8787/?client=keys")!
let YONNA_APP_ID = "local.yonna.desktop"
let TMP = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("yonna-keys", isDirectory: true)

// MARK: - The box

/**
 * The box at the top left: a small page (box.html, with Atticus's thinking
 * orb) over frosted glass, in a borderless panel that never takes focus and
 * is left out of screenshots.
 */
/** A plain clickable patch over the page's voice button. A native view takes
 *  the click even though the panel never becomes key. */
final class Hit: NSView {
    var action: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { action?() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

final class Box: NSObject, WKScriptMessageHandler, NSGestureRecognizerDelegate {
    let panel: NSPanel
    let voiceHit = Hit()
    /** Pressed the voice button: spoken answers on or off. */
    var onVoice: (() -> Void)?
    let web: WKWebView
    let glass = NSVisualEffectView()
    var hideTimer: Timer?
    var height: CGFloat = 52
    var ready = false
    var pending: String?
    let width: CGFloat = 380

    override init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 52),
                        styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 380, height: 52), configuration: cfg)
        super.init()
        cfg.userContentController.add(self, name: "h")
        panel.level = .statusBar
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        // Kept out of screenshots, so it never appears in what she is shown.
        panel.sharingType = .none

        glass.material = .popover
        // Partly transparent itself, so more of the desktop shows through.
        glass.alphaValue = 0.7
        glass.appearance = NSAppearance(named: .darkAqua)
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 18
        glass.layer?.masksToBounds = true
        glass.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.autoresizingMask = [.width, .height]
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 52))
        root.wantsLayer = true
        glass.frame = root.bounds
        web.frame = root.bounds
        root.addSubview(glass)
        root.addSubview(web)
        // The voice button sits at the right end of the box's top row.
        voiceHit.frame = NSRect(x: width - 46, y: 52 - 44, width: 38, height: 38)
        voiceHit.autoresizingMask = [.minXMargin, .minYMargin]
        voiceHit.action = { [weak self] in self?.onVoice?() }
        root.addSubview(voiceHit)
        panel.contentView = root

        if let url = Bundle.main.url(forResource: "box", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        let click = NSClickGestureRecognizer(target: self, action: #selector(dismiss))
        click.delegate = self
        root.addGestureRecognizer(click)
        // The page is ready once it reports its first height.
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let h = m.body as? Double else { return }
        height = CGFloat(h)
        if !ready {
            ready = true
            if let js = pending { web.evaluateJavaScript(js) }
            pending = nil
        }
        layout()
    }

    @objc func dismiss() { hide() }

    /** A click on the voice button toggles the voice; it does not close the box. */
    func gestureRecognizer(_ g: NSGestureRecognizer, shouldAttemptToRecognizeWith event: NSEvent) -> Bool {
        guard let root = panel.contentView else { return true }
        return !voiceHit.frame.contains(root.convert(event.locationInWindow, from: nil))
    }

    /** Shows the voice button as on (speaker) or off (speaker crossed out). */
    func setVoice(_ on: Bool) { run("ui.voice(\(on))") }

    private func run(_ js: String) {
        if ready { web.evaluateJavaScript(js) } else { pending = js }
    }

    private func json(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(data: d, encoding: .utf8)!.dropFirst().dropLast())
    }

    /** Titles from the rest of the app map onto the page's states. */
    func show(title t: String, question q: String? = nil, answer a: String? = nil) {
        hideTimer?.invalidate()
        let lower = t.lowercased()
        let state = lower.contains("listening") ? "listening"
            : lower.contains("thinking") || lower.contains("starting") ? "thinking"
            : lower.contains("permission") ? "notice" : "answer"
        var args = ["state: \"\(state)\""]
        if let q { args.append("question: \(json(q))") }
        if let a { args.append("answer: \(json(a))") }
        run("ui.set({\(args.joined(separator: ", "))})")
        layout()
        if !panel.isVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { $0.duration = 0.18; panel.animator().alphaValue = 1 }
        }
    }

    /** The microphone's loudness, 0..1, for the wave and the orb. */
    func level(_ v: Float) {
        guard panel.isVisible, ready else { return }
        web.evaluateJavaScript("ui.level(\(String(format: "%.3f", v)))")
    }

    func clear() { run("ui.set({question: \"\", answer: \"\"})") }

    /** Fits the page, in the top-left corner of the screen the mouse is on. */
    func layout() {
        let h = min(max(height, 52), 460)
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main!
        let v = screen.visibleFrame
        panel.setFrame(NSRect(x: v.minX + 14, y: v.maxY - 14 - h, width: width, height: h), display: true)
    }

    func hide(after seconds: TimeInterval = 0) {
        hideTimer?.invalidate()
        let go = { [weak self] in
            guard let self else { return }
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.2; self.panel.animator().alphaValue = 0 },
                                                 completionHandler: { self.panel.orderOut(nil) })
        }
        if seconds <= 0 { go(); return }
        hideTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in go() }
    }
}

// MARK: - The screen, the pointer and a circle

struct Capture {
    let image: CGImage
    let screen: NSScreen
}

/**
 * Screenshot of the screen the mouse is on, with ScreenCaptureKit — inside this
 * app, as Atticus does. The `screencapture` command it replaced showed macOS's
 * "would like to record this computer's screen" box on every single press on
 * new macOS, even with the permission on. Yonna's own box is left out of it.
 */
/** Why the last screenshot failed, for keys-status.json. */
var lastCaptureError = ""

func captureScreen(_ done: @escaping (Capture?) -> Void) {
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main!
    let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID ?? CGMainDisplayID()
    Task {
        var out: Capture? = nil
        defer { let c = out; DispatchQueue.main.async { done(c) } }
        let all: SCShareableContent
        do {
            all = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            lastCaptureError = "shareable content: \(error.localizedDescription)"
            return
        }
        guard let d = all.displays.first(where: { $0.displayID == id }) ?? all.displays.first else {
            lastCaptureError = "no display"
            return
        }
        let mine = all.windows.filter { $0.owningApplication?.bundleIdentifier == Bundle.main.bundleIdentifier }
        let cfg = SCStreamConfiguration()
        let scale = screen.backingScaleFactor
        cfg.width = Int(CGFloat(d.width) * scale)
        cfg.height = Int(CGFloat(d.height) * scale)
        cfg.showsCursor = false
        do {
            let img = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(display: d, excludingWindows: mine), configuration: cfg)
            out = Capture(image: img, screen: screen)
            lastCaptureError = ""
        } catch {
            lastCaptureError = "capture: \(error.localizedDescription)"
        }
    }
}

/** Did the mouse go round something? A loop is a path that turns most of the
 *  way around its own centre and is big enough to mean it. */
func circled(_ pts: [CGPoint]) -> CGRect? {
    guard pts.count > 12 else { return nil }
    let xs = pts.map(\.x), ys = pts.map(\.y)
    let box = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
    guard min(box.width, box.height) >= 24 else { return nil }
    let c = CGPoint(x: box.midX, y: box.midY)
    var turned: CGFloat = 0
    var prev = atan2(pts[0].y - c.y, pts[0].x - c.x)
    for p in pts.dropFirst() {
        let a = atan2(p.y - c.y, p.x - c.x)
        var d = a - prev
        if d > .pi { d -= 2 * .pi }
        if d < -.pi { d += 2 * .pi }
        turned += d
        prev = a
    }
    return abs(turned) >= 1.6 * .pi ? box : nil
}

/** Draws the pointer (and the loop, if any) onto the screenshot, scales it
 *  down for the model, and cuts out the circled part. Points are in global
 *  screen coordinates (origin bottom-left). */
func annotate(_ cap: Capture, path: [CGPoint]) -> (image: URL, crop: URL?, note: String)? {
    let cg = cap.image
    let W = CGFloat(cg.width), H = CGFloat(cg.height)
    let f = cap.screen.frame
    let k = W / f.width
    // Global points → image pixels (origin top-left).
    func px(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x - f.minX) * k, y: (f.maxY - p.y) * k) }
    let onScreen = path.filter { NSMouseInRect($0, f, false) }
    let loop = circled(onScreen)

    let scale = min(1, 1600 / W)
    let ow = Int(W * scale), oh = Int(H * scale)
    guard let ctx = CGContext(data: nil, width: ow, height: oh, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: ow, height: oh))
    // CGContext's origin is bottom-left: flip y for drawing in image pixels.
    func dp(_ p: CGPoint) -> CGPoint { let q = px(p); return CGPoint(x: q.x * scale, y: CGFloat(oh) - q.y * scale) }
    ctx.setStrokeColor(NSColor.systemRed.cgColor)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    if loop != nil {
        ctx.setLineWidth(5)
        ctx.beginPath()
        ctx.move(to: dp(onScreen[0]))
        for p in onScreen.dropFirst() { ctx.addLine(to: dp(p)) }
        ctx.strokePath()
    }
    if let last = onScreen.last ?? (NSMouseInRect(NSEvent.mouseLocation, f, false) ? NSEvent.mouseLocation : nil) {
        let c = dp(last)
        ctx.setLineWidth(4)
        ctx.strokeEllipse(in: CGRect(x: c.x - 18, y: c.y - 18, width: 36, height: 36))
    }
    guard let out = ctx.makeImage() else { return nil }
    let image = TMP.appendingPathComponent("screen-\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
    write(out, to: image)

    var crop: URL? = nil
    if let loop {
        let a = px(CGPoint(x: loop.minX, y: loop.maxY)), b = px(CGPoint(x: loop.maxX, y: loop.minY))
        var r = CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
        r = r.insetBy(dx: -r.width * 0.15 - 12, dy: -r.height * 0.15 - 12).intersection(CGRect(x: 0, y: 0, width: W, height: H))
        if let piece = cg.cropping(to: r.integral) {
            crop = TMP.appendingPathComponent("circled-\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
            write(piece, to: crop!)
        }
    }
    let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
    let note = loop != nil
        ? "screenshot attached; front app: \(app). The user drew a loop around something with the mouse (red); the second image is a close-up of what is inside it."
        : "screenshot attached; front app: \(app). The red ring marks where the mouse pointer is."
    return (image, crop, note)
}

func write(_ img: CGImage, to url: URL) {
    let rep = NSBitmapImageRep(cgImage: img)
    if let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) {
        try? data.write(to: url)
    }
}

// MARK: - Her name, as the recogniser mishears it

let NAME = try! NSRegularExpression(
    pattern: "\\b(yonna|yona|yonah|jonna|jona|jonah|johna|joanna|johanna|iona|rianna|riana|rihanna|fionna|fiona|deanna|dionna|yanna)\\b",
    options: [.caseInsensitive])
func fixName(_ s: String) -> String {
    NAME.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "Yonna")
}

// MARK: - Listening

/** Apple's speech recogniser, on the device, for as long as the keys are held. */
/** A recording, as text, recognised on this Mac. Empty if nothing was heard. */
/// hints: words it should expect — the user's contacts, lights and apps —
/// which it otherwise mishears (unusual names, "Valorant", "eSchool").
func transcribeFile(_ path: String, hints: [String] = [], done: @escaping (String) -> Void) {
    guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), rec.isAvailable else { return done("") }
    let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    req.contextualStrings = Array(hints.prefix(100))
    req.taskHint = .dictation
    if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    req.shouldReportPartialResults = false
    var answered = false
    let finish: (String) -> Void = { t in
        DispatchQueue.main.async {
            guard !answered else { return }
            answered = true
            done(t)
        }
    }
    _ = rec.recognitionTask(with: req) { result, error in
        if let result, result.isFinal { finish(result.bestTranscription.formattedString) }
        else if error != nil { finish(result?.bestTranscription.formattedString ?? "") }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { finish("") }
}

// MARK: - Speaking, for the iPhone

/**
 * Her answers to the iPhone as sound files, in the Mac's own voice (the same
 * one `say` uses). `say` loads the voice afresh every time — about a second —
 * while this keeps it loaded, so a reply's sound is ready almost at once.
 * One at a time; the rest wait their turn.
 */
final class PhoneVoice: NSObject, NSSpeechSynthesizerDelegate {
    let synth = NSSpeechSynthesizer()
    var queue: [(text: String, path: String, done: (Bool) -> Void)] = []
    var current: ((Bool) -> Void)?

    override init() {
        super.init()
        synth.delegate = self
    }

    // Messages arrive on the connection's thread; speech needs the main one,
    // whose run loop delivers "finished".
    func speak(_ text: String, to path: String, done: @escaping (Bool) -> Void) {
        DispatchQueue.main.async {
            self.queue.append((text, path, done))
            self.next()
        }
    }

    private func next() {
        guard current == nil, !queue.isEmpty else { return }
        let job = queue.removeFirst()
        current = job.done
        if !synth.startSpeaking(job.text, to: URL(fileURLWithPath: job.path)) { finish(false) }
    }

    private func finish(_ ok: Bool) {
        let done = current
        current = nil
        done?(ok)
        next()
    }

    func speechSynthesizer(_ sender: NSSpeechSynthesizer, didFinishSpeaking finishedSpeaking: Bool) {
        finish(finishedSpeaking)
    }
}
let phoneVoice = PhoneVoice()

// MARK: - Placing a call

/**
 * After Yonna asks macOS to call someone through the iPhone, macOS shows a
 * "<name> — Click to Call" notice with a green button. This presses it, as the
 * user would — Yonna Keys already has Accessibility for the fn key. Only a
 * button (or notice action) that says Call is ever pressed; it gives up after
 * a few seconds. done(true) when it pressed one; `seen` names what was there.
 */
func pressCallPrompt(done: @escaping (Bool, [String]) -> Void) {
    let words = ["call", "κλήση", "κλήσης"]
    var seen: [String] = []
    func attr(_ e: AXUIElement, _ a: String) -> String {
        var v: CFTypeRef?
        AXUIElementCopyAttributeValue(e, a as CFString, &v)
        return (v as? String) ?? ""
    }
    func isCall(_ s: String) -> Bool {
        let l = s.lowercased().trimmingCharacters(in: .whitespaces)
        return words.contains(l)
    }
    func search(_ e: AXUIElement, _ depth: Int) -> Bool {
        if depth > 12 { return false }
        let role = attr(e, kAXRoleAttribute)
        let title = attr(e, kAXTitleAttribute), desc = attr(e, kAXDescriptionAttribute)
        if role == kAXButtonRole as String {
            if !(title + desc).isEmpty { seen.append(title.isEmpty ? desc : title) }
            if isCall(title) || isCall(desc) { return click(e) }
        }
        // A notice's own actions ("Name:Call\nTarget:…").
        var names: CFArray?
        if AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String] {
            for n in list where n.hasPrefix("Name:") {
                let label = String(n.dropFirst(5).split(separator: "\n").first ?? "")
                seen.append(label)
                if isCall(label) { return AXUIElementPerformAction(e, n as CFString) == .success }
            }
        }
        var kids: CFTypeRef?
        AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids)
        for k in (kids as? [AXUIElement]) ?? [] where search(k, depth + 1) { return true }
        return false
    }
    /// A real click in the middle of the button — the notice ignores an
    /// accessibility "press" — with the pointer put back where it was.
    func click(_ e: AXUIElement) -> Bool {
        var p: CFTypeRef?, z: CFTypeRef?
        AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &p)
        AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &z)
        var pos = CGPoint.zero, size = CGSize.zero
        guard let p, let z, AXValueGetValue(p as! AXValue, .cgPoint, &pos), AXValueGetValue(z as! AXValue, .cgSize, &size), size.width > 0 else {
            return AXUIElementPerformAction(e, kAXPressAction as CFString) == .success
        }
        let at = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
        let back = CGEvent(source: nil)?.location ?? at
        let src = CGEventSource(stateID: .hidSystemState)
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(120_000) // the notice shows its buttons on hover
        CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: at, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(60_000)
        CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: at, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(60_000)
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: back, mouseButton: .left)?.post(tap: .cghidEventTap)
        return true
    }
    var tries = 0
    func attempt() {
        tries += 1
        seen = []
        let nc = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui").first
        if let pid = nc?.processIdentifier, search(AXUIElementCreateApplication(pid), 0) { return done(true, seen) }
        if tries >= 16 { return done(false, seen) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: attempt)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: attempt)
}

/**
 * The Mac's own microphone — used instead of Bluetooth headphones' one. When
 * AirPods are the microphone, macOS switches them into phone-call mode while
 * listening, and music or a video in them turns muffled and quiet; with the
 * built-in microphone they keep playing in full quality.
 */
func builtInMicrophone() -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
    for id in ids {
        var transport: UInt32 = 0, tsize = UInt32(MemoryLayout<UInt32>.size)
        var taddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(id, &taddr, 0, nil, &tsize, &transport) == noErr, transport == kAudioDeviceTransportTypeBuiltIn else { continue }
        var saddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var ssize: UInt32 = 0
        if AudioObjectGetPropertyDataSize(id, &saddr, 0, nil, &ssize) == noErr, ssize > 0 { return id }
    }
    return nil
}

/** Whether the system's microphone right now is a Bluetooth one (AirPods). */
func defaultMicIsBluetooth() -> Bool {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id: AudioDeviceID = 0, size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr else { return false }
    var transport: UInt32 = 0, tsize = UInt32(MemoryLayout<UInt32>.size)
    var taddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(id, &taddr, 0, nil, &tsize, &transport) == noErr else { return false }
    return transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
}

/** A microphone's ID that the audio APIs take: its unique name. */
func deviceUID(_ id: AudioDeviceID) -> CFString? {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var uid: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &uid) == noErr else { return nil }
    return uid?.takeRetainedValue()
}

// MARK: - The camera window

/**
 * "Take a look at my desk": a small window showing what the camera sees —
 * the desk webcam (a Logitech) when it's plugged in, else the Mac's own.
 * Nothing is described on its own; while the window is open, each question
 * asked with fn comes with a picture from it, so "how do I connect this?" is
 * answered about what's actually in front of the camera. Closed with its ✕,
 * "close the camera", or after a quarter of an hour.
 */
final class CameraPanel: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private var panel: NSPanel?
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "local.yonna.camera")
    private let lock = NSLock()
    private var latest: CIImage?
    private var ready = false
    private var closeTimer: Timer?
    var isOpen: Bool { panel?.isVisible == true }

    /// The Logitech desk camera when it's plugged in; otherwise the Mac's own
    /// front camera. Never the iPhone (Continuity Camera).
    private func pickCamera() -> AVCaptureDevice? {
        let all = AVCaptureDevice.DiscoverySession(deviceTypes: [.external, .builtInWideAngleCamera],
                                                   mediaType: .video, position: .unspecified).devices
            .filter { !$0.localizedName.localizedCaseInsensitiveContains("iphone") && $0.deviceType != .continuityCamera }
        return all.first { $0.localizedName.localizedCaseInsensitiveContains("logitech") }
            ?? all.first { $0.deviceType == .builtInWideAngleCamera }
    }

    /// done(nil) once it's showing, or why it couldn't.
    func show(_ done: @escaping (String?) -> Void) {
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async {
                guard ok else { return done("Yonna isn't allowed to use the camera — allow Yonna Keys in Privacy & Security, Camera.") }
                guard self.setUp() else { return done("I couldn't find a camera.") }
                self.window().orderFrontRegardless()
                self.queue.async { if !self.session.isRunning { self.session.startRunning() } }
                self.closeTimer?.invalidate()
                self.closeTimer = Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: false) { [weak self] _ in self?.hide() }
                done(nil)
            }
        }
    }

    func hide() {
        closeTimer?.invalidate()
        panel?.orderOut(nil)
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
        lock.lock(); latest = nil; lock.unlock()
    }

    /// Chosen afresh each time it opens, so a Logitech plugged in since is used.
    private func setUp() -> Bool {
        guard let cam = pickCamera() else { return false }
        let now = session.inputs.compactMap { ($0 as? AVCaptureDeviceInput)?.device.uniqueID }
        if now == [cam.uniqueID] { return true }
        guard let input = try? AVCaptureDeviceInput(device: cam) else { return false }
        session.beginConfiguration()
        session.inputs.forEach { session.removeInput($0) }
        session.sessionPreset = .high
        if session.canAddInput(input) { session.addInput(input) }
        if !ready {
            output.setSampleBufferDelegate(self, queue: queue)
            output.alwaysDiscardsLateVideoFrames = true
            if session.canAddOutput(output) { session.addOutput(output) }
            ready = true
        }
        session.commitConfiguration()
        return true
    }

    private func window() -> NSPanel {
        if let panel { return panel }
        let w: CGFloat = 340, h: CGFloat = 255
        let screen = NSScreen.main?.visibleFrame ?? .zero
        let p = NSPanel(contentRect: NSRect(x: screen.maxX - w - 20, y: screen.maxY - h - 20, width: w, height: h),
                        styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        p.level = .floating
        p.isMovableByWindowBackground = true
        p.backgroundColor = .clear
        p.hasShadow = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let view = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        view.wantsLayer = true
        view.layer?.cornerRadius = 16
        view.layer?.masksToBounds = true
        view.layer?.backgroundColor = NSColor(red: 0.04, green: 0.04, blue: 0.045, alpha: 1).cgColor
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer?.addSublayer(preview)
        let close = NSButton(title: "✕", target: self, action: #selector(closeClicked))
        close.isBordered = false
        close.font = .systemFont(ofSize: 13, weight: .medium)
        close.contentTintColor = .white
        close.wantsLayer = true
        close.layer?.backgroundColor = NSColor(white: 0, alpha: 0.45).cgColor
        close.layer?.cornerRadius = 12
        close.frame = NSRect(x: w - 34, y: h - 34, width: 24, height: 24)
        view.addSubview(close)
        p.contentView = view
        panel = p
        return p
    }

    @objc private func closeClicked() { hide() }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let px = CMSampleBufferGetImageBuffer(sample) else { return }
        let img = CIImage(cvPixelBuffer: px)
        lock.lock(); latest = img; lock.unlock()
    }

    /// The camera's picture now, as a JPEG file, for a question.
    func snapshot() -> URL? {
        lock.lock(); let img = latest; lock.unlock()
        guard let img, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yonna-camera-\(UUID().uuidString).jpg")
        do {
            try CIContext().writeJPEGRepresentation(of: img, to: url, colorSpace: space, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8])
            return url
        } catch { return nil }
    }
}

final class Ears {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    /// Recording only — an audio queue reads the microphone without touching
    /// the sound output. (An AVAudioEngine starts the output too, and macOS
    /// re-sets the headphones for it: music cut out and came back louder.)
    var queue: AudioQueueRef?
    let audioQueue = DispatchQueue(label: "local.yonna.ears")
    /// The recogniser's request now. Apple's recogniser ends a sentence at a
    /// long pause and starts over; while the key is still held, what was said
    /// so far is kept (`committed`) and a new request carries on listening —
    /// so the whole of what was said arrives together on release.
    private var _request: SFSpeechAudioBufferRecognitionRequest?
    private let lock = NSLock()
    var request: SFSpeechAudioBufferRecognitionRequest? {
        get { lock.lock(); defer { lock.unlock() }; return _request }
        set { lock.lock(); _request = newValue; lock.unlock() }
    }
    var task: SFSpeechRecognitionTask?
    var committed = ""
    var current = ""
    var text: String { [committed, current].filter { !$0.isEmpty }.joined(separator: " ") }
    var restarts = 0
    var finished: ((String) -> Void)?
    var partial: ((String) -> Void)?
    var level: ((Float) -> Void)?
    var lastError = ""

    private func newRequest() -> SFSpeechAudioBufferRecognitionRequest {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer?.supportsOnDeviceRecognition == true { req.requiresOnDeviceRecognition = true }
        req.addsPunctuation = true
        // Names it would otherwise mishear: the apps open now ("Claude", not
        // "clothing") and Yonna's own words.
        let open = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { $0.localizedName }
        req.contextualStrings = Array((open + ["Yonna", "Valorant", "Brave", "eSchool", "Spotify", "YouTube", "lights", "PC"]).prefix(100))
        return req
    }

    /// A recognition of what comes in from now on.
    private func listenOn() {
        guard let recognizer else { return }
        let req = newRequest()
        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, req === self.request else { return } // an earlier one, already kept
                let holding = self.finished == nil && self.queue != nil
                if let result {
                    let heard = result.bestTranscription.formattedString
                    // Started over without saying so (a pause): keep what came before.
                    if holding, self.current.count > 8, heard.count < self.current.count / 2,
                       !self.current.lowercased().hasPrefix(heard.lowercased()) {
                        self.committed = self.text
                    }
                    self.current = heard
                    self.partial?(self.text)
                    if result.isFinal { holding ? self.carryOn() : self.done() }
                }
                if error != nil { holding ? self.carryOn() : self.done() }
            }
        }
    }

    /// A sentence ended mid-press: keep it, and listen on.
    private func carryOn() {
        committed = text
        current = ""
        restarts += 1
        if restarts > 30 { return } // something is wrong with the recogniser: stop trying
        task?.cancel()
        listenOn()
    }

    func start(partial: @escaping (String) -> Void) -> Bool {
        stopNow()
        committed = ""
        current = ""
        restarts = 0
        self.partial = partial
        guard let recognizer, recognizer.isAvailable else {
            lastError = "speech recognition is unavailable right now"
            return false
        }
        // 16 kHz mono, which the recogniser likes; the queue converts to it.
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        var asbd = AudioStreamBasicDescription(mSampleRate: 16000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4, mFramesPerPacket: 1,
            mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var q: AudioQueueRef?
        let made = AudioQueueNewInputWithDispatchQueue(&q, &asbd, 0, audioQueue) { [weak self] aq, buf, _, _, _ in
            let bytes = Int(buf.pointee.mAudioDataByteSize)
            let frames = bytes / 4
            if frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)) {
                pcm.frameLength = AVAudioFrameCount(frames)
                memcpy(pcm.floatChannelData![0], buf.pointee.mAudioData, bytes)
                self?.request?.append(pcm)
                // Loudness for the box's wave.
                let ch = pcm.floatChannelData![0]
                var sum: Float = 0
                for i in stride(from: 0, to: frames, by: 2) { sum += ch[i] * ch[i] }
                let v = min(1, sqrt(sum / Float(max(1, frames / 2))) * 12)
                DispatchQueue.main.async { self?.level?(v) }
            }
            if self?.queue != nil { AudioQueueEnqueueBuffer(aq, buf, 0, nil) }
        }
        guard made == noErr, let q else {
            lastError = "no microphone is available right now"
            return false
        }
        // Headphones' microphone would put them in call mode: the Mac's own instead.
        if defaultMicIsBluetooth(), let mic = builtInMicrophone(), var uid = deviceUID(mic) {
            AudioQueueSetProperty(q, kAudioQueueProperty_CurrentDevice, &uid, UInt32(MemoryLayout<CFString>.size))
        }
        for _ in 0..<3 {
            var b: AudioQueueBufferRef?
            if AudioQueueAllocateBuffer(q, 3200, &b) == noErr, let b { AudioQueueEnqueueBuffer(q, b, 0, nil) }
        }
        queue = q
        listenOn()
        let started = AudioQueueStart(q, nil)
        guard started == noErr else {
            lastError = "the microphone wouldn't start (\(started))"
            stopQueue()
            task?.cancel()
            request = nil
            return false
        }
        return true
    }

    /** Stop listening; `then` gets the final words (or what was heard, after a moment). */
    func finish(_ then: @escaping (String) -> Void) {
        finished = then
        stopQueue()
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.done() }
    }

    private func done() {
        guard let f = finished else { return }
        finished = nil
        task?.cancel()
        task = nil
        request = nil
        f(text)
    }

    private func stopQueue() {
        guard let q = queue else { return }
        queue = nil
        AudioQueueStop(q, true)
        AudioQueueDispose(q, true)
    }

    func stopNow() {
        finished = nil
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        stopQueue()
    }
}

// MARK: - Speaking

/** The Mac's own voice through `say` — the Siri voice picked in Spoken
 *  Content, as Atticus speaks (AVSpeechSynthesizer cannot use Siri voices).
 *  Speaks an answer as it streams in: the first words at once, the rest by
 *  sentence, one `say` after another. */
final class Voice {
    var current: Process?
    var waiting: [String] = []
    var buffer = ""
    var first = true

    func reset() {
        waiting.removeAll()
        if let p = current, p.isRunning { p.terminate() }
        current = nil
        buffer = ""
        first = true
    }

    /** The next waiting line, once the one before has finished. */
    private func next() {
        guard current == nil, !waiting.isEmpty else { return }
        let line = waiting.removeFirst()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        p.arguments = ["--", line]
        p.terminationHandler = { [weak self] done in
            DispatchQueue.main.async {
                guard let self, self.current === done else { return }
                self.current = nil
                self.next()
            }
        }
        do {
            try p.run()
            current = p
        } catch {
            next()
        }
    }

    /** YONNA_QUIET=1 for tests: shown, not spoken. */
    let quiet = ProcessInfo.processInfo.environment["YONNA_QUIET"] == "1"
    /** Off from the box's voice button: answers are written, not spoken. Remembered. */
    var on = UserDefaults.standard.object(forKey: "voiceOn") as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(on, forKey: "voiceOn")
            if !on {
                waiting.removeAll()
                if let p = current, p.isRunning { p.terminate() }
                current = nil
            }
        }
    }
    var said: [String] = []

    private func say(_ s: String) {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        said.append(t)
        if !on { return }
        if quiet {
            FileHandle.standardError.write("[say] \(t)\n".data(using: .utf8)!)
            return
        }
        waiting.append(t)
        next()
    }

    func push(_ delta: String) {
        buffer += delta
        while let r = buffer.range(of: "[.!?](\\s|$)", options: .regularExpression), r.upperBound < buffer.endIndex || buffer.hasSuffix(" ") {
            say(String(buffer[..<r.upperBound]))
            buffer = String(buffer[r.upperBound...])
            first = false
        }
        // The first words need not wait for the end of a long sentence.
        if first, let r = buffer.range(of: "^[^,;:]+?[,;:]\\s", options: .regularExpression),
           buffer[..<r.upperBound].split(separator: " ").count >= 4 {
            say(String(buffer[..<r.upperBound]))
            buffer = String(buffer[r.upperBound...])
            first = false
        }
    }

    func end() {
        say(buffer)
        buffer = ""
    }

    func speak(_ s: String) {
        reset()
        say(s)
    }
}

// MARK: - The bridge, and the shortcut

final class Keys: NSObject, NSApplicationDelegate {
    let box = Box()
    let camera = CameraPanel()
    /** Zoom, Meet and Teams meetings: see meeting.swift. */
    let meeting = Meeting()
    let ears = Ears()
    let voice = Voice()
    var ws: URLSessionWebSocketTask?
    var connected = false
    var down = false
    /** The shortcut's modifier keys, to check they are still held (see watchRelease). */
    var hotKeyMods: NSEvent.ModifierFlags = [.option, .control]
    var releaseWatch: Timer?
    var path: [CGPoint] = []
    var sampler: Timer?
    var capture: Capture?
    /** The screenshot attempt is over — taken, or refused (no permission). */
    var captured = false
    var hotKey: EventHotKeyRef?
    var askId = ""
    /** A Yonna window is open (the bridge says so): the shortcut talks there. */
    var appOpen = false
    /** This press went to the window, not the box. */
    var viaApp = false
    var answer = ""
    var seq = 0
    var startingBrain = false
    var timers: [Timer] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        try? FileManager.default.createDirectory(at: TMP, withIntermediateDirectories: true)
        registerHotKey()
        connect()
        ears.level = { [weak self] v in self?.box.level(v) }
        meeting.watch()
        box.setVoice(voice.on)
        box.onVoice = { [weak self] in
            guard let self else { return }
            self.voice.on.toggle()
            self.box.setVoice(self.voice.on)
        }
        Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { _ in self.sweep() }
        sweep()
        // Asked once, up front, so the first press is not spent on prompts —
        // and only when not yet decided, never again after an answer.
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined { SFSpeechRecognizer.requestAuthorization { _ in self.writeStatus() } }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined { AVCaptureDevice.requestAccess(for: .audio) { _ in self.writeStatus() } }
        // Screen Recording: asked once, ever — asking at every start made macOS
        // show its "would like to record" box again and again.
        if !CGPreflightScreenCaptureAccess() && !UserDefaults.standard.bool(forKey: "askedScreen") {
            UserDefaults.standard.set(true, forKey: "askedScreen")
            _ = CGRequestScreenCaptureAccess()
        }
        writeStatus()
        // For testing without the keyboard or a microphone:
        // YONNA_DEMO="<what was said>" presses once and draws a loop.
        if let demo = ProcessInfo.processInfo.environment["YONNA_DEMO"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self.pressed()
                self.ears.stopNow()
                self.sampler?.invalidate()
                let c = NSEvent.mouseLocation
                self.path = (0...60).map { i in
                    let a = Double(i) / 60 * 2.1 * .pi
                    return CGPoint(x: c.x + 120 * cos(a), y: c.y + 80 * sin(a))
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    self.down = false
                    self.box.show(title: "Yonna · thinking", question: demo, answer: "")
                    self.finishPress(said: demo)
                }
            }
        }
    }

    /** What macOS has granted, in a file, so a missing permission can be seen
     *  rather than guessed at. */
    func writeStatus() {
        func name(_ s: Int) -> String { ["not asked yet", "restricted", "denied", "allowed"][min(max(s, 0), 3)] }
        let st: [String: Any] = [
            "microphone": name(AVCaptureDevice.authorizationStatus(for: .audio).rawValue),
            "speechRecognition": name(SFSpeechRecognizer.authorizationStatus().rawValue),
            "screenRecording": CGPreflightScreenCaptureAccess() ? "allowed" : "not allowed",
            "speechAvailable": SFSpeechRecognizer(locale: Locale(identifier: "en-US"))?.isAvailable ?? false,
            "lastScreenshotError": lastCaptureError,
            "lastScreenshotOK": capture != nil,
            "at": ISO8601DateFormatter().string(from: Date()),
        ]
        let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/Yonna/keys-status.json")
        if let d = try? JSONSerialization.data(withJSONObject: st, options: [.prettyPrinted, .sortedKeys]) { try? d.write(to: url) }
    }

    /** Exactly what is missing, and where to switch it on — or nil. */
    func missing() -> String? {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .denied, .restricted:
            return "Microphone is off for Yonna Keys. System Settings → Privacy & Security → Microphone → switch on Yonna Keys."
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in self.writeStatus() }
            return "Allow the Microphone for Yonna Keys in the box macOS just showed, then press again."
        default: break
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .denied, .restricted:
            return "Speech Recognition is off for Yonna Keys. System Settings → Privacy & Security → Speech Recognition → switch on Yonna Keys."
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { _ in self.writeStatus() }
            return "Allow Speech Recognition for Yonna Keys in the box macOS just showed, then press again."
        default: break
        }
        return nil
    }

    func sweep() {
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: TMP.path)) ?? [] {
            let u = TMP.appendingPathComponent(name)
            if let d = (try? fm.attributesOfItem(atPath: u.path))?[.modificationDate] as? Date,
               Date().timeIntervalSince(d) > 600 { try? fm.removeItem(at: u) }
        }
    }

    // MARK: Brain

    func connect() {
        var req = URLRequest(url: BRIDGE)
        req.setValue("http://localhost:5173", forHTTPHeaderField: "Origin")
        let task = URLSession.shared.webSocketTask(with: req)
        ws = task
        task.resume()
        receive(task)
    }

    func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, task === self.ws else { return }
                switch result {
                case .failure:
                    self.connected = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + (self.startingBrain ? 0.5 : 2)) { self.connect() }
                case .success(let m):
                    self.connected = true
                    self.startingBrain = false
                    if case .string(let s) = m { self.handle(s) }
                    self.receive(task)
                }
            }
        }
    }

    func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        ws?.send(.string(s)) { _ in }
    }

    /** Start the brain on its own — no window, no Chrome. */
    func startBrain() {
        guard !startingBrain else { return }
        startingBrain = true
        let info = Bundle.main.infoDictionary ?? [:]
        guard let repo = info["YonnaRepo"] as? String else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "cd \"$YONNA_REPO\" && exec node bridge/server.mjs >> \"$HOME/Library/Logs/Yonna.log\" 2>&1"]
        var env = ProcessInfo.processInfo.environment
        env["YONNA_REPO"] = repo
        // Started for a press, so it stops again after ten idle minutes.
        env["YONNA_IDLE_EXIT_MIN"] = "10"
        env["YONNA_BRIDGE_PORT"] = String(BRIDGE.port ?? 8787)
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:\(NSHomeDirectory())/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        try? p.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.startingBrain = false }
    }

    func handle(_ s: String) {
        guard let data = s.data(using: .utf8),
              let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = m["type"] as? String else { return }
        if type == "pages" { appOpen = (m["open"] as? Bool) ?? false; return }
        // The iPhone page's recording, saved by the bridge: what was said, as
        // text — with this Mac's own recogniser, on the Mac.
        if type == "transcribe", let id = m["id"] as? String, let path = m["path"] as? String {
            transcribeFile(path, hints: (m["hints"] as? [String]) ?? []) { [weak self] text in self?.send(["type": "transcribed", "id": id, "text": text]) }
            return
        }
        // The PC is at its sign-in screen: its password, typed here, passed on
        // to sign in once. Never kept.
        if type == "password", let id = m["id"] as? String {
            DispatchQueue.main.async { [weak self] in
                let a = NSAlert()
                a.messageText = "Your PC's password"
                a.informativeText = "Your PC is at its sign-in screen. Yonna signs you in with this once, then forgets it."
                let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
                field.placeholderString = "Password"
                a.accessoryView = field
                a.addButton(withTitle: "Sign In")
                a.addButton(withTitle: "Cancel")
                a.window.initialFirstResponder = field
                NSApp.activate(ignoringOtherApps: true)
                let ok = a.runModal() == .alertFirstButtonReturn
                self?.send(["type": "password", "id": id, "text": ok ? field.stringValue : NSNull()])
                field.stringValue = ""
            }
            return
        }
        // Yonna's AI asking to see ("what's on my desk?"): the camera window
        // opened (it stays, so they see what she sees) and a picture sent back.
        if type == "capture", let id = m["id"] as? String {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.camera.show { problem in
                    if let problem { return self.send(["type": "reply", "id": id, "error": problem]) }
                    // A moment for the camera to deliver its first picture.
                    func grab(_ tries: Int) {
                        if let url = self.camera.snapshot(), let data = try? Data(contentsOf: url) {
                            try? FileManager.default.removeItem(at: url)
                            return self.send(["type": "reply", "id": id, "data": data.base64EncodedString(), "mimeType": "image/jpeg"])
                        }
                        if tries <= 0 { return self.send(["type": "reply", "id": id, "error": "The camera didn't send a picture."]) }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { grab(tries - 1) }
                    }
                    grab(25)
                }
            }
            return
        }
        // For fixing the call press: what the notice is made of, pressing nothing.
        if type == "describeCall" {
            DispatchQueue.main.async { [weak self] in
                var lines: [String] = []
                func attr(_ e: AXUIElement, _ a: String) -> String {
                    var v: CFTypeRef?
                    AXUIElementCopyAttributeValue(e, a as CFString, &v)
                    return (v as? String) ?? ""
                }
                func walk(_ e: AXUIElement, _ d: Int) {
                    if d > 12 || lines.count > 80 { return }
                    var names: CFArray?
                    AXUIElementCopyActionNames(e, &names)
                    let acts = ((names as? [String]) ?? []).map { $0.replacingOccurrences(of: "\n", with: " | ") }
                    lines.append(String(repeating: " ", count: d) + [attr(e, kAXRoleAttribute), attr(e, kAXSubroleAttribute), attr(e, kAXTitleAttribute), attr(e, kAXDescriptionAttribute), attr(e, kAXIdentifierAttribute), acts.joined(separator: ",")].joined(separator: " · "))
                    var kids: CFTypeRef?
                    AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids)
                    for k in (kids as? [AXUIElement]) ?? [] { walk(k, d + 1) }
                }
                if let nc = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui").first {
                    walk(AXUIElementCreateApplication(nc.processIdentifier), 0)
                }
                self?.send(["type": "callDescribed", "lines": lines])
            }
            return
        }
        // A call Yonna just asked macOS to make: press its Call button.
        if type == "pressCall" {
            DispatchQueue.main.async { [weak self] in
                pressCallPrompt { ok, seen in self?.send(["type": "callPressed", "ok": ok, "seen": Array(Set(seen)).prefix(12).map { $0 }]) }
            }
            return
        }
        // An answer for the iPhone, as a sound file.
        if type == "speak", let id = m["id"] as? String, let text = m["text"] as? String, let path = m["path"] as? String {
            phoneVoice.speak(text, to: path) { [weak self] ok in self?.send(["type": "spoken", "id": id, "ok": ok]) }
            return
        }
        if let a = m["ask"] as? String, a != askId { return }
        switch type {
        case "text":
            let d = (m["delta"] as? String) ?? ""
            // Text from before and after a tool joins with no space: put it back.
            let delta = answer.range(of: "[.!?]$", options: .regularExpression) != nil && d.first?.isLetter == true ? " " + d : d
            answer += delta
            voice.push(delta)
            box.show(title: "Yonna", answer: answer)
        case "done":
            voice.end()
            if answer.isEmpty, let t = m["text"] as? String { answer = t; voice.speak(t) }
            box.show(title: "Yonna", answer: answer)
            box.hide(after: min(25, 6 + Double(answer.count) * 0.06))
        case "error":
            box.show(title: "Yonna", answer: (m["message"] as? String) ?? "Something went wrong.")
            box.hide(after: 6)
        case "blade":
            // A countdown with no window to show it: keep it here and say so when it ends.
            if let b = m["blade"] as? [String: Any], b["kind"] as? String == "timer", let ends = b["endsAt"] as? Double {
                setTimer(endsAt: ends)
            }
        default:
            break
        }
    }

    func setTimer(endsAt: Double) {
        let wait = endsAt / 1000 - Date().timeIntervalSince1970
        guard wait > 0 else { return }
        let t = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            self?.box.show(title: "Yonna · timer", question: "", answer: "Time's up.")
            self?.voice.speak("Time's up.")
            self?.box.hide(after: 10)
        }
        timers.append(t)
    }

    // MARK: Option+Space

    func registerHotKey() {
        var spec = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            let kind = GetEventKind(event)
            DispatchQueue.main.async {
                if kind == UInt32(kEventHotKeyPressed) { keys.pressed() } else { keys.released() }
            }
            return noErr
        }, 2, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x594F_4E41), id: 1) // "YONA"
        // The keys come from a settings file, so changing them never needs a
        // rebuild — a rebuilt app is a new app to macOS, and every permission
        // would have to be granted again.
        // ~/Library/Application Support/Yonna/keys.json:
        //   {"modifiers": ["option", "control"], "key": "space"}
        var mods = UInt32(optionKey | controlKey)
        var key = UInt32(kVK_Space)
        let cfg = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/Yonna/keys.json")
        if let data = try? Data(contentsOf: cfg),
           let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let m = j["modifiers"] as? [String] {
                mods = 0
                for name in m {
                    switch name.lowercased() {
                    case "option", "alt": mods |= UInt32(optionKey)
                    case "control", "ctrl": mods |= UInt32(controlKey)
                    case "command", "cmd": mods |= UInt32(cmdKey)
                    case "shift": mods |= UInt32(shiftKey)
                    default: break
                    }
                }
            }
            let keys: [String: Int] = ["space": kVK_Space, "return": kVK_Return, "y": kVK_ANSI_Y, "j": kVK_ANSI_J, "k": kVK_ANSI_K]
            if let k = (j["key"] as? String)?.lowercased(), let code = keys[k] { key = UInt32(code) }
        }
        // Hold fn on its own: {"key": "fn"}. Not a shortcut macOS can register,
        // so the key itself is watched instead — see watchFn.
        if let data = try? Data(contentsOf: cfg),
           let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           (j["key"] as? String)?.lowercased() == "fn" {
            hotKeyMods = [.function]
            watchFn()
            NSLog("YonnaKeys: hold fn to talk")
            return
        }
        var held: NSEvent.ModifierFlags = []
        if mods & UInt32(optionKey) != 0 { held.insert(.option) }
        if mods & UInt32(controlKey) != 0 { held.insert(.control) }
        if mods & UInt32(cmdKey) != 0 { held.insert(.command) }
        if mods & UInt32(shiftKey) != 0 { held.insert(.shift) }
        hotKeyMods = held
        let status = RegisterEventHotKey(key, mods, id, GetApplicationEventTarget(), 0, &hotKey)
        // eventHotKeyExistsErr: another app already owns these keys.
        NSLog("YonnaKeys: hotkey %@", status == noErr ? "registered" : "FAILED (\(status))")
    }

    var downAt = Date.distantPast

    /** A line in Yonna's log, for seeing what a press did. */
    func note(_ text: String) { send(["type": "log", "text": text]) }

    func pressed() {
        // Already held: a repeat. A press stuck "down" for over a minute lost
        // its release somewhere: ended now, so this one counts.
        if down && Date().timeIntervalSince(downAt) > 60 {
            note("fn: an old press was stuck — reset")
            down = false
        }
        guard !down else { return note("fn: ignored (already listening)") }
        down = true
        downAt = Date()
        watchRelease()
        // The Yonna window is open: talk to it there, no box.
        if connected && appOpen {
            note("fn: talking in the Yonna window")
            viaApp = true
            voice.reset()
            box.hide()
            send(["type": "ptt", "down": true])
            return
        }
        // Talking over her stops her.
        voice.reset()
        if !askId.isEmpty { send(["type": "interrupt"]) }
        askId = ""
        answer = ""
        box.clear()
        if !connected { startBrain() }
        writeStatus()
        if let why = missing() {
            note("fn: a permission is missing — \(why)")
            box.show(title: "Yonna · needs a permission", question: "", answer: why)
            box.hide(after: 12)
            down = false
            return
        }
        let listening = ears.start { [weak self] heard in
            guard let self, self.down else { return }
            self.box.show(title: "Yonna · listening", question: fixName(heard), answer: "")
        }
        box.show(title: "Yonna · listening",
                 question: listening ? "…" : "The microphone wouldn't start (\(ears.lastError)). Try again in a moment.",
                 answer: "")
        note(listening ? "fn: listening" : "fn: microphone wouldn't start (\(ears.lastError))")
        // The screen as it is now, and the mouse from here until release.
        capture = nil
        captured = false
        captureScreen { [weak self] c in
            self?.capture = c
            self?.captured = true
            self?.writeStatus()
        }
        path = [NSEvent.mouseLocation]
        sampler?.invalidate()
        sampler = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            let p = NSEvent.mouseLocation
            if let last = self.path.last, hypot(p.x - last.x, p.y - last.y) < 1 { return }
            self.path.append(p)
        }
        RunLoop.main.add(sampler!, forMode: .common)
    }

    func released() {
        guard down else { return }
        down = false
        releaseWatch?.invalidate()
        releaseWatch = nil
        if viaApp {
            viaApp = false
            send(["type": "ptt", "down": false])
            return
        }
        sampler?.invalidate()
        sampler = nil
        box.show(title: "Yonna · thinking")
        ears.finish { [weak self] said in self?.finishPress(said: said) }
    }

    /** macOS sometimes drops the "released" half of a shortcut. While a press
     *  lasts, look at the modifier keys (macOS reports those without any
     *  permission; reading Space itself would need Input Monitoring, and
     *  without it always says "up"). Once they are let go, the press is over. */
    // MARK: Hold fn

    var fnIsDown = false
    var fnHold: DispatchWorkItem?
    /** Another key was pressed with fn (fn+Delete, fn+arrows…): not a talk. */
    var fnWithKey = false
    var fnPoll: Timer?

    /**
     * Holding fn on its own is the shortcut. With Accessibility allowed, macOS
     * reports the fn key itself (key code 63) and any key pressed with it; it
     * is asked for once. Until then the fn flag is checked twenty times a
     * second — which cannot tell fn from fn+arrow, hence the short hold.
     */
    func watchFn() {
        let ask = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(ask)
        NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] e in
            if e.keyCode == 63 { self?.fn(e.modifierFlags.contains(.function)) }
        }
        NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] e in
            if e.keyCode == 63 { self?.fn(e.modifierFlags.contains(.function)) }
            return e
        }
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] _ in
            guard let self, self.fnIsDown, !self.down else { return }
            self.fnWithKey = true
            self.fnHold?.cancel()
        }
        // With Accessibility this only ever ends a press whose "up" macOS lost
        // (which left fn looking held and every later press ignored). It never
        // starts one: macOS marks arrow keys and others as "fn" too, and holding
        // one used to open the box.
        fnPoll = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self else { return }
            let down = CGEventSource.flagsState(.combinedSessionState).contains(.maskSecondaryFn)
            if AXIsProcessTrusted() {
                if !down && self.fnIsDown { self.fn(false) }
            } else if down != self.fnIsDown {
                self.fn(down)
            }
        }
        RunLoop.main.add(fnPoll!, forMode: .common)
    }

    func fn(_ isDown: Bool) {
        guard isDown != fnIsDown else { return }
        fnIsDown = isDown
        fnHold?.cancel()
        if isDown {
            fnWithKey = false
            // Held a moment, so a quick tap of fn (or fn with another key) is not a talk.
            let w = DispatchWorkItem { [weak self] in
                guard let self, self.fnIsDown, !self.fnWithKey else { return }
                self.pressed()
            }
            fnHold = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: w)
        } else if down {
            released()
        }
    }

    func watchRelease() {
        releaseWatch?.invalidate()
        // Only once they have been seen held: if macOS ever hides the keys'
        // state, this stays out of the way and the normal release ends it.
        var seen = false
        releaseWatch = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            guard let self, self.down else { return }
            let held = NSEvent.modifierFlags.isSuperset(of: self.hotKeyMods)
            if held { seen = true } else if seen { self.released() }
        }
        RunLoop.main.add(releaseWatch!, forMode: .common)
    }

    func finishPress(said raw: String) {
        let said = fixName(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        // Pressed and let go without a word: just close the box.
        guard !said.isEmpty else {
            box.hide()
            return
        }
        // The camera window: opened or closed, nothing more said.
        let l = said.lowercased()
        if l.range(of: #"\b(close|hide|turn off|stop)( the)? camera\b|\bcamera off\b|\bstop (looking|watching)\b"#, options: .regularExpression) != nil {
            camera.hide()
            box.show(title: "Yonna", answer: "Okay.")
            voice.speak("Okay.")
            box.hide(after: 2)
            return
        }
        if l.range(of: #"\b(take a look|look|have a look|watch)( at)? (my|the) (desk|table)\b|\bshow me (my|the) (desk|camera)\b|\b(open|turn on)( the)? camera\b|\bcamera on\b"#, options: .regularExpression) != nil {
            camera.show { [weak self] problem in
                let line = problem ?? "Okay, I can see it."
                self?.box.show(title: "Yonna", answer: line)
                self?.voice.speak(line)
                self?.box.hide(after: problem == nil ? 2 : 8)
            }
            return
        }
        box.show(title: "Yonna · thinking", question: said, answer: "")
        let pts = path
        // The screenshot may still be finishing, and the brain may still be starting.
        func go(_ tries: Int) {
            if (!captured || !connected) && tries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { go(tries - 1) }
                return
            }
            guard connected else {
                box.show(title: "Yonna", answer: "Couldn't reach Yonna's brain. Try again in a moment.")
                box.hide(after: 6)
                return
            }
            if camera.isOpen, let shot = camera.snapshot() {
                // The camera window is open: what it sees comes with the question.
                var v: [String: Any] = ["type": "vision", "image": shot.path,
                    "note": "The first picture is from the camera window the user opened, pointed at their desk, taken just now. " +
                        "Use it when they ask about something in front of them — how to connect or set up a thing, what something is. " +
                        "Don't describe it unless that's what they asked." + (capture != nil ? " The second picture is their screen." : "")]
                if let cap = capture, let a = annotate(cap, path: pts) { v["crop"] = a.image.path }
                send(v)
            } else if let cap = capture, let a = annotate(cap, path: pts) {
                var v: [String: Any] = ["type": "vision", "image": a.image.path, "note": a.note]
                if let c = a.crop { v["crop"] = c.path }
                send(v)
            }
            ask(said)
        }
        go(150)
    }

    /** Simple things first, with no AI (the bridge's /instant); the rest to her. */
    func ask(_ said: String) {
        var req = URLRequest(url: URL(string: "http://localhost:\(BRIDGE.port ?? 8787)/instant")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": said])
        req.timeoutInterval = 480 // the PC may need turning on, and signing in, first
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if let data, let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   m["handled"] as? Bool == true {
                    let line = (m["say"] as? String) ?? "Done."
                    if let b = m["blade"] as? [String: Any], let ends = b["endsAt"] as? Double { self.setTimer(endsAt: ends) }
                    self.box.show(title: "Yonna", answer: line.isEmpty ? "Done." : line)
                    if !line.isEmpty { self.voice.speak(line) }
                    self.box.hide(after: 6)
                    return
                }
                self.seq += 1
                self.askId = "k\(self.seq)"
                self.answer = ""
                self.send(["type": "ask", "text": said, "id": self.askId])
            }
        }.resume()
    }
}

// One copy only.
let mine = Bundle.main.bundleIdentifier ?? "local.yonna.keys"
if NSRunningApplication.runningApplications(withBundleIdentifier: mine).count > 1 { exit(0) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let keys = Keys()
app.delegate = keys
app.run()
