// Scratch paste target for the opt-in clipboard fallback proof. It is not part of the app.
//
// It shows two synthetic text fields. Field "a" offers no Accessibility text write, like controls
// that only accept typing, so Voice must deliver to it with a clipboard paste. It also owns the
// proof's use of the general pasteboard: at launch it keeps the user's clipboard in memory and
// puts it back on every exit path it can handle. It never prints, logs, hashes, or writes those
// contents. Every value it reports concerns synthetic fixtures only, as booleans or counts.
//
// Protocol: one JSON command per stdin line, one JSON reply per stdout line. A paste into field
// "a" also emits {"event":"paste"}.
import AppKit

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}
typealias Kind = NSPasteboard.PasteboardType
// The proof uses the general pasteboard; a named one only for checking this tool's own guard.
let general = ProcessInfo.processInfo.environment["VOICE_PROOF_PASTEBOARD"].map { NSPasteboard(name: NSPasteboard.Name($0)) } ?? NSPasteboard.general
let concurrent = "Synthetic concurrent copy 42."
let custom = Kind("com.codlume.voice.fixture.binary")
let lazy = Kind("com.codlume.voice.fixture.lazy")
let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89])
// Synthetic fixtures: item list of (type, bytes).
let fixtures: [String: [[(Kind, Data)]]] = [
    "empty": [],
    "plain": [[(.string, Data("Synthetic plain copy: Priya, VX-204, 2026-09-23.".utf8))]],
    "rich": [[
        (.string, Data("Synthetic bold copy".utf8)),
        (.rtf, Data(#"{\rtf1\ansi{\fonttbl\f0 Helvetica;}\f0\b Synthetic bold copy}"#.utf8)),
        (.html, Data("<b>Synthetic bold copy</b>".utf8)),
    ]],
    "nontext": [
        [(.png, png), (custom, Data([0, 1, 2, 3, 254, 255]))],
        [(.string, Data("Second synthetic item".utf8)), (.URL, Data("https://example.com/voice-fixture".utf8))],
    ],
    "concealed": [[(.string, Data("Synthetic secret".utf8)), (Kind("org.nspasteboard.ConcealedType"), Data())]],
    "concurrent": [[(.string, Data(concurrent.utf8))]],
]
final class Promise: NSObject, NSPasteboardItemDataProvider {
    // Lazily promised data that fails to materialize.
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: Kind) {}
}
let promise = Promise()
func read(_ pasteboard: NSPasteboard) -> [[(Kind, Data)]]? {
    var items: [[(Kind, Data)]] = []
    for item in pasteboard.pasteboardItems ?? [] {
        var types: [(Kind, Data)] = []
        for type in item.types {
            guard let data = item.data(forType: type) else { return nil }
            types.append((type, data))
        }
        items.append(types)
    }
    return items
}
func write(_ items: [[(Kind, Data)]]) -> Bool {
    general.clearContents()
    if items.isEmpty { return true }
    let objects = items.map { types in
        let item = NSPasteboardItem()
        for (type, data) in types { item.setData(data, forType: type) }
        return item
    }
    return general.writeObjects(objects)
}
// Whether the pasteboard holds exactly these items and types, compared in memory.
func holds(_ expected: [[(Kind, Data)]]) -> Bool {
    guard let current = read(general), current.count == expected.count else { return false }
    return zip(current, expected).allSatisfy { actual, wanted in
        wanted.allSatisfy { type, data in actual.contains { $0.0 == type && $0.1 == data } }
    }
}

// The user's clipboard, kept only in this process's memory.
var saved: [[(Kind, Data)]]?
var restored = false
let start = general.changeCount
// The proof's loopback transcript, which explicit Copy puts on the clipboard.
let transcript = "Hello, Priya. Do not deploy VX-204."
// Whether the clipboard holds only the proof's own values: a fixture, Voice's marked transcript,
// or the explicit Copy. Anything else is a copy the user made during the run, which the proof
// must neither overwrite with a fixture nor replace with the older saved clipboard.
func proofOwned() -> Bool {
    let types = general.types ?? []
    if types.contains(lazy) || types.contains(Kind("com.codlume.voice.insertion")) { return true }
    if general.pasteboardItems?.count == 1, general.string(forType: .string) == transcript { return true }
    return fixtures.values.contains(where: holds)
}
func restoreUser() {
    guard let saved, !restored else { return }
    restored = true
    guard general.changeCount != start, proofOwned() else { return }
    _ = write(saved)
}
let unsafe: Set<Kind> = [Kind("org.nspasteboard.ConcealedType"), Kind("org.nspasteboard.TransientType")]
guard let user = read(general),
      !user.joined().contains(where: { unsafe.contains($0.0) || $0.0.rawValue.localizedCaseInsensitiveContains("promise") }) else {
    emit(["ready": false, "reason": "The current clipboard cannot be kept exactly; copy some plain text and rerun."])
    exit(2)
}
saved = user
var signals: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT, SIGHUP] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { restoreUser(); exit(0) }
    source.resume()
    signals.append(source)
}

final class PasteOnly: NSTextView {
    // "normal" pastes, "ignore" drops the paste, "copy" pastes and then copies something new.
    var mode = "normal"
    var pastes = 0
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(NSAccessibilityProtocol.setAccessibilitySelectedText(_:)) { return false }
        return super.isAccessibilitySelectorAllowed(selector)
    }
    override func accessibilityIsAttributeSettable(_ attribute: NSAccessibility.Attribute) -> Bool {
        attribute == .selectedText ? false : super.accessibilityIsAttributeSettable(attribute)
    }
    override func setAccessibilitySelectedText(_ value: String?) {}
    override func paste(_ sender: Any?) {
        pastes += 1
        if mode != "ignore" { pasteAsPlainText(sender) }
        if mode == "copy" { _ = write(fixtures["concurrent"] ?? []) }
        emit(["event": "paste"])
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
// Like real apps, Command-V reaches the field through the Edit menu's key equivalent.
let menu = NSMenu()
let edit = NSMenu(title: "Edit")
edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
menu.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit
menu.insertItem(NSMenuItem(), at: 0)
app.mainMenu = menu
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 520, height: 260), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Voice clipboard scratch target"
let a = PasteOnly(frame: NSRect(x: 20, y: 140, width: 480, height: 100))
let b = NSTextView(frame: NSRect(x: 20, y: 20, width: 480, height: 100))
for view in [a, b] {
    view.isRichText = false
    view.smartInsertDeleteEnabled = false
    window.contentView?.addSubview(view)
}
window.makeKeyAndOrderFront(nil)
var recorded = general.changeCount

@MainActor func handle(_ command: [String: Any]) -> [String: Any] {
    switch command["cmd"] as? String {
    case "reset":
        a.string = command["a"] as? String ?? ""
        b.string = command["b"] as? String ?? ""
        a.mode = command["mode"] as? String ?? "normal"
        a.pastes = 0
        let caret = command["caret"] as? Int ?? a.string.utf16.count
        a.setSelectedRange(NSRange(location: caret, length: command["length"] as? Int ?? 0))
        return ["ok": true]
    case "focus":
        app.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        return ["ok": window.makeFirstResponder(command["field"] as? String == "b" ? b : a)]
    case "state":
        return ["a": a.string, "b": b.string, "pastes": a.pastes, "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()]
    case "fixture":
        guard general.changeCount == start || proofOwned() else { return ["ok": false, "reason": "foreign copy"] }
        let kind = command["kind"] as? String ?? ""
        if kind == "lazy" {
            general.clearContents()
            let item = NSPasteboardItem()
            item.setString("Synthetic lazy copy", forType: .string)
            item.setDataProvider(promise, forTypes: [lazy])
            _ = general.writeObjects([item])
        } else {
            guard let items = fixtures[kind], write(items) else { return ["ok": false] }
        }
        recorded = general.changeCount
        return ["ok": true]
    case "verify":
        // Only booleans: whether the pasteboard holds a fixture exactly, whether anyone wrote
        // since the fixture, and whether Voice's marked temporary value is current.
        let kind = command["kind"] as? String ?? ""
        let unchanged = general.changeCount == recorded
        let voice = general.types?.contains(Kind("com.codlume.voice.insertion")) == true
        let transient = general.types?.contains(Kind("org.nspasteboard.TransientType")) == true
        let matches: Bool
        if kind == "lazy" {
            matches = general.pasteboardItems?.count == 1 && general.types?.contains(lazy) == true
        } else if kind == "transcript" {
            matches = voice && transient && general.string(forType: .string) == command["text"] as? String
        } else {
            matches = fixtures[kind].map(holds) ?? false
        }
        return ["matches": matches, "unchanged": unchanged, "voice": voice]
    case "frame":
        // Screen points with a top-left origin, for a real click into the field.
        let view = command["field"] as? String == "b" ? b : a
        let rect = window.convertToScreen(view.convert(view.bounds, to: nil))
        let height = NSScreen.screens.first?.frame.height ?? 0
        return ["x": rect.midX, "y": height - rect.midY]
    case "exit":
        restoreUser()
        emit(["ok": true])
        exit(0)
    default:
        return ["ok": false]
    }
}
let reader = Thread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        let reply = DispatchQueue.main.sync { MainActor.assumeIsolated { handle(command) } }
        emit(reply)
    }
    DispatchQueue.main.async { restoreUser(); exit(0) }
}
reader.start()
emit(["ready": true, "pid": getpid()])
app.run()
