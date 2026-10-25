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
final class Ears {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    let engine = AVAudioEngine()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var text = ""
    var finished: ((String) -> Void)?
    var partial: ((String) -> Void)?
    var level: ((Float) -> Void)?
    var lastError = ""

    func start(partial: @escaping (String) -> Void) -> Bool {
        stopNow()
        text = ""
        self.partial = partial
        guard let recognizer, recognizer.isAvailable else {
            lastError = "speech recognition is unavailable right now"
            return false
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        req.addsPunctuation = true
        request = req
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
            req.append(buf)
            // Loudness for the box's wave.
            if let ch = buf.floatChannelData?[0] {
                let n = Int(buf.frameLength)
                var sum: Float = 0
                for i in stride(from: 0, to: n, by: 4) { sum += ch[i] * ch[i] }
                let rms = sqrt(sum / Float(max(1, n / 4)))
                let v = min(1, rms * 12)
                DispatchQueue.main.async { self?.level?(v) }
            }
        }
        engine.prepare()
        do { try engine.start() } catch {
            lastError = error.localizedDescription
            return false
        }
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let result {
                    self.text = result.bestTranscription.formattedString
                    self.partial?(self.text)
                    if result.isFinal { self.done() }
                }
                if error != nil { self.done() }
            }
        }
        return true
    }

    /** Stop listening; `then` gets the final words (or what was heard, after a moment). */
    func finish(_ then: @escaping (String) -> Void) {
        finished = then
        request?.endAudio()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
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

    func stopNow() {
        finished = nil
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
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

    func pressed() {
        // Already held: a repeat. (A press whose release never arrived is
        // ended by watchRelease, so it cannot block this one.)
        guard !down else { return }
        down = true
        watchRelease()
        // The Yonna window is open: talk to it there, no box.
        if connected && appOpen {
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
        fnPoll = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self, !AXIsProcessTrusted() else { return }
            let down = CGEventSource.flagsState(.combinedSessionState).contains(.maskSecondaryFn)
            if down != self.fnIsDown { self.fn(down) }
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
            if let cap = capture, let a = annotate(cap, path: pts) {
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
        req.timeoutInterval = 6
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
