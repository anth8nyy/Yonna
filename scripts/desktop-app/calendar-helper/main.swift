// Yonna Calendar — a tiny native helper that reads and writes the user's
// Apple Calendar and Reminders through EventKit.
//
// Why a separate app: macOS only grants Calendar/Reminders access to an app
// that asks for it, under its own name, with a usage description. The Yonna
// bridge runs under a script launcher that can neither ask nor be granted, so
// a request from it would hang (exactly what happened to the camera). This
// helper is launched through LaunchServices, so it asks as itself, once.
//
// Usage: YonnaCalendar <request.json> <response.json>
// The request is {"op": "...", ...}; the response is {"ok": true, ...} or
// {"ok": false, "error": "..."}.

import EventKit
import Foundation

let store = EKEventStore()
let args = CommandLine.arguments
guard args.count >= 3 else { exit(2) }
let requestPath = args[1]
let responsePath = args[2]

// MARK: - dates

/// Local wall-clock times in, local wall-clock times out. "2026-10-16T15:00"
/// means 3pm here; a trailing Z or offset is honoured if present.
func parseDate(_ raw: Any?) -> Date? {
  guard let s = (raw as? String)?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
  let iso = ISO8601DateFormatter()
  for opts: ISO8601DateFormatter.Options in [
    [.withInternetDateTime], [.withInternetDateTime, .withFractionalSeconds],
  ] {
    iso.formatOptions = opts
    if let d = iso.date(from: s) { return d }
  }
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.timeZone = .current
  for fmt in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
    f.dateFormat = fmt
    if let d = f.date(from: s) { return d }
  }
  return nil
}

func fmt(_ d: Date?) -> String? {
  guard let d else { return nil }
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.timeZone = .current
  f.dateFormat = "yyyy-MM-dd'T'HH:mm"
  return f.string(from: d)
}

func human(_ d: Date?, allDay: Bool = false) -> String? {
  guard let d else { return nil }
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_GB")
  f.timeZone = .current
  f.dateFormat = allDay ? "EEEE d MMMM" : "EEEE d MMMM, HH:mm"
  return f.string(from: d)
}

func components(_ d: Date) -> DateComponents {
  Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: d)
}

// MARK: - access

func requestAccess(_ type: EKEntityType) -> Bool {
  let status = EKEventStore.authorizationStatus(for: type)
  if status == .fullAccess { return true }
  if status == .denied || status == .restricted { return false }
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  let done: (Bool, Error?) -> Void = { ok, _ in granted = ok; sem.signal() }
  if type == .event { store.requestFullAccessToEvents(completion: done) }
  else { store.requestFullAccessToReminders(completion: done) }
  _ = sem.wait(timeout: .now() + 120)
  return granted
}

struct Fail: Error { let message: String }

func need(_ type: EKEntityType) throws {
  if !requestAccess(type) {
    let what = type == .event ? "Calendar" : "Reminders"
    throw Fail(message: "\(what) access is not granted. Allow Yonna Calendar in System Settings → Privacy & Security → \(what).")
  }
}

// MARK: - events

/// Ids carry the occurrence start, so one instance of a repeating event can
/// be edited or deleted without touching the rest of the series.
func eventId(_ e: EKEvent) -> String {
  "\(e.eventIdentifier ?? "")@\(Int(e.startDate.timeIntervalSince1970))"
}

func findEvent(_ id: String) -> EKEvent? {
  let parts = id.split(separator: "@", maxSplits: 1).map(String.init)
  let ident = parts.first ?? id
  if parts.count == 2, let t = Double(parts[1]) {
    let at = Date(timeIntervalSince1970: t)
    let pred = store.predicateForEvents(withStart: at.addingTimeInterval(-60), end: at.addingTimeInterval(60), calendars: nil)
    if let hit = store.events(matching: pred).first(where: { $0.eventIdentifier == ident }) { return hit }
  }
  return store.event(withIdentifier: ident)
}

func eventJSON(_ e: EKEvent) -> [String: Any] {
  var o: [String: Any] = [
    "id": eventId(e),
    "title": e.title ?? "(untitled)",
    "start": fmt(e.startDate) ?? "",
    "end": fmt(e.endDate) ?? "",
    "when": human(e.startDate, allDay: e.isAllDay) ?? "",
    "allDay": e.isAllDay,
    "calendar": e.calendar?.title ?? "",
    "repeats": e.hasRecurrenceRules,
  ]
  if let l = e.location, !l.isEmpty { o["location"] = l }
  if let n = e.notes, !n.isEmpty { o["notes"] = String(n.prefix(300)) }
  if let a = e.alarms?.first { o["alertMinutesBefore"] = Int(-a.relativeOffset / 60) }
  return o
}

func applyEvent(_ e: EKEvent, _ r: [String: Any], creating: Bool) throws {
  if let t = r["title"] as? String, !t.isEmpty { e.title = t }
  if let a = r["allDay"] as? Bool { e.isAllDay = a }
  let oldLength = (e.endDate != nil && e.startDate != nil) ? e.endDate.timeIntervalSince(e.startDate) : 3600
  if let s = r["start"] {
    guard let d = parseDate(s) else { throw Fail(message: "Could not read the start time \(s).") }
    e.startDate = d
    if r["end"] == nil { e.endDate = d.addingTimeInterval(e.isAllDay ? 86400 : max(oldLength, 900)) }
  }
  if let s = r["end"] {
    guard let d = parseDate(s) else { throw Fail(message: "Could not read the end time \(s).") }
    e.endDate = d
  }
  if creating && e.endDate == nil, let s = e.startDate {
    e.endDate = s.addingTimeInterval(e.isAllDay ? 86400 : 3600)
  }
  if let l = r["location"] as? String { e.location = l.isEmpty ? nil : l }
  if let n = r["notes"] as? String { e.notes = n.isEmpty ? nil : n }
  if let m = r["alertMinutesBefore"] as? Double {
    e.alarms?.forEach { e.removeAlarm($0) }
    if m >= 0 { e.addAlarm(EKAlarm(relativeOffset: -m * 60)) }
  }
}

func calendarNamed(_ name: Any?, for type: EKEntityType) -> EKCalendar? {
  guard let n = (name as? String)?.lowercased(), !n.isEmpty else { return nil }
  return store.calendars(for: type).first { $0.title.lowercased() == n && $0.allowsContentModifications }
    ?? store.calendars(for: type).first { $0.title.lowercased().contains(n) && $0.allowsContentModifications }
}

// MARK: - reminders

func fetchReminders(_ pred: NSPredicate) -> [EKReminder] {
  let sem = DispatchSemaphore(value: 0)
  var out: [EKReminder] = []
  store.fetchReminders(matching: pred) { r in out = r ?? []; sem.signal() }
  _ = sem.wait(timeout: .now() + 30)
  return out
}

func reminderJSON(_ r: EKReminder) -> [String: Any] {
  let due = r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
  var o: [String: Any] = [
    "id": r.calendarItemIdentifier,
    "title": r.title ?? "(untitled)",
    "completed": r.isCompleted,
    "list": r.calendar?.title ?? "",
  ]
  if let due { o["due"] = fmt(due) ?? ""; o["when"] = human(due) ?? "" }
  if let n = r.notes, !n.isEmpty { o["notes"] = String(n.prefix(300)) }
  return o
}

func findReminder(_ id: String) -> EKReminder? {
  store.calendarItem(withIdentifier: id) as? EKReminder
}

func applyReminder(_ rem: EKReminder, _ r: [String: Any]) throws {
  if let t = r["title"] as? String, !t.isEmpty { rem.title = t }
  if let n = r["notes"] as? String { rem.notes = n.isEmpty ? nil : n }
  if let c = r["completed"] as? Bool { rem.isCompleted = c }
  if r.keys.contains("due") {
    if let raw = r["due"] as? String, raw.isEmpty || raw == "none" {
      rem.dueDateComponents = nil
      rem.alarms?.forEach { rem.removeAlarm($0) }
    } else if let d = parseDate(r["due"]) {
      rem.dueDateComponents = components(d)
      // A reminder with a time should actually remind: alert at that time.
      rem.alarms?.forEach { rem.removeAlarm($0) }
      rem.addAlarm(EKAlarm(absoluteDate: d))
    } else {
      throw Fail(message: "Could not read the due time \(r["due"] ?? "").")
    }
  }
}

// MARK: - dispatch

func handle(_ r: [String: Any]) throws -> [String: Any] {
  let op = r["op"] as? String ?? ""
  switch op {
  case "events.list":
    try need(.event)
    let from = parseDate(r["from"]) ?? Calendar.current.startOfDay(for: Date())
    let to = parseDate(r["to"]) ?? from.addingTimeInterval(86400)
    let pred = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    let events = store.events(matching: pred).sorted { $0.startDate < $1.startDate }
    return ["events": events.map(eventJSON)]

  case "events.create":
    try need(.event)
    guard r["title"] is String, r["start"] != nil else { throw Fail(message: "A title and a start time are needed.") }
    let e = EKEvent(eventStore: store)
    e.calendar = calendarNamed(r["calendar"], for: .event) ?? store.defaultCalendarForNewEvents
    guard e.calendar != nil else { throw Fail(message: "There is no calendar to add events to.") }
    try applyEvent(e, r, creating: true)
    try store.save(e, span: .thisEvent, commit: true)
    return ["event": eventJSON(e)]

  case "events.update":
    try need(.event)
    guard let id = r["id"] as? String, let e = findEvent(id) else { throw Fail(message: "That event was not found.") }
    try applyEvent(e, r, creating: false)
    try store.save(e, span: .thisEvent, commit: true)
    return ["event": eventJSON(e)]

  case "events.delete":
    try need(.event)
    guard let id = r["id"] as? String, let e = findEvent(id) else { throw Fail(message: "That event was not found.") }
    let gone = eventJSON(e)
    try store.remove(e, span: .thisEvent, commit: true)
    return ["deleted": gone]

  case "reminders.list":
    try need(.reminder)
    let from = parseDate(r["from"])
    let to = parseDate(r["to"])
    let pred = (from != nil || to != nil)
      ? store.predicateForIncompleteReminders(withDueDateStarting: from, ending: to, calendars: nil)
      : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
    let list = fetchReminders(pred).sorted {
      let a = $0.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture
      let b = $1.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture
      return a < b
    }
    return ["reminders": list.prefix(60).map(reminderJSON)]

  case "reminders.create":
    try need(.reminder)
    guard let title = r["title"] as? String, !title.isEmpty else { throw Fail(message: "A reminder needs a title.") }
    let rem = EKReminder(eventStore: store)
    rem.title = title
    rem.calendar = calendarNamed(r["list"], for: .reminder) ?? store.defaultCalendarForNewReminders()
    guard rem.calendar != nil else { throw Fail(message: "There is no Reminders list to add to.") }
    try applyReminder(rem, r)
    try store.save(rem, commit: true)
    return ["reminder": reminderJSON(rem)]

  case "reminders.update":
    try need(.reminder)
    guard let id = r["id"] as? String, let rem = findReminder(id) else { throw Fail(message: "That reminder was not found.") }
    try applyReminder(rem, r)
    try store.save(rem, commit: true)
    return ["reminder": reminderJSON(rem)]

  case "reminders.delete":
    try need(.reminder)
    guard let id = r["id"] as? String, let rem = findReminder(id) else { throw Fail(message: "That reminder was not found.") }
    let gone = reminderJSON(rem)
    try store.remove(rem, commit: true)
    return ["deleted": gone]

  case "calendars":
    try need(.event)
    return ["calendars": store.calendars(for: .event).map { ["name": $0.title, "writable": $0.allowsContentModifications] }]

  default:
    throw Fail(message: "Unknown operation \(op).")
  }
}

func respond(_ body: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: body, options: [])) ?? Data("{\"ok\":false}".utf8)
  try? data.write(to: URL(fileURLWithPath: responsePath))
}

DispatchQueue.global().async {
  var body: [String: Any]
  do {
    let data = try Data(contentsOf: URL(fileURLWithPath: requestPath))
    guard let req = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw Fail(message: "Bad request.")
    }
    body = try handle(req)
    body["ok"] = true
  } catch let f as Fail {
    body = ["ok": false, "error": f.message]
  } catch {
    body = ["ok": false, "error": error.localizedDescription]
  }
  respond(body)
  exit(0)
}
RunLoop.main.run()
