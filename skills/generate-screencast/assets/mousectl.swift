// Mouse and keyboard driver for native scenes. Reads one command per line on
// stdin and answers "ok" (or "ok x,y" for pos) once the action has finished,
// so the caller can schedule against a clock. cliclick can't do this: it adds
// ~100ms per mouse move, which makes a smooth timed glide impossible.
//
//   glide <x> <y> <ms>   smoothstep move in screen points, one event per ~8ms
//   move <x> <y>
//   click                left click at the current position
//   type <text>          types unicode text, ~40ms per character
//   key <name>           return | tab | escape | delete | space
//   pos
//
// Build: swiftc -O mousectl.swift -o mousectl
import CoreGraphics
import Foundation

let src = CGEventSource(stateID: .hidSystemState)
var cur: CGPoint = CGEvent(source: nil)?.location ?? .zero

func post(_ type: CGEventType, _ p: CGPoint) {
  CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func glide(to p: CGPoint, ms: Double) {
  let from = cur
  let start = Date()
  while true {
    let t = min(1, Date().timeIntervalSince(start) * 1000 / max(ms, 1))
    let e = t * t * (3 - 2 * t)
    let q = CGPoint(x: from.x + (p.x - from.x) * e, y: from.y + (p.y - from.y) * e)
    post(.mouseMoved, q)
    cur = q
    if t >= 1 { break }
    usleep(8000)
  }
}

func typeChar(_ s: String) {
  let units = Array(s.utf16)
  for down in [true, false] {
    let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
    ev?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    ev?.post(tap: .cghidEventTap)
  }
}

let keyCodes: [String: CGKeyCode] = ["return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53]

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
  let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
  guard let cmd = parts.first else { continue }
  let rest = parts.count > 1 ? parts[1] : ""
  let n = rest.split(separator: " ").compactMap { Double($0) }
  switch cmd {
  case "glide" where n.count == 3:
    glide(to: CGPoint(x: n[0], y: n[1]), ms: n[2])
  case "move" where n.count == 2:
    cur = CGPoint(x: n[0], y: n[1])
    post(.mouseMoved, cur)
  case "click":
    post(.leftMouseDown, cur)
    usleep(70000)
    post(.leftMouseUp, cur)
  case "type":
    for ch in rest {
      typeChar(String(ch))
      usleep(40000)
    }
  case "key":
    if let k = keyCodes[rest] {
      CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: true)?.post(tap: .cghidEventTap)
      CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false)?.post(tap: .cghidEventTap)
    }
  case "pos":
    cur = CGEvent(source: nil)?.location ?? cur
    print("ok \(Int(cur.x)),\(Int(cur.y))")
    continue
  default:
    print("err \(line)")
    continue
  }
  print("ok")
}
