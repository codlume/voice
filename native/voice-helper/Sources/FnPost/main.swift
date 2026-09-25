import ApplicationServices
import Foundation

let keys: [String: (keycode: CGKeyCode, flags: CGEventFlags)] = [
    "fn": (63, .maskSecondaryFn),
    "rightOption": (61, CGEventFlags(rawValue: CGEventFlags.maskAlternate.rawValue | 0x40)),
    "rightCommand": (54, CGEventFlags(rawValue: CGEventFlags.maskCommand.rawValue | 0x10)),
]
let escapeKeycode: CGKeyCode = 53

func usage() -> Never {
    FileHandle.standardError.write(
        Data("usage: fnpost [fn|rightOption|rightCommand] [down|up] | fnpost escape\n".utf8))
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

guard let key = keys[name] else { usage() }
let edges: [Bool]
switch arguments.dropFirst().first {
case nil: edges = [true, false]
case "down": edges = [true]
case "up": edges = [false]
default: usage()
}
for down in edges {
    let event = CGEvent(keyboardEventSource: source, virtualKey: key.keycode, keyDown: down)
    event?.type = .flagsChanged
    event?.flags = down ? key.flags : []
    post(event)
}
print("posted \(name) \(edges.map { $0 ? "down" : "up" }.joined(separator: "/"))")
