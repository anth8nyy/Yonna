import AppKit
import AVFoundation
import Speech
import WebKit

/*
 * Yonna Window: Yonna's main window as a native Mac app, in place of an
 * app-style Chrome window — so it can sit on real Mac glass, the way Atticus
 * does. The page itself is the same React page (http://localhost:5173),
 * shown in a WKWebView with a see-through background over an
 * NSVisualEffectView.
 *
 * WebKit has no speech recognition of its own, so this app provides it: the
 * Mac's SFSpeechRecognizer, offered to the page as `webkitSpeechRecognition`
 * with the same shape Chrome's has (start, stop, abort; onstart, onresult,
 * onerror, onend; results[i][0].transcript and isFinal). The page needs no
 * other changes.
 *
 * It also answers the welcome screen: what this window may use (microphone,
 * speech recognition, camera) and asking for it.
 */

let PAGE = URL(string: ProcessInfo.processInfo.environment["YONNA_URL"] ?? "http://localhost:5173")!

/** ~/Library/Logs/Yonna Window.log: listening starts and errors, page warnings. */
func wlog(_ line: String) {
    let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Yonna Window.log")
    let data = Data("\(ISO8601DateFormatter().string(from: Date())) \(line)\n".utf8)
    if let h = try? FileHandle(forWritingTo: url) {
        h.seekToEndOfFile()
        h.write(data)
        try? h.close()
    } else {
        try? data.write(to: url)
    }
}

// MARK: - Speech recognition for the page

final class Ears: NSObject {
    weak var web: WKWebView?
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var running = false
    /** Index of the current result in the page's `results` list. */
    private var index = 0
    private var session = 0
    /** She is speaking: the microphone would hear her own voice and take it
     *  for yours, round and round. Nothing is recognised until she stops. */
    private var held = false
    private var resume: DispatchWorkItem?

    /** Called as she starts and stops speaking. Stopping waits a beat for the
     *  room to go quiet, then listens fresh — nothing of her voice carried over. */
    func hold(_ on: Bool) {
        resume?.cancel()
        if on {
            guard !held else { return }
            held = true
            session += 1
            task?.cancel()
            request?.endAudio()
            task = nil
            request = nil
        } else {
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.held else { return }
                self.held = false
                guard self.running else { return }
                self.index += 1
                self.begin()
            }
            resume = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: work)
        }
    }

    private func emit(_ js: String) {
        DispatchQueue.main.async { self.web?.evaluateJavaScript(js) }
    }

    func start(lang asked: String) {
        guard !running else { return }
        // English always as en-US: the Mac often has no recognition files for
        // en-GB ("No Assistant asset"), and then hears nothing at all. Atticus
        // does the same.
        let lang = asked.lowercased().hasPrefix("en") ? "en-US" : asked
        wlog("listen start (\(asked) -> \(lang)), speech \(SFSpeechRecognizer.authorizationStatus().rawValue), mic \(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)")
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
                SFSpeechRecognizer.requestAuthorization { _ in }
            }
            emit("window.__yonnaEars.error('not-allowed')")
            return
        }
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let recognizer, recognizer.isAvailable else {
            wlog("recognizer unavailable for \(lang)")
            emit("window.__yonnaEars.error('service-not-allowed')")
            return
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            emit("window.__yonnaEars.error('audio-capture')")
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
            self?.request?.append(buf)
        }
        engine.prepare()
        do { try engine.start() } catch {
            wlog("microphone would not start: \(error)")
            emit("window.__yonnaEars.error('audio-capture')")
            return
        }
        running = true
        index = 0
        session += 1
        emit("window.__yonnaEars.started()")
        begin()
    }

    /** One recognition task. When it finishes a phrase, the next begins, so
     *  listening is continuous, as Chrome's `continuous = true` is. */
    private func begin() {
        guard running, !held, let recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        let mine = session
        let at = index
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self, mine == self.session, self.running else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                let data = try? JSONSerialization.data(withJSONObject: [text])
                let json = String(data: data ?? Data("[\"\"]".utf8), encoding: .utf8) ?? "[\"\"]"
                self.emit("window.__yonnaEars.result(\(at), \(json)[0], \(result.isFinal))")
                if result.isFinal { self.next(from: at) }
            } else if let error {
                let code = (error as NSError).code
                // 1110 = nothing was said; anything else is worth knowing.
                if code != 1110 && code != 216 && code != 301 { wlog("recognition error \(code): \(error.localizedDescription)") }
                // A pause with nothing said ends a task with an error: just go on
                // (after a beat, so a recogniser that keeps failing cannot spin).
                self.next(from: at, after: 0.3)
            }
        }
    }

    private func next(from at: Int, after delay: Double = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard self.running, !self.held, self.index == at else { return }
            self.request?.endAudio()
            self.task = nil
            self.index += 1
            self.begin()
        }
    }

    func stop(abort: Bool) {
        guard running else { return }
        running = false
        session += 1
        if abort { task?.cancel() } else { request?.endAudio() }
        task = nil
        request = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        emit("window.__yonnaEars.ended()")
    }
}

/** The page side of it: a `webkitSpeechRecognition` that talks to Ears. */
let SHIM = """
(() => {
  let live = null
  const results = []
  class Rec {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US' }
    start() {
      if (live && live !== this) live.abort()
      live = this; results.length = 0
      window.webkit.messageHandlers.ears.postMessage({ op: 'start', lang: this.lang || 'en-US' })
    }
    stop() { if (live === this) window.webkit.messageHandlers.ears.postMessage({ op: 'stop' }) }
    abort() { if (live === this) window.webkit.messageHandlers.ears.postMessage({ op: 'abort' }) }
  }
  window.__yonnaEars = {
    started() { live?.onstart?.({}) },
    result(i, text, final) {
      const r = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: final })
      results[i] = r
      const list = results.slice()
      live?.onresult?.({ resultIndex: i, results: list })
    },
    error(code) { const l = live; l?.onerror?.({ error: code }); live = null; l?.onend?.({}) },
    ended() { const l = live; live = null; l?.onend?.({}) },
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = Rec
  // Warnings and errors to ~/Library/Logs/Yonna Window.log, for fixing things.
  for (const k of ['warn', 'error']) {
    const orig = console[k].bind(console)
    console[k] = (...a) => {
      try { window.webkit.messageHandlers.log.postMessage(k + ': ' + a.map(String).join(' ')) } catch {}
      orig(...a)
    }
  }
  window.addEventListener('error', (e) => {
    try { window.webkit.messageHandlers.log.postMessage('error: ' + e.message + ' at ' + e.filename + ':' + e.lineno) } catch {}
  })
  document.documentElement.classList.add('native')
})()
"""

// MARK: - Window

/** A strip along the top you can drag the window by (the page would
 *  otherwise take those clicks); double-click zooms, as a title bar does. */
final class DragBar: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with e: NSEvent) {
        if e.clickCount == 2 { window?.zoom(nil) } else { window?.performDrag(with: e) }
    }
}

final class App: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply,
    WKUIDelegate, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let ears = Ears()
    /** Her voice: `say`, the Mac's Siri voice. One line at a time. */
    var saying: Process?
    func log(_ line: String) { wlog(line) }

    func applicationDidFinishLaunching(_ n: Notification) {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.addUserScript(WKUserScript(source: SHIM, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(self, name: "ears")
        cfg.userContentController.add(self, name: "log")
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Yonna"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isMovableByWindowBackground = false
        window.delegate = self
        window.setFrameAutosaveName("YonnaWindow")
        window.minSize = NSSize(width: 520, height: 420)

        // The glass: the desktop shows through, blurred, as on Atticus.
        let glass = NSVisualEffectView(frame: frame)
        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.appearance = NSAppearance(named: .darkAqua)
        glass.autoresizingMask = [.width, .height]

        web = WKWebView(frame: glass.bounds, configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")
        web.autoresizingMask = [.width, .height]
        web.uiDelegate = self
        web.navigationDelegate = self
        glass.addSubview(web)
        // Across the top, between the window buttons and the corners' own controls.
        let bar = DragBar(frame: NSRect(x: 80, y: glass.bounds.height - 30, width: glass.bounds.width - 300, height: 30))
        bar.autoresizingMask = [.width, .minYMargin]
        glass.addSubview(bar)
        window.contentView = glass
        ears.web = web

        web.load(URLRequest(url: PAGE))
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(web)
        NSApp.activate(ignoringOtherApps: true)
        buildMenu()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    /** Edit and window menus, so ⌘C/⌘V/⌘Q/⌘W/⌘R work as in any Mac app. */
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Yonna", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        viewItem.submenu = view
        NSApp.mainMenu = main
    }

    @objc func reload() { web.reload() }

    // The page's speech recognition.
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if m.name == "log" {
            log(String(describing: m.body))
            return
        }
        guard m.name == "ears", let b = m.body as? [String: Any], let op = b["op"] as? String else { return }
        switch op {
        case "start": ears.start(lang: (b["lang"] as? String) ?? "en-US")
        case "stop": ears.stop(abort: false)
        default: ears.stop(abort: true)
        }
    }

    // The welcome screen: what this window may use, and asking for it.
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let b = m.body as? [String: Any] ?? [:]
        func status() -> [String: String] {
            func av(_ t: AVMediaType) -> String {
                switch AVCaptureDevice.authorizationStatus(for: t) {
                case .authorized: return "allowed"
                case .notDetermined: return "ask"
                default: return "denied"
                }
            }
            let speech: String
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: speech = "allowed"
            case .notDetermined: speech = "ask"
            default: speech = "denied"
            }
            return ["microphone": av(.audio), "speech": speech, "camera": av(.video)]
        }
        switch b["op"] as? String {
        case "request":
            let what = b["what"] as? String ?? ""
            let done = { DispatchQueue.main.async { replyHandler(status(), nil) } }
            switch what {
            case "microphone": AVCaptureDevice.requestAccess(for: .audio) { _ in done() }
            case "camera": AVCaptureDevice.requestAccess(for: .video) { _ in done() }
            case "speech": SFSpeechRecognizer.requestAuthorization { _ in done() }
            default: done()
            }
        case "open":
            if let s = b["url"] as? String, let u = URL(string: s) { NSWorkspace.shared.open(u) }
            replyHandler(true, nil)
        // Speak one line; the reply comes when it has been said (true) or was
        // cut off or failed (false). A new line first silences any still going.
        case "say":
            let text = (b["text"] as? String) ?? ""
            if let p = saying, p.isRunning { p.terminate() }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
            p.arguments = ["--", text]
            p.terminationHandler = { [weak self] done in
                let ok = done.terminationStatus == 0 && done.terminationReason == .exit
                DispatchQueue.main.async {
                    if self?.saying === done {
                        self?.saying = nil
                        self?.ears.hold(false)
                    }
                    replyHandler(ok, nil)
                }
            }
            do {
                ears.hold(true)
                try p.run()
                saying = p
            } catch {
                log("say failed: \(error)")
                replyHandler(false, nil)
            }
        case "shush":
            if let p = saying, p.isRunning { p.terminate() }
            saying = nil
            ears.hold(false)
            replyHandler(true, nil)
        default:
            replyHandler(status(), nil)
        }
    }

    // Microphone and camera for the page (its level meter, the hand camera).
    func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "localhost" || origin.host == "127.0.0.1" ? .grant : .deny)
    }

    // Links to anything but Yonna open in the normal browser.
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, let host = u.host, host != PAGE.host, action.targetFrame?.isMainFrame ?? true {
            NSWorkspace.shared.open(u)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    // The page failed to load (the servers are still starting): try again.
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { w.load(URLRequest(url: PAGE)) }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
