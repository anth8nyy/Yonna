// Yonna Messages — lets the user text Yonna over iMessage.
//
// Watches the user's "message to yourself" conversation in the Messages
// database for new messages, writes each one to an inbox file for the bridge,
// and sends whatever the bridge drops in the outbox back through Messages.
//
// A separate native app for the same reason as Yonna Calendar: macOS only
// grants this kind of access to a real app, under its own name. Reading the
// Messages database needs Full Disk Access, which the user adds by hand in
// System Settings; sending asks once for permission to control Messages.
//
// Usage: YonnaMessages <dir>
//   <dir>/config.json   {"handles": ["+30…"]}   whose self-chat to watch
//   <dir>/inbox.jsonl   one {"id","text","at"} per incoming message (appended)
//   <dir>/outbox/*.json {"text"} — each is sent, then deleted
//   <dir>/status.json   {"ok", "error"?, "at"} — health, for the bridge

import Foundation
import SQLite3

let args = CommandLine.arguments
guard args.count >= 2 else { exit(2) }
let dir = URL(fileURLWithPath: args[1])
let inbox = dir.appendingPathComponent("inbox.jsonl")
let outbox = dir.appendingPathComponent("outbox")
let statusFile = dir.appendingPathComponent("status.json")
let dbPath = NSHomeDirectory() + "/Library/Messages/chat.db"
try? FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)

/// Every reply starts with this invisible marker, so Yonna never answers
/// himself: in a self-chat his messages land in the same thread as the user's.
let MARK = "\u{2063}"

var recentSummary: [[String: Any]] = []

func writeStatus(_ ok: Bool, _ error: String? = nil) {
  var o: [String: Any] = ["ok": ok, "at": ISO8601DateFormatter().string(from: Date())]
  if let error { o["error"] = error }
  if !recentSummary.isEmpty { o["recent"] = recentSummary }
  if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: statusFile) }
}

func loadHandles() -> [String] {
  guard let d = try? Data(contentsOf: dir.appendingPathComponent("config.json")),
        let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
        let h = o["handles"] as? [String] else { return [] }
  return h
}

/// A comparable form of an address: an email as-is (lowercased), a phone
/// number as its last nine digits — "+30 698…", "0030698…" and "698…" agree.
func tail(_ s: String) -> String {
  s.contains("@") ? s.lowercased().trimmingCharacters(in: .whitespaces) : String(s.filter(\.isNumber).suffix(9))
}

/// For diagnostics: enough of an address to tell which kind of thread it is,
/// never the whole thing.
func mask(_ s: String) -> String {
  if s.isEmpty { return "" }
  if let at = s.firstIndex(of: "@") { return "\(s.prefix(1))…\(s[at...])" }
  if s.hasPrefix("chat") { return "group" }
  return "…" + String(s.filter(\.isNumber).suffix(4))
}

// MARK: - reading

/// Since macOS 13 most message text lives only in `attributedBody`, an
/// NSArchiver blob; the `text` column is often empty.
func decodeBody(_ data: Data) -> String? {
  if let a = try? NSKeyedUnarchiver.unarchiveTopLevelObjectWithData(data) as? NSAttributedString { return a.string }
  if let a = NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString { return a.string }
  // Fallback: the string follows the "NSString" class marker, length-prefixed.
  let bytes = [UInt8](data)
  guard let r = data.range(of: Data("NSString".utf8)) else { return nil }
  var i = r.upperBound + 5
  guard i < bytes.count else { return nil }
  var len = Int(bytes[i]); i += 1
  if len == 0x81, i + 1 < bytes.count { len = Int(bytes[i]) | Int(bytes[i + 1]) << 8; i += 2 }
  guard i + len <= bytes.count else { return nil }
  return String(bytes: bytes[i..<(i + len)], encoding: .utf8)
}

var db: OpaquePointer?

func openDb() -> Bool {
  if db != nil { return true }
  if sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) != SQLITE_OK {
    db = nil
    return false
  }
  // Fails here, not at open, when Full Disk Access is missing.
  var st: OpaquePointer?
  let ok = sqlite3_prepare_v2(db, "SELECT MAX(ROWID) FROM message", -1, &st, nil) == SQLITE_OK
    && sqlite3_step(st) == SQLITE_ROW
  sqlite3_finalize(st)
  if !ok { sqlite3_close(db); db = nil }
  return ok
}

func maxRowId() -> Int64 {
  var st: OpaquePointer?
  defer { sqlite3_finalize(st) }
  guard sqlite3_prepare_v2(db, "SELECT IFNULL(MAX(ROWID),0) FROM message", -1, &st, nil) == SQLITE_OK,
        sqlite3_step(st) == SQLITE_ROW else { return 0 }
  return sqlite3_column_int64(st, 0)
}

struct Incoming { let id: Int64; let text: String }

func newMessages(after last: Int64, handles: [String], seen: inout Int64) -> [Incoming] {
  let sql = """
    SELECT m.ROWID, m.text, m.attributedBody, c.chat_identifier, h.id
    FROM message m
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.ROWID > ? AND m.item_type = 0
    ORDER BY m.ROWID
    """
  var st: OpaquePointer?
  defer { sqlite3_finalize(st) }
  guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return [] }
  sqlite3_bind_int64(st, 1, last)
  let mine = Set(handles.map(tail))
  var out: [Incoming] = []
  while sqlite3_step(st) == SQLITE_ROW {
    let id = sqlite3_column_int64(st, 0)
    seen = max(seen, id)
    let chat = sqlite3_column_text(st, 3).map { String(cString: $0) } ?? ""
    // Only the user's own one-to-one thread: the chat is with their number.
    // Group chats are "chat…" identifiers and never match.
    guard mine.contains(tail(chat)) else { continue }
    var text = sqlite3_column_text(st, 1).map { String(cString: $0) } ?? ""
    if text.isEmpty, let blob = sqlite3_column_blob(st, 2) {
      let n = Int(sqlite3_column_bytes(st, 2))
      text = decodeBody(Data(bytes: blob, count: n)) ?? ""
    }
    text = text.replacingOccurrences(of: "\u{FFFC}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty || text.hasPrefix(MARK) { continue }
    out.append(Incoming(id: id, text: text))
  }
  return out
}

/// The last few messages of the past half hour, masked — which thread, sent
/// or received, which service — so a message that was not picked up can be
/// traced without anyone reading its contents.
func summarize(handles: [String]) -> [[String: Any]] {
  let sql = """
    SELECT m.ROWID, m.is_from_me, IFNULL(m.service,''), IFNULL(c.chat_identifier,''), IFNULL(h.id,''),
           (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
    FROM message m
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.date > ?
    ORDER BY m.ROWID DESC LIMIT 8
    """
  var st: OpaquePointer?
  defer { sqlite3_finalize(st) }
  guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return [] }
  let since = (Date().timeIntervalSinceReferenceDate - 1800) * 1_000_000_000
  sqlite3_bind_int64(st, 1, Int64(since))
  let mine = Set(handles.map(tail))
  var out: [[String: Any]] = []
  while sqlite3_step(st) == SQLITE_ROW {
    let chat = sqlite3_column_text(st, 3).map { String(cString: $0) } ?? ""
    let handle = sqlite3_column_text(st, 4).map { String(cString: $0) } ?? ""
    out.append([
      "row": sqlite3_column_int64(st, 0),
      "fromMe": sqlite3_column_int(st, 1) == 1,
      "service": sqlite3_column_text(st, 2).map { String(cString: $0) } ?? "",
      "chat": mask(chat),
      "handle": mask(handle),
      "hasText": sqlite3_column_int(st, 5) == 1,
      "matched": mine.contains(tail(chat)),
    ])
  }
  return out
}

// MARK: - sending

func escape(_ s: String) -> String {
  s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
}

func send(_ text: String, to handle: String) -> String? {
  let script = """
    tell application "Messages"
      set svc to 1st account whose service type = iMessage
      send "\(escape(MARK + text))" to participant "\(escape(handle))" of svc
    end tell
    """
  var err: NSDictionary?
  NSAppleScript(source: script)?.executeAndReturnError(&err)
  if let err { return (err[NSAppleScript.errorMessage] as? String) ?? "\(err)" }
  return nil
}

// MARK: - loop

/// The same message can be recorded twice in a self-chat (sent and received).
var recent: [String: Date] = [:]
var last: Int64 = -1

while true {
  autoreleasepool {
    let handles = loadHandles()
    if handles.isEmpty {
      writeStatus(false, "No phone number configured.")
    } else if !openDb() {
      writeStatus(false, "No access to Messages. Add Yonna Messages to Full Disk Access.")
    } else {
      if last < 0 { last = maxRowId() } // start from now, never replay history
      let now = Date()
      recent = recent.filter { now.timeIntervalSince($0.value) < 20 }
      var seen = last
      let fresh = newMessages(after: last, handles: handles, seen: &seen)
      last = seen
      for m in fresh {
        if recent[m.text] != nil { continue }
        recent[m.text] = now
        let line: [String: Any] = ["id": m.id, "text": m.text, "at": ISO8601DateFormatter().string(from: now)]
        if let d = try? JSONSerialization.data(withJSONObject: line),
           let h = try? FileHandle(forWritingTo: inbox) ?? {
             FileManager.default.createFile(atPath: inbox.path, contents: nil)
             return try FileHandle(forWritingTo: inbox)
           }() {
          h.seekToEndOfFile()
          h.write(d + Data("\n".utf8))
          try? h.close()
        }
      }
      recentSummary = summarize(handles: handles)
      var sendError: String?
      let files = (try? FileManager.default.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil)) ?? []
      for f in files.filter({ $0.pathExtension == "json" }).sorted(by: { $0.path < $1.path }) {
        if let d = try? Data(contentsOf: f),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let text = o["text"] as? String, !text.isEmpty {
          sendError = send(text, to: handles[0]) ?? sendError
        }
        try? FileManager.default.removeItem(at: f)
      }
      writeStatus(sendError == nil, sendError)
    }
  }
  Thread.sleep(forTimeInterval: 2)
}
