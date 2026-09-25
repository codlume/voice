import AppKit
import ApplicationServices
import Carbon
import Foundation
import VoiceHelperCore

final class Insertion {
    private let output: Output
    private let forcePaste: Bool
    private var clipboard = ClipboardRestore<[[(NSPasteboard.PasteboardType, Data)]]>()

    init(output: Output, forcePaste: Bool) {
        self.output = output
        self.forcePaste = forcePaste
    }

    func insert(id: String, text: String, target: (id: String, pid: pid_t?)?) {
        guard let target, target.id == id else {
            output.log(.error, "insert \(id) refused: no finished capture with that id")
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
            return
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else {
            output.emit(.insertResult(id: id, method: .none, reason: .focusChanged))
            return
        }
        guard !IsSecureEventInputEnabled() else {
            output.emit(.insertResult(id: id, method: .none, reason: .secureInput))
            return
        }
        // Without accessibility neither the AX write nor the Cmd+V keystroke can reach the app.
        guard let pid = target.pid, AXIsProcessTrusted() else {
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
            return
        }
        if forcePaste {
            paste(id: id, text: text)
            return
        }
        switch insertViaAccessibility(pid: pid, text: text) {
        case .inserted:
            output.emit(.insertResult(id: id, method: .accessibility, reason: nil))
        case .notEditable:
            output.emit(.insertResult(id: id, method: .none, reason: .noFocusedField))
        case .unverified:
            paste(id: id, text: text)
        }
    }

    private enum AccessibilityOutcome { case inserted, notEditable, unverified }

    private func insertViaAccessibility(pid: pid_t, text: String) -> AccessibilityOutcome {
        var focusedRef: CFTypeRef?
        let app = AXUIElementCreateApplication(pid)
        // No focused element is not proof that nothing is focused: Chromium and Electron answer
        // that way without an accessibility client opt-in, and apps without a tree cannot
        // answer at all. A paste keystroke reaches both.
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
            let focusedRef
        else {
            return .unverified
        }
        let focused = focusedRef as! AXUIElement
        // The app describes the focused element, and it takes no text (a button, a list, a
        // window): pasting there inserts nothing and may trigger the app's own paste action.
        guard isSettable(focused, kAXSelectedTextAttribute) || isSettable(focused, kAXValueAttribute) else {
            return .notEditable
        }
        guard let before = stringValue(of: focused) else { return .unverified }
        guard AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFString) == .success,
            let after = stringValue(of: focused), after != before
        else {
            // Chromium reports success for this write and changes nothing.
            return .unverified
        }
        return .inserted
    }

    private func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
    }

    private func stringValue(of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success else {
            return nil
        }
        return value as? String
    }

    private func paste(id: String, text: String) {
        let pasteboard = NSPasteboard.general
        let saved = clipboard.contentsToSave(changeCount: pasteboard.changeCount) {
            (pasteboard.pasteboardItems ?? []).map { item in
                item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
            }
        }
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setString(text, forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        item.setString(text, forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        pasteboard.writeObjects([item])
        let ourChange = pasteboard.changeCount
        clipboard.wrote(ourChange, saved: saved)

        let source = CGEventSource(stateID: .combinedSessionState)
        let key = currentLayoutData().flatMap { PasteKey.keycode(typing: "v", in: $0) } ?? PasteKey.ansiV
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { continue }
            event.flags = .maskCommand
            event.post(tap: .cghidEventTap)
        }

        // The target handles Cmd+V asynchronously. The result gives it a moment to land but
        // does not wait for the restore, which only protects the user's clipboard. A slow
        // target (Electron under load, a remote desktop) can read the pasteboard well after the
        // keystroke, so the restore waits a full second.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [output] in
            output.emit(.insertResult(id: id, method: .paste, reason: nil))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [self] in
            guard let saved = clipboard.restore(write: ourChange, changeCount: pasteboard.changeCount) else {
                output.log(.info, "clipboard changed during paste; not restoring previous contents")
                return
            }
            restore(saved, to: pasteboard)
        }
    }

    /// Runs a restore still waiting on its timer, so an exit inside the window does not leave
    /// the transcript on the user's clipboard.
    func shutdown() {
        let pasteboard = NSPasteboard.general
        guard let saved = clipboard.flush(changeCount: pasteboard.changeCount) else { return }
        restore(saved, to: pasteboard)
    }

    private func restore(_ saved: [[(NSPasteboard.PasteboardType, Data)]], to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        let items = saved.map { entries in
            let restored = NSPasteboardItem()
            for (type, data) in entries { restored.setData(data, forType: type) }
            return restored
        }
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }
}

private func currentLayoutData() -> Data? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
}
