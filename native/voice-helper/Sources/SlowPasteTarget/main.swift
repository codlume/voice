import AppKit

func now() -> Double { Date().timeIntervalSince1970 * 1000 }

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

final class TargetTextView: NSTextView {
    private(set) var pasteAttempts = 0

    override func paste(_ sender: Any?) {
        pasteAttempts += 1
        emit(["event": "pasteAttempt", "at": now()])
    }
}

let pasteboard = NSPasteboard.general

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let menu = NSMenu()
let appItem = NSMenuItem()
menu.addItem(appItem)
let editItem = NSMenuItem()
menu.addItem(editItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editItem.submenu = editMenu
app.mainMenu = menu

let window = NSWindow(
    contentRect: NSRect(x: 200, y: 200, width: 480, height: 200),
    styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Voice slow paste target"
let textView = TargetTextView(frame: window.contentView?.bounds ?? .zero)
textView.isRichText = false
window.contentView = textView
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(textView)
app.activate(ignoringOtherApps: true)
let checkpoint = NSEvent.addLocalMonitorForEvents(matching: .applicationDefined) { event in
    guard event.subtype.rawValue == 1 else { return event }
    emit([
        "event": "state",
        "targetIsEmpty": textView.string.isEmpty,
        "pasteAttempts": textView.pasteAttempts,
        "changeCount": pasteboard.changeCount,
    ])
    return nil
}

Thread {
    while let line = readLine() {
        let parts = line.split(separator: " ")
        Task { @MainActor in
            switch parts.first {
            case "busy":
                guard let ms = parts.dropFirst().first.flatMap({ Double($0) }) else { return }
                emit(["event": "busyStart", "at": now(), "ms": ms])
                usleep(useconds_t(ms * 1000))
                emit(["event": "busyEnd", "at": now()])
            case "activate":
                app.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
                emit([
                    "event": "activated",
                    "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
                ])
            case "state":
                // A queued checkpoint observes key events already waiting behind the busy target.
                if let event = NSEvent.otherEvent(
                    with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0,
                    windowNumber: window.windowNumber, context: nil, subtype: 1, data1: 0, data2: 0
                ) {
                    app.postEvent(event, atStart: false)
                }
            case "quit":
                emit(["event": "quit"])
                exit(0)
            default:
                break
            }
        }
    }
    Task { @MainActor in
        exit(0)
    }
}.start()

emit(["event": "ready", "pid": getpid(), "changeCount": pasteboard.changeCount])
app.run()
