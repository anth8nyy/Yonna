import AppKit
import AVFoundation
import CoreMedia
import FoundationModels
import ScreenCaptureKit
import Speech
import WebKit

/*
 * Meetings: Yonna notices a Zoom, Google Meet or Teams meeting and offers a
 * glass window with three things she can do —
 *
 *   Translate  what the others say, into Greek
 *   Answer     suggest what to say when someone asks a question
 *   Save       the conversation, as a Word document
 *
 * Save goes with either of the others; Translate and Answer not together.
 *
 * Private by design: nothing from a meeting goes to Claude or anywhere else.
 * Only the meeting's own sound is heard — the microphone is never opened, so
 * nothing the user says is heard, written or shown — with Apple's speech
 * recognition on this Mac only, answers come from Apple's
 * on-device model, Greek from a translation model running locally
 * (bridge/translator.mjs), and the Word file is made by macOS's own textutil.
 * The window is hidden from screen sharing.
 */

/** ~/Library/Logs/Yonna Meeting.log: what the meeting window did (never what
 *  was said), for fixing it. */
func mlog(_ line: String) {
    let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Yonna Meeting.log")
    let data = Data("\(ISO8601DateFormatter().string(from: Date())) \(line)\n".utf8)
    if let h = try? FileHandle(forWritingTo: url) {
        h.seekToEndOfFile(); h.write(data); try? h.close()
    } else {
        try? data.write(to: url)
    }
}

/** Hears one side of the meeting — "Them" (the meeting's sound) or "You" (the
 *  microphone) — with Apple's SpeechAnalyzer, which only ever runs on the Mac.
 *  As Atticus does it (github.com/SaarthurR/atticus-mac, MIT). */
final class Transcriber {
    let who: String
    var onText: ((_ id: String, _ text: String, _ final: Bool) -> Void)?
    var feed: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzer: SpeechAnalyzer?
    private var reading: Task<Void, Never>?
    private var analyzing: Task<Void, Never>?
    private var count = 1

    init(_ who: String) { self.who = who }

    /** Starts listening; returns the audio format to feed it, or nil. */
    func start() async throws -> AVAudioFormat? {
        let tr = SpeechTranscriber(locale: Locale(identifier: "en-US"), preset: .progressiveTranscription)
        // Apple's speech model for English, installed once if it is missing.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [tr]) { try await request.downloadAndInstall() }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [tr]) else { return nil }
        let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
        self.feed = feed
        let an = SpeechAnalyzer(modules: [tr])
        analyzer = an
        let who = self.who
        reading = Task { [weak self] in
            do {
                for try await result in tr.results {
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard let self, !text.isEmpty else { continue }
                    let id = "\(who)-\(self.count)"
                    if result.isFinal { self.count += 1 }
                    self.onText?(id, text, result.isFinal)
                }
            } catch {
                mlog("\(who): transcription stopped: \(error.localizedDescription)")
            }
        }
        analyzing = Task {
            do { try await an.start(inputSequence: stream) } catch { mlog("\(who): analyzer stopped: \(error.localizedDescription)") }
        }
        mlog("\(who): listening at \(format.sampleRate) Hz")
        return format
    }

    func stop() {
        feed?.finish()
        feed = nil
        let an = analyzer
        analyzer = nil
        Task { try? await an?.finalizeAndFinishThroughEndOfInput() }
        reading = nil
        analyzing = nil
    }
}

/** Both sides at once from one ScreenCaptureKit stream: the meeting's sound
 *  (.audio) and the microphone (.microphone), each converted to the format
 *  its transcriber wants. As Atticus's MeetingAudio does. */
final class MeetingAudio: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var themFeed: AsyncStream<AnalyzerInput>.Continuation?
    private var youFeed: AsyncStream<AnalyzerInput>.Continuation?
    private var themFormat: AVAudioFormat?
    private var youFormat: AVAudioFormat?
    private var converters: [String: (from: AVAudioFormat, conv: AVAudioConverter?)] = [:]
    private let queue = DispatchQueue(label: "yonna.meeting.audio")
    private var logged: Set<String> = []

    func start(them: (AVAudioFormat, AsyncStream<AnalyzerInput>.Continuation),
               you: (AVAudioFormat, AsyncStream<AnalyzerInput>.Continuation)?) async throws {
        themFormat = them.0; themFeed = them.1
        youFormat = you?.0; youFeed = you?.1
        let all = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = all.displays.first else { throw NSError(domain: "Meeting", code: 1) }
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.captureMicrophone = you != nil
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.showsCursor = false
        let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: self)
        stream = s
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        if you != nil { try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
        try await s.startCapture()
    }

    func stop() {
        let s = stream
        stream = nil
        Task { try? await s?.stopCapture() }
        queue.async {
            self.themFeed = nil
            self.youFeed = nil
            self.converters = [:]
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { mlog("meeting sound stopped: \(error.localizedDescription)") }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio || type == .microphone, sample.isValid, let desc = sample.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc), let source = AVAudioFormat(streamDescription: asbd),
              let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(sample.numSamples)) else { return }
        buffer.frameLength = buffer.frameCapacity
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(sample.numSamples), into: buffer.mutableAudioBufferList) == noErr else { return }
        let side = type == .microphone ? "You" : "Them"
        if !logged.contains(side) { logged.insert(side); mlog("\(side): sound arriving") }
        guard let feed = side == "You" ? youFeed : themFeed, let want = side == "You" ? youFormat : themFormat else { return }
        if converters[side]?.from != source {
            converters[side] = (source, source == want ? nil : AVAudioConverter(from: source, to: want))
        }
        guard let conv = converters[side]?.conv else {
            feed.yield(AnalyzerInput(buffer: buffer))
            return
        }
        guard let out = AVAudioPCMBuffer(pcmFormat: want, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * want.sampleRate / source.sampleRate) + 1) else { return }
        var given = false
        var error: NSError?
        conv.convert(to: out, error: &error) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return buffer
        }
        if error == nil && out.frameLength > 0 { feed.yield(AnalyzerInput(buffer: out)) }
    }
}

/** Greek, from bridge/translator.mjs on this Mac. */
final class Greek {
    private var proc: Process?
    private var input: FileHandle?
    var onText: ((_ id: String, _ text: String) -> Void)?
    var onReady: ((Bool, String?) -> Void)?
    private var pending = Data()

    func start() {
        mlog("translator: starting (already running: \(proc != nil))")
        guard proc == nil else { return }
        guard let repo = Bundle.main.infoDictionary?["YonnaRepo"] as? String else {
            onReady?(false, "Yonna's folder is not known.")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", "cd \"$YONNA_REPO\" && exec node bridge/translator.mjs 2>>\"$HOME/Library/Logs/Yonna Translator.log\""]
        var env = ProcessInfo.processInfo.environment
        env["YONNA_REPO"] = repo
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:\(NSHomeDirectory())/.local/bin:/usr/bin:/bin"
        p.environment = env
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            guard let self, !d.isEmpty else { return }
            self.pending.append(d)
            while let nl = self.pending.firstIndex(of: 0x0A) {
                let line = self.pending.subdata(in: self.pending.startIndex..<nl)
                self.pending.removeSubrange(self.pending.startIndex...nl)
                guard let m = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    if m["ready"] != nil { self.onReady?(true, nil) }
                    if let id = m["id"] as? String, let t = m["text"] as? String { self.onText?(id, t) }
                }
            }
        }
        p.terminationHandler = { [weak self] done in
            mlog("translator: exited (\(done.terminationStatus), \(done.terminationReason == .uncaughtSignal ? "signal" : "exit"))")
            DispatchQueue.main.async { self?.proc = nil }
        }
        do {
            try p.run()
            proc = p
            input = inPipe.fileHandleForWriting
            mlog("translator: process \(p.processIdentifier)")
        } catch {
            onReady?(false, "The translator would not start.")
        }
    }

    func translate(id: String, text: String) {
        guard let input, let d = try? JSONSerialization.data(withJSONObject: ["id": id, "text": text]) else { return }
        input.write(d + Data("\n".utf8))
    }

    func stop() {
        proc?.terminate()
        proc = nil
        input = nil
    }
}

/** A strip along the top to drag the window by. */
final class MeetingDragBar: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with e: NSEvent) { window?.performDrag(with: e) }
}

final class Meeting: NSObject, WKScriptMessageHandler, NSWindowDelegate {
    var window: NSWindow?
    var web: WKWebView?
    var ready = false
    var queued: [String] = []

    let them = Transcriber("Them")
    let you = Transcriber("You")
    var audio: MeetingAudio?
    let greek = Greek()
    var answerer: LanguageModelSession?

    var app = ""
    var running = false
    var modes: Set<String> = []
    var startedAt = Date()
    /** Finished lines, in order, for the file and for answers. */
    var lines: [(at: Date, who: String, text: String, id: String)] = []
    var greekFor: [String: String] = [:]
    var file: URL?
    var saveTimer: Timer?
    var detectTimer: Timer?
    var lastSeen = Date.distantPast
    var offeredFor = ""
    /** A meeting window was really seen: only then does its going away end things. */
    var seenMeeting = false

    // MARK: Noticing a meeting

    func watch() {
        detectTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.check() }
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("local.yonna.meeting.open"), object: nil, queue: .main) { [weak self] _ in
            self?.show(app: self?.app.isEmpty == false ? self!.app : "your meeting")
        }
    }

    /** Which meeting is on screen, if any — from window titles alone. */
    static func meetingOnScreen() -> String? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let browsers = ["Google Chrome", "Safari", "Arc", "Microsoft Edge", "Brave Browser", "Firefox", "Opera", "Vivaldi"]
        for w in list {
            let owner = w[kCGWindowOwnerName as String] as? String ?? ""
            let name = w[kCGWindowName as String] as? String ?? ""
            if owner == "zoom.us", name.hasPrefix("Zoom Meeting") || name.hasPrefix("Zoom Webinar") || name == "Meeting" { return "Zoom" }
            if browsers.contains(owner), name.hasPrefix("Meet - ") || name.hasPrefix("Meet – ") || name.contains("meet.google.com") { return "Google Meet" }
            let teams = owner.contains("Teams") || (browsers.contains(owner) && name.contains("Microsoft Teams"))
            if teams, name.range(of: "meeting|call|Besprechung", options: [.regularExpression, .caseInsensitive]) != nil { return "Teams" }
        }
        return nil
    }

    func check() {
        if let found = Meeting.meetingOnScreen() {
            lastSeen = Date()
            seenMeeting = true
            app = found
            if offeredFor != found {
                offeredFor = found
                show(app: found)
            }
        } else if seenMeeting && Date().timeIntervalSince(lastSeen) > 15 {
            // The meeting window has been gone a while: it is over. A session
            // started by hand, with no meeting window, runs until Stop.
            seenMeeting = false
            if running { stop(reason: "The meeting ended.") }
            offeredFor = ""
        }
    }

    // MARK: The window

    func show(app name: String) {
        if window == nil { build() }
        send("ui.offer(\(json(["app": name, "running": running, "private": true])))")
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    private func build() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "meeting")
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let rect = NSRect(x: screen.maxX - 440, y: screen.maxY - 620, width: 420, height: 600)
        let w = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.title = "Yonna · Meeting"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isOpaque = false
        w.backgroundColor = .clear
        w.level = .floating
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        w.minSize = NSSize(width: 320, height: 300)
        w.isReleasedWhenClosed = false
        w.delegate = self
        // Never shown to the others when the screen is shared.
        w.sharingType = .none
        w.setFrameAutosaveName("YonnaMeeting")

        let glass = NSVisualEffectView(frame: NSRect(origin: .zero, size: rect.size))
        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.appearance = NSAppearance(named: .darkAqua)
        glass.autoresizingMask = [.width, .height]
        let v = WKWebView(frame: glass.bounds, configuration: cfg)
        v.setValue(false, forKey: "drawsBackground")
        v.autoresizingMask = [.width, .height]
        glass.addSubview(v)
        let bar = MeetingDragBar(frame: NSRect(x: 76, y: glass.bounds.height - 28, width: glass.bounds.width - 76, height: 28))
        bar.autoresizingMask = [.width, .minYMargin]
        glass.addSubview(bar)
        w.contentView = glass
        if let url = Bundle.main.url(forResource: "meeting", withExtension: "html") {
            v.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        window = w
        web = v
    }

    func windowWillClose(_ n: Notification) {
        if running { stop(reason: nil) }
    }

    private func json(_ o: Any) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8)
        return String(data: d, encoding: .utf8) ?? "{}"
    }

    private func send(_ js: String) {
        if ready { web?.evaluateJavaScript(js) } else { queued.append(js) }
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let b = m.body as? [String: Any], let op = b["op"] as? String else { return }
        switch op {
        case "ready":
            ready = true
            queued.forEach { web?.evaluateJavaScript($0) }
            queued.removeAll()
        case "start":
            var want = Set((b["modes"] as? [String]) ?? [])
            if want.contains("translate") && want.contains("answer") { want.remove("answer") }
            start(modes: want)
        case "stop":
            stop(reason: nil)
        // Clear: the window starts fresh and answers forget what came before;
        // the Word file still keeps the whole meeting.
        case "clear":
            contextFrom = lines.count
        case "open":
            if let file { NSWorkspace.shared.open(file) }
        case "close":
            window?.close()
        default: break
        }
    }

    // MARK: Listening

    func start(modes want: Set<String>) {
        mlog("start \(want.sorted()) running=\(running)")
        guard !running, !want.isEmpty else { return }
        modes = want
        running = true
        startedAt = Date()
        lines = []
        greekFor = [:]
        committed = [:]
        previous = [:]
        chunks = [:]
        group = nil
        groupOpen = false
        answeredWords = [:]
        contextFrom = 0
        file = nil
        answerer = nil

        let heard: (String, String, Bool) -> Void = { [weak self] id, text, final in
            DispatchQueue.main.async { self?.heard(id: id, text: text, final: final) }
        }
        them.onText = heard
        you.onText = heard
        Task { @MainActor in
            do {
                guard let themFormat = try await self.them.start(), let themFeed = self.them.feed else {
                    self.send("ui.error(\(self.json(["text": "Speech recognition isn't available on this Mac."])))")
                    return
                }
                // Only the meeting's own sound, from inside the Mac. The microphone
                // is never opened: what the user says is not heard, written or shown.
                guard self.running else { return }
                let a = MeetingAudio()
                self.audio = a
                try await a.start(them: (themFormat, themFeed), you: nil)
                mlog("meeting sound: listening")
            } catch {
                mlog("could not listen: \(error.localizedDescription)")
                self.send("ui.error(\(self.json(["text": "Couldn't listen to the meeting: \(error.localizedDescription)"])))")
            }
        }

        if modes.contains("translate") {
            greek.onText = { [weak self] id, t in
                self?.greekFor[id] = t
                self?.send("ui.greek(\(self?.json(["id": id, "text": t]) ?? "{}"))")
            }
            greek.onReady = { [weak self] ok, why in
                mlog("translator: \(ok ? "ready" : (why ?? "failed"))")
                self?.send("ui.note(\(self?.json(["text": ok ? "Greek is ready." : (why ?? "Translation is not available.")]) ?? "{}"))")
            }
            greek.start()
        }
        if modes.contains("answer") {
            answerer = LanguageModelSession(instructions: Meeting.answerRules)
            answerer?.prewarm()
        }
        if modes.contains("save") {
            saveTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.save() }
        }
        send("ui.started(\(json(["modes": Array(modes), "greekOnly": modes.contains("translate"), "answerMode": modes.contains("answer")])))")
    }

    func stop(reason: String?) {
        guard running else { return }
        running = false
        audio?.stop()
        audio = nil
        them.stop()
        you.stop()
        greek.stop()
        saveTimer?.invalidate()
        saveTimer = nil
        if modes.contains("save") { save() }
        send("ui.stopped(\(json(["reason": reason ?? "", "file": file?.path ?? ""])))")
        if window?.isVisible != true, file != nil { show(app: app) }
    }

    /** A line of speech, still changing (partial) or settled (final). */
    func heard(id: String, text: String, final: Bool) {
        guard running else { return }
        // Live answers too: once a question is plainly being asked, start
        // working out a reply without waiting for the sentence to end.
        if !final && modes.contains("answer") && id.hasPrefix("Them")
            && text.split(separator: " ").count >= 5 && isQuestion(text) {
            asked(line: id, text: text)
        }
        // Live, without rewriting: each clause is translated once, as soon as
        // the recogniser has settled on it, and added to the Greek for good.
        if !final && modes.contains("translate") { commitClauses(id: id, text: text, final: false) }
        let who = id.hasPrefix("Them") ? "Them" : "You"
        // Without headphones the microphone also hears the others: a "You"
        // line that repeats something just said by "Them" is that echo.
        if who == "You", isEcho(text) { send("ui.drop(\(json(["id": id])))"); return }
        send("ui.line(\(json(["id": id, "who": who, "text": text, "final": final])))")
        guard final else { return }
        // The others' line can settle after the echo of it on the microphone:
        // drop any such "You" line now, retroactively.
        if who == "Them" { dropEchoes(of: text) }
        lines.append((Date(), who, text, id))
        mlog("line \(who) (\(text.count) chars)")
        // Greek only, for both sides, when translating: the rest of the line.
        if modes.contains("translate") { commitClauses(id: id, text: text, final: true) }
        // Finished: answer it if not yet, or again if it said a lot more than
        // the part already answered.
        if who == "Them" && modes.contains("answer") {
            if isQuestion(text) {
                asked(line: id, text: text)
            } else {
                // Something other than a question was said: the next question
                // gets an answer of its own.
                groupOpen = false
            }
        }
    }

    /** Per line: how many words have been sent to be translated, the words
     *  of the previous partial (to see what has settled), and its chunk ids. */
    var committed: [String: Int] = [:]
    var previous: [String: [Substring]] = [:]
    var chunks: [String: [String]] = [:]

    private func commitClauses(id: String, text: String, final: Bool) {
        let w = text.split(separator: " ")
        var done = committed[id] ?? 0
        if final {
            if w.count > done { send(chunk: w[done...].joined(separator: " "), of: id) }
            committed[id] = w.count
            previous[id] = nil
            return
        }
        // Settled: the words this partial shares, from the start, with the last one.
        let before = previous[id] ?? []
        previous[id] = w
        var stable = 0
        while stable < min(w.count, before.count) && w[stable] == before[stable] { stable += 1 }
        // Cut at the last clause end inside the settled part: a full stop or
        // question mark after 3+ words, a comma or semicolon after 6+, or
        // anywhere after 12 words without one.
        var cut = -1
        var i = done
        while i < stable {
            let n = i - done + 1
            let word = w[i]
            if (word.last.map { ".?!".contains($0) } ?? false) && n >= 3 { cut = i }
            else if (word.last.map { ",;:".contains($0) } ?? false) && n >= 6 { cut = i }
            else if n >= 12 && cut < 0 { cut = i }
            i += 1
        }
        guard cut >= done else { return }
        send(chunk: w[done...cut].joined(separator: " "), of: id)
        done = cut + 1
        committed[id] = done
    }

    private func send(chunk: String, of line: String) {
        let n = (chunks[line]?.count ?? 0) + 1
        let cid = "\(line)~\(n)"
        chunks[line, default: []].append(cid)
        greek.translate(id: cid, text: chunk)
    }

    private func words(_ s: String) -> Set<String> {
        Set(s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count > 2 })
    }

    private func isEcho(_ text: String) -> Bool {
        let mine = words(text)
        guard mine.count >= 3 else { return false }
        for l in lines.suffix(6) where l.who == "Them" && Date().timeIntervalSince(l.at) < 15 {
            let theirs = words(l.text)
            if Double(mine.intersection(theirs).count) / Double(mine.count) > 0.7 { return true }
        }
        return false
    }

    private func dropEchoes(of text: String) {
        let theirs = words(text)
        guard theirs.count >= 2 else { return }
        lines.removeAll { l in
            guard l.who == "You", Date().timeIntervalSince(l.at) < 15 else { return false }
            let mine = words(l.text)
            guard !mine.isEmpty, Double(mine.intersection(theirs).count) / Double(mine.count) > 0.6 else { return false }
            send("ui.drop(\(json(["id": l.id])))")
            return true
        }
    }

    /** A question, or a request for an answer ("tell me…", "explain…"). */
    private func isQuestion(_ t: String) -> Bool {
        if t.hasSuffix("?") { return true }
        let low = t.lowercased()
        let first = low.split(separator: " ").first.map { $0.trimmingCharacters(in: .punctuationCharacters) } ?? ""
        let asks = ["what", "why", "how", "when", "where", "who", "which", "can", "could", "would", "will", "do", "does",
                    "did", "is", "are", "should", "have", "has", "any", "tell", "explain", "describe", "walk", "give",
                    "share", "talk", "list", "define", "summarize", "summarise", "clarify", "remind"]
        if asks.contains(first) && t.split(separator: " ").count >= 3 { return true }
        // Asked partway through a sentence: "so tell me…", "and could you explain…"
        return low.range(of: #"\b(tell me|explain|walk me through|what do you think|can you|could you|would you)\b"#, options: .regularExpression) != nil
    }

    /** Answers only look at what was said after the last Clear. */
    var contextFrom = 0

    /**
     * Questions and their suggested answers. Each question gets its own
     * suggestion; questions asked one straight after another, with nothing
     * else said between, share one suggestion that answers them all.
     */
    var group: (id: String, order: [String], questions: [String: String], at: Date)?
    /** Only questions have been said since the current group began. */
    var groupOpen = false
    /** How many words of each group's questions its suggestion covers. */
    var answeredWords: [String: Int] = [:]
    var answerTask: Task<Void, Never>?

    /** A question (still being asked, or finished) on line `line`. */
    private func asked(line: String, text: String) {
        if var g = group, groupOpen, g.questions[line] != nil || Date().timeIntervalSince(g.at) < 30 {
            if g.questions[line] == nil { g.order.append(line) }
            g.questions[line] = text
            g.at = Date()
            group = g
        } else {
            group = (line, [line], [line: text], Date())
            groupOpen = true
        }
        guard let g = group else { return }
        let all = g.order.compactMap { g.questions[$0] }.joined(separator: " ")
        let n = all.split(separator: " ").count
        // A new question, or the same one(s) grown by a few words: (re)write the suggestion.
        if let done = answeredWords[g.id], n - done < 4 { return }
        answeredWords[g.id] = n
        suggest(group: g.id, question: all)
    }

    private func suggest(group id: String, question: String) {
        guard answerer != nil else { return }
        // A newer question wins: whatever was being written is dropped.
        answerTask?.cancel()
        let context = lines[min(contextFrom, lines.count)...].suffix(6).map { "\($0.who == "You" ? "Me" : "Them"): \($0.text)" }.joined(separator: "\n")
        send("ui.question(\(json(["id": id, "text": question])))")
        // A fresh session each time, so a dropped answer never blocks the next.
        let session = LanguageModelSession(instructions: Meeting.answerRules)
        answerTask = Task { [weak self] in
            var text = ""
            do {
                // Shown word by word as it is written, not when it is done.
                let stream = session.streamResponse(to: "Recent conversation:\n\(context)\n\nAsked: \(question)\nSay:")
                for try await snap in stream {
                    if Task.isCancelled { return }
                    // Without the quote marks it sometimes wraps a reply in.
                    text = snap.content.trimmingCharacters(in: CharacterSet(charactersIn: "\"“” ").union(.whitespacesAndNewlines))
                    let now = text
                    await MainActor.run { self?.send("ui.answer(\(self?.json(["id": id, "text": now, "partial": true]) ?? "{}"))") }
                }
            } catch {
                if Task.isCancelled { return }
                text = ""
            }
            if Task.isCancelled { return }
            await MainActor.run {
                mlog("answer suggested (\(text.count) chars)")
                self?.send("ui.answer(\(self?.json(["id": id, "text": text.isEmpty ? "No suggestion for this one." : text]) ?? "{}"))")
            }
        }
    }

    static let answerRules = """
        You tell the user, privately, the answer to give in a formal work meeting. Write only the answer itself, \
        as the user would say it: complete, formal, polite sentences in the first person — no lead-in, no \
        "I think you could say", no quote marks, no slang or contractions.
        Usually one sentence; up to three when asked to explain something.
        If several questions were asked, answer every one of them, in order.
        Answer exactly what was asked. If the question mixes something up, correct it politely.
        About the user's own work or opinion: a confident, professional answer they can adapt.

        Examples:
        Asked: What is 14 divided by 2?
        Say: Fourteen divided by two equals seven.
        Asked: What's the capital of Australia?
        Say: The capital of Australia is Canberra.
        Asked: How many words are in the Greek alphabet?
        Say: The Greek alphabet consists of letters rather than words; it has twenty-four letters.
        Asked: Who painted the Mona Lisa? And when?
        Say: The Mona Lisa was painted by Leonardo da Vinci, in the early sixteenth century.
        Asked: When can you send the report?
        Say: I will send you the report by Friday.
        """

    // MARK: The Word file

    private func save() {
        guard !lines.isEmpty else { return }
        let fm = FileManager.default
        let folder = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/Yonna Meetings")
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        if file == nil {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd HH.mm"
            file = folder.appendingPathComponent("Meeting \(f.string(from: startedAt)) (\(app.isEmpty ? "meeting" : app)).docx")
        }
        guard let file else { return }
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let time = DateFormatter()
        time.dateFormat = "HH:mm"
        var html = "<html><head><meta charset=\"utf-8\"></head><body style=\"font-family: Helvetica\">"
        let day = DateFormatter()
        day.dateStyle = .full
        day.timeStyle = .short
        html += "<h1>Meeting — \(esc(app.isEmpty ? "meeting" : app))</h1><p>\(esc(day.string(from: startedAt)))</p>"
        if modes.contains("translate") {
            // Translating: the Greek only, as one continuous paragraph (the
            // English where no Greek came back).
            html += "<p>" + lines.map { l in
                let g = (chunks[l.id] ?? []).compactMap { greekFor[$0] }.joined(separator: " ")
                return esc(g.isEmpty ? l.text : g)
            }.joined(separator: " ") + "</p>"
        } else {
            for l in lines {
                html += "<p><b>\(time.string(from: l.at)) \(l.who == "You" ? "Me" : "Them"):</b> \(esc(l.text))</p>"
            }
        }
        html += "</body></html>"
        let tmp = fm.temporaryDirectory.appendingPathComponent("yonna-meeting.html")
        try? html.data(using: .utf8)?.write(to: tmp)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/textutil")
        p.arguments = ["-convert", "docx", "-inputencoding", "UTF-8", tmp.path, "-output", file.path]
        try? p.run()
        p.waitUntilExit()
        try? fm.removeItem(at: tmp)
        mlog("saved \(lines.count) lines")
        send("ui.saved(\(json(["file": file.path])))")
    }
}
