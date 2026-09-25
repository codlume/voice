import ApplicationServices
import Foundation

// Posts a synthetic hotkey press so the hotkey smoke test can drive voice-helper
// without a human at the keyboard.
let keys: [String: (keycode: CGKeyCode, flags: CGEventFlags)] = [
    "fn": (63, .maskSecondaryFn),
    "rightOption": (61, CGEventFlags(rawValue: CGEventFlags.maskAlternate.rawValue | 0x40)),
    "rightCommand": (54, CGEventFlags(rawValue: CGEventFlags.maskCommand.rawValue | 0x10)),
]

let name = CommandLine.arguments.dropFirst().first ?? "fn"
guard let key = keys[name] else {
    FileHandle.standardError.write(Data("usage: fnpost [fn|rightOption|rightCommand]\n".utf8))
    exit(64)
}

let source = CGEventSource(stateID: .hidSystemState)
for flags: CGEventFlags in [key.flags, []] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: key.keycode, keyDown: !flags.isEmpty) else {
        FileHandle.standardError.write(Data("fnpost: CGEvent creation failed\n".utf8))
        exit(1)
    }
    event.type = .flagsChanged
    event.flags = flags
    event.post(tap: .cghidEventTap)
    usleep(50_000)
}
print("posted \(name) down/up")
