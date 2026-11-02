import ApplicationServices
import Foundation

let keys: [String: (keycode: CGKeyCode, flags: CGEventFlags)] = [
    "fn": (63, .maskSecondaryFn),
    "rightOption": (61, CGEventFlags(rawValue: CGEventFlags.maskAlternate.rawValue | 0x40)),
    "rightCommand": (54, CGEventFlags(rawValue: CGEventFlags.maskCommand.rawValue | 0x10)),
]
let escapeKeycode: CGKeyCode = 53
let aKeycode: CGKeyCode = 0

enum Side: String, CaseIterable {
    case left, right

    static let flag = "--side="

    static func parse(_ argument: String?) -> Side? {
        guard let argument else { return .left }
        guard argument.hasPrefix(flag) else { return nil }
        return Side(rawValue: String(argument.dropFirst(flag.count)))
    }
}
let sideUsage = Side.flag + Side.allCases.map(\.rawValue).joined(separator: "|")

struct ModifierKey {
    let generic: UInt64
    let left: (keycode: CGKeyCode, bit: UInt64)
    let right: (keycode: CGKeyCode, bit: UInt64)
}
let modifiers: [String: ModifierKey] = [
    "control": ModifierKey(generic: 0x4_0000, left: (59, 0x1), right: (62, 0x2000)),
    "shift": ModifierKey(generic: 0x2_0000, left: (56, 0x2), right: (60, 0x4)),
    "option": ModifierKey(generic: 0x8_0000, left: (58, 0x20), right: (61, 0x40)),
    "command": ModifierKey(generic: 0x10_0000, left: (55, 0x8), right: (54, 0x10)),
]

func usage() -> Never {
    FileHandle.standardError.write(
        Data("""
        usage: fnpost [fn|rightOption|rightCommand] [down|up|chord|state] | fnpost escape
               fnpost combo <keycode> <modifier>[,<modifier>...] [\(sideUsage)]

        """.utf8))
    exit(64)
}

func post(_ event: CGEvent?) {
    guard let event else {
        FileHandle.standardError.write(Data("fnpost: CGEvent creation failed\n".utf8))
        exit(1)
    }
    event.post(tap: .cghidEventTap)
    usleep(50_000)
}

let arguments = Array(CommandLine.arguments.dropFirst())
let name = arguments.first ?? "fn"
let source = CGEventSource(stateID: .hidSystemState)

if name == "escape" {
    for down in [true, false] {
        post(CGEvent(keyboardEventSource: source, virtualKey: escapeKeycode, keyDown: down))
    }
    print("posted escape")
    exit(0)
}

if name == "combo" {
    let rest = arguments.dropFirst()
    guard let keycode = rest.first.flatMap({ CGKeyCode($0) }), let names = rest.dropFirst().first?.split(separator: ",") else {
        usage()
    }
    guard let side = Side.parse(rest.dropFirst(2).first) else { usage() }
    var held: [(keycode: CGKeyCode, flags: UInt64)] = []
    for name in names {
        guard let modifier = modifiers[String(name)] else { usage() }
        let physical = side == .right ? modifier.right : modifier.left
        let flags = (held.last?.flags ?? 0) | modifier.generic | physical.bit
        held.append((physical.keycode, flags))
    }
    func flagsChanged(_ keycode: CGKeyCode, down: Bool, flags: UInt64) {
        let event = CGEvent(keyboardEventSource: source, virtualKey: keycode, keyDown: down)
        event?.type = .flagsChanged
        event?.flags = CGEventFlags(rawValue: flags)
        post(event)
    }
    for (keycode, flags) in held { flagsChanged(keycode, down: true, flags: flags) }
    for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: keycode, keyDown: down)
        event?.flags = CGEventFlags(rawValue: held.last?.flags ?? 0)
        post(event)
    }
    for index in held.indices.reversed() {
        flagsChanged(held[index].keycode, down: false, flags: index == 0 ? 0 : held[index - 1].flags)
    }
    print("posted \(side.rawValue) \(names.joined(separator: "+")) with keycode \(keycode)")
    exit(0)
}

guard let key = keys[name] else { usage() }
@MainActor func postKey(down: Bool) {
    let event = CGEvent(keyboardEventSource: source, virtualKey: key.keycode, keyDown: down)
    event?.type = .flagsChanged
    event?.flags = down ? key.flags : []
    post(event)
}

switch arguments.dropFirst().first {
case nil:
    postKey(down: true)
    postKey(down: false)
    print("posted \(name) down/up")
case "down":
    postKey(down: true)
    print("posted \(name) down")
case "up":
    postKey(down: false)
    print("posted \(name) up")
case "chord":
    postKey(down: true)
    for down in [true, false] {
        let letter = CGEvent(keyboardEventSource: source, virtualKey: aKeycode, keyDown: down)
        letter?.flags = key.flags
        post(letter)
    }
    postKey(down: false)
    print("posted \(name) down, a, \(name) up")
case "state":
    // Any input from another source clears a posted modifier, as the helper's release
    // backstop sees it, so a caller holding the key can tell its hold was lost.
    let generic = key.flags.rawValue & 0xFFFF_0000
    let down = CGEventSource.flagsState(.combinedSessionState).rawValue & generic == generic
    print(down ? "down" : "up")
default: usage()
}
