import AppKit
import ApplicationServices
import Carbon
import Foundation
import VoiceHelperCore

final class Insertion {
    private let output: Output
    private let forcePaste: Bool

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
        guard let pid = target.pid else {
            output.emit(.insertResult(id: id, method: .none, reason: .noFocusedField))
            return
        }
        if forcePaste {
            paste(id: id, text: text)
            return
        }
        switch insertViaAccessibility(pid: pid, text: text) {
        case .inserted:
            output.emit(.insertResult(id: id, method: .accessibility, reason: nil))
        case .noFocusedField:
            output.emit(.insertResult(id: id, method: .none, reason: .noFocusedField))
        case .unverified:
            paste(id: id, text: text)
        }
    }

    private enum AccessibilityOutcome { case inserted, noFocusedField, unverified }

    private func insertViaAccessibility(pid: pid_t, text: String) -> AccessibilityOutcome {
        var focusedRef: CFTypeRef?
        let app = AXUIElementCreateApplication(pid)
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
            let focusedRef
        else {
            return .noFocusedField
        }
        let focused = focusedRef as! AXUIElement
        let before = stringValue(of: focused)
        guard AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFString) == .success
        else {
            return .unverified
        }
        let after = stringValue(of: focused)
        // Some views report success and change nothing; only an observable change counts.
        if let before, let after, before == after { return .unverified }
        return .inserted
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
        let saved = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setString(text, forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        item.setString(text, forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        pasteboard.writeObjects([item])
        let ourChange = pasteboard.changeCount

        let source = CGEventSource(stateID: .combinedSessionState)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: down) else { continue }
            event.flags = .maskCommand
            event.post(tap: .cghidEventTap)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [output] in
            if pasteboard.changeCount == ourChange {
                pasteboard.clearContents()
                let items = saved.map { entries in
                    let restored = NSPasteboardItem()
                    for (type, data) in entries { restored.setData(data, forType: type) }
                    return restored
                }
                if !items.isEmpty { pasteboard.writeObjects(items) }
            } else {
                output.log(.info, "clipboard changed during paste; not restoring previous contents")
            }
            output.emit(.insertResult(id: id, method: .paste, reason: nil))
        }
    }
}
