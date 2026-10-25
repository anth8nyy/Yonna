// Yonna Messages Cleaner — reads and presses controls in the Messages app,
// and nothing else.
//
// In a "message to yourself" thread every message appears twice. Deleting one
// copy on the Mac deletes it on the iPhone too, so Yonna removes the copy
// that doesn't belong: the user's echo and his own sent copy, leaving the user
// in blue and Yonna in grey. Finding *which* bubble to delete is decided by
// the bridge (bridge/imessage.mjs); this helper only exposes the Messages
// window and performs the action it is told to, so that logic can change
// without rebuilding this app — and without the user re-granting permission.
//
// It refuses every application except Messages.
//
// Usage: YonnaCleaner <dir>
//   <dir>/cmd/<id>.json  {"op":"dump"} | {"op":"act","path":[…],"action":"…"}
//                        | {"op":"activate"}
//   <dir>/res/<id>.json  the result
//   <dir>/status.json    {"ok","trusted","at"}

import ApplicationServices
import AppKit
import Foundation

let MESSAGES = "com.apple.MobileSMS"
let args = CommandLine.arguments
guard args.count >= 2 else { exit(2) }
let dir = URL(fileURLWithPath: args[1])
let cmdDir = dir.appendingPathComponent("cmd")
let resDir = dir.appendingPathComponent("res")
let statusFile = dir.appendingPathComponent("status.json")
for d in [cmdDir, resDir] { try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }

func writeJSON(_ o: Any, to url: URL) {
  // Atomic, so the bridge never reads half a result.
  if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: url, options: .atomic) }
}

func attr(_ e: AXUIElement, _ n: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ n: String) -> String { (attr(e, n) as? String) ?? "" }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

func actions(_ e: AXUIElement) -> [[String: String]] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String] else { return [] }
  return list.map { n in
    var d: CFString?
    AXUIElementCopyActionDescription(e, n as CFString, &d)
    return ["name": n, "label": (d as String?) ?? n]
  }
}

func frame(_ e: AXUIElement) -> [Double]? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return [pt.x, pt.y, sz.width, sz.height].map { Double($0) }
}

func messagesApp() -> NSRunningApplication? {
  NSRunningApplication.runningApplications(withBundleIdentifier: MESSAGES).first
}

/// Root: the app element; children of the root are its windows.
func root() -> AXUIElement? {
  guard let app = messagesApp() else { return nil }
  return AXUIElementCreateApplication(app.processIdentifier)
}

func element(at path: [Int]) -> AXUIElement? {
  guard var e = root() else { return nil }
  for (depth, i) in path.enumerated() {
    let list = depth == 0 ? ((attr(e, kAXWindowsAttribute) as? [AXUIElement]) ?? []) : kids(e)
    guard i >= 0, i < list.count else { return nil }
    e = list[i]
  }
  return e
}

func dump(maxDepth: Int, maxNodes: Int) -> [[String: Any]] {
  guard let r = root() else { return [] }
  var out: [[String: Any]] = []
  func walk(_ e: AXUIElement, _ path: [Int]) {
    guard path.count <= maxDepth, out.count < maxNodes else { return }
    var n: [String: Any] = [
      "path": path,
      "role": str(e, kAXRoleAttribute),
      "subrole": str(e, kAXSubroleAttribute),
      "title": str(e, kAXTitleAttribute),
      "desc": str(e, kAXDescriptionAttribute),
      "value": String(((attr(e, kAXValueAttribute) as? String) ?? "").prefix(400)),
      "id": str(e, kAXIdentifierAttribute),
    ]
    let a = actions(e)
    if !a.isEmpty { n["actions"] = a }
    if let f = frame(e) { n["frame"] = f }
    out.append(n)
    for (i, c) in kids(e).enumerated() { walk(c, path + [i]) }
  }
  for (i, w) in ((attr(r, kAXWindowsAttribute) as? [AXUIElement]) ?? []).enumerated() { walk(w, [i]) }
  return out
}

func handle(_ cmd: [String: Any]) -> [String: Any] {
  guard AXIsProcessTrusted() else { return ["ok": false, "error": "not trusted"] }
  switch cmd["op"] as? String ?? "" {
  case "activate":
    if messagesApp() == nil, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: MESSAGES) {
      NSWorkspace.shared.openApplication(at: url, configuration: .init())
      Thread.sleep(forTimeInterval: 1.5)
    }
    messagesApp()?.activate()
    return ["ok": messagesApp() != nil]
  case "dump":
    guard messagesApp() != nil else { return ["ok": false, "error": "Messages is not running"] }
    let nodes = dump(maxDepth: cmd["maxDepth"] as? Int ?? 40, maxNodes: cmd["maxNodes"] as? Int ?? 4000)
    return ["ok": true, "nodes": nodes]
  case "act":
    guard let path = cmd["path"] as? [Int], let action = cmd["action"] as? String else {
      return ["ok": false, "error": "path and action needed"]
    }
    guard let e = element(at: path) else { return ["ok": false, "error": "element not found"] }
    let r = AXUIElementPerformAction(e, action as CFString)
    return ["ok": r == .success, "code": r.rawValue]
  default:
    return ["ok": false, "error": "unknown op"]
  }
}

let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
writeJSON(["ok": true, "trusted": trusted, "at": ISO8601DateFormatter().string(from: Date())], to: statusFile)

var beat = 0
while true {
  autoreleasepool {
    let files = (try? FileManager.default.contentsOfDirectory(at: cmdDir, includingPropertiesForKeys: nil)) ?? []
    for f in files.filter({ $0.pathExtension == "json" }).sorted(by: { $0.path < $1.path }) {
      let id = f.deletingPathExtension().lastPathComponent
      var result: [String: Any] = ["ok": false, "error": "bad command"]
      if let d = try? Data(contentsOf: f), let cmd = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
        result = handle(cmd)
      }
      try? FileManager.default.removeItem(at: f)
      writeJSON(result, to: resDir.appendingPathComponent("\(id).json"))
    }
    beat += 1
    if beat % 10 == 0 {
      writeJSON(["ok": true, "trusted": AXIsProcessTrusted(), "at": ISO8601DateFormatter().string(from: Date())], to: statusFile)
    }
  }
  Thread.sleep(forTimeInterval: 0.1)
}
