// Test-side helper for the real-Mac proof. It posts real HID events and moves the scratch
// document's selection through Accessibility. It is not part of the app.
import AppKit
import ApplicationServices
import Carbon

let arguments = Array(CommandLine.arguments.dropFirst())
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
func post(_ event: CGEvent?) {
    guard let event else { fail("event creation failed") }
    event.post(tap: .cghidEventTap)
    // Posting is asynchronous; exiting immediately can drop the event before delivery.
    usleep(80_000)
}
switch arguments.first {
case "key":
    // key <fn|space|escape> <down|up> [fn]
    guard arguments.count >= 3 else { fail("usage: key <name> <down|up> [fn]") }
    let codes: [String: CGKeyCode] = ["fn": 63, "space": 49, "escape": 53]
    guard let code = codes[arguments[1]] else { fail("unknown key") }
    let down = arguments[2] == "down"
    // Keep the system-provided flags; replacing them drops the non-coalesced bit and the event.
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    if arguments[1] == "fn" {
        event?.type = .flagsChanged
        if down { event?.flags.insert(.maskSecondaryFn) } else { event?.flags.remove(.maskSecondaryFn) }
    } else if arguments.count > 3, arguments[3] == "fn" {
        event?.flags.insert(.maskSecondaryFn)
    }
    post(event)
case "click":
    // click <x> <y>: a real left click at screen coordinates.
    guard arguments.count == 3, let x = Double(arguments[1]), let y = Double(arguments[2]) else { fail("usage: click x y") }
    let point = CGPoint(x: x, y: y)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
    usleep(60_000)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
case "select":
    // select <pid> <location> <length>: set the focused element's selection in the target app.
    guard arguments.count == 4, let pid = Int32(arguments[1]), let location = Int(arguments[2]), let length = Int(arguments[3]) else { fail("usage: select pid location length") }
    let application = AXUIElementCreateApplication(pid)
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
          let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { fail("no focused element") }
    var range = CFRange(location: location, length: length)
    guard let value = AXValueCreate(.cfRange, &range) else { fail("range value failed") }
    let result = AXUIElementSetAttributeValue(unsafeDowncast(focused, to: AXUIElement.self), kAXSelectedTextRangeAttribute as CFString, value)
    guard result == .success else { fail("select failed: \(result.rawValue)") }
case "frontmost":
    // A fresh process reads the current frontmost app; System Events can report a stale one.
    print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "")
case "secure":
    // Whether another app holds secure keyboard input, which hides keys from event taps.
    print(IsSecureEventInputEnabled() ? "on" : "off")
default:
    fail("usage: key|click|select|frontmost|secure")
}
