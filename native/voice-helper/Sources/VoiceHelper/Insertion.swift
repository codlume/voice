import AppKit
import ApplicationServices
import Carbon
import Foundation
import VoiceHelperCore

struct FocusElement: Equatable {
    let value: AXUIElement
    static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.value, rhs.value) }
}

final class InsertTarget {
    let pid: pid_t?
    var focus = CapturedFocus<FocusElement>.pending

    init(pid: pid_t?) { self.pid = pid }
}

final class Insertion {
    private let output: Output
    private let forcePaste: Bool
    private typealias PasteboardItem = [(NSPasteboard.PasteboardType, Data)]
    private var clipboard = ClipboardRestore<SavedClipboard<PasteboardItem>>()

    init(output: Output, forcePaste: Bool) {
        self.output = output
        self.forcePaste = forcePaste
    }

    func recordTarget(pid: pid_t?) -> InsertTarget {
        let target = InsertTarget(pid: pid)
        guard let pid, AXIsProcessTrusted() else {
            target.focus = .unavailable
            return target
        }
        let input = focusInputStamp()
        DispatchQueue.global(qos: .userInitiated).async {
            guard focusInputStamp() == input else {
                DispatchQueue.main.async { target.focus = .unavailable }
                return
            }
            let first = readTargetFocus(pid: pid)
            let second = readTargetFocus(pid: pid)
            let inputUnchanged = focusInputStamp() == input
            DispatchQueue.main.async {
                target.focus.resolve(first: first, second: second, inputUnchanged: inputUnchanged
                    && focusInputStamp() == input
                    && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid)
            }
        }
        return target
    }

    func insert(id: String, text: String, html: String?, target: (id: String, target: InsertTarget)?) {
        let focused: AXUIElement?
        switch check(id: id, target: target) {
        case .refused(let reason):
            output.emit(.insertResult(id: id, method: .none, reason: reason))
            return
        case .ready(let element):
            focused = element
        }
        let outcome: AccessibilityOutcome
        if forcePaste {
            outcome = .unverified
        } else if !takesText(focused) {
            outcome = .notEditable
        } else if html != nil {
            // The accessibility write takes plain text only; a paste keeps the formatting.
            outcome = .unverified
        } else {
            outcome = insertViaAccessibility(focused: focused, text: text)
        }
        switch outcome {
        case .inserted:
            output.emit(.insertResult(id: id, method: .accessibility, reason: nil))
        case .notEditable:
            output.emit(.insertResult(id: id, method: .none, reason: .noFocusedField))
        case .unverified:
            paste(id: id, text: text, html: html)
        case .unchanged(let focused, let before):
            // Some apps apply the write after returning. One re-read separates a slow app from
            // Chromium's silent no-op before the paste fallback risks a second copy.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [self] in
                if AXWriteVerdict(before: before, after: textState(of: focused)) == .inserted {
                    output.emit(.insertResult(id: id, method: .accessibility, reason: nil))
                } else {
                    paste(id: id, text: text, html: html)
                }
            }
        }
    }

    private enum TargetCheck {
        case ready(focused: AXUIElement?)
        case refused(InsertFailure)
    }

    private func check(id: String, target: (id: String, target: InsertTarget)?) -> TargetCheck {
        guard let target, target.id == id else {
            output.log(.error, "insert \(id) refused: no finished capture with that id")
            return .refused(.failed)
        }
        let destination = target.target
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.pid else {
            return .refused(.focusChanged)
        }
        guard !IsSecureEventInputEnabled() else { return .refused(.secureInput) }
        // Without accessibility neither the AX write nor the Cmd+V keystroke can reach the app.
        guard let pid = destination.pid, AXIsProcessTrusted(), case .captured(let captured) = destination.focus
        else {
            return .refused(.failed)
        }
        switch destination.focus.validate(readTargetFocus(pid: pid)) {
        case .unchanged:
            return .ready(focused: captured.element?.value)
        case .changed:
            output.log(.info, "insert refused: target focus changed")
            return .refused(.focusChanged)
        case .unverifiable:
            return .refused(.failed)
        }
    }

    private enum AccessibilityOutcome {
        case inserted, notEditable, unverified
        case unchanged(AXUIElement, before: AXTextState)
    }

    // False only when the app describes the focused element and it takes no text (a button, a
    // list, a window): pasting there inserts nothing and may trigger the app's own paste action.
    // No focused element is not proof that nothing is focused: Chromium and Electron answer that
    // way without an accessibility client opt-in, and apps without a tree cannot answer at all.
    // A paste keystroke reaches both.
    private func takesText(_ focused: AXUIElement?) -> Bool {
        guard let focused else { return true }
        AXUIElementSetMessagingTimeout(focused, axMessagingTimeout)
        return isSettable(focused, kAXSelectedTextAttribute) || isSettable(focused, kAXValueAttribute)
    }

    private func insertViaAccessibility(focused: AXUIElement?, text: String) -> AccessibilityOutcome {
        guard let focused else { return .unverified }
        let before = textState(of: focused)
        guard AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFString) == .success
        else {
            return .unverified
        }
        switch AXWriteVerdict(before: before, after: textState(of: focused)) {
        case .inserted: return .inserted
        case .unchanged: return .unchanged(focused, before: before)
        }
    }

    private func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
    }

    private func textState(of element: AXUIElement) -> AXTextState {
        var value: CFTypeRef?
        var range: CFTypeRef?
        let text = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success
            ? value as? String : nil
        var selection: AXTextRange?
        if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &range) == .success,
            let range, CFGetTypeID(range) == AXValueGetTypeID()
        {
            var cfRange = CFRange()
            if AXValueGetValue(range as! AXValue, .cfRange, &cfRange) {
                selection = AXTextRange(location: cfRange.location, length: cfRange.length)
            }
        }
        return AXTextState(value: text, selection: selection)
    }

    private func paste(id: String, text: String, html: String?) {
        let pasteboard = NSPasteboard.general
        let saved = clipboard.contentsToSave(changeCount: pasteboard.changeCount) {
            let items = pasteboard.pasteboardItems ?? []
            return SavedClipboard(types: items.flatMap { $0.types.map(\.rawValue) }) {
                items.map { item in
                    item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
                }
            }
        }
        // Host-only keeps Universal Clipboard from offering the transcript to the user's other devices.
        pasteboard.prepareForNewContents(with: .currentHostOnly)
        let item = NSPasteboardItem()
        // Without the charset, readers decode the HTML as Latin-1 and garble non-ASCII text.
        if let html { item.setString("<meta charset=\"utf-8\">" + html, forType: .html) }
        item.setString(text, forType: .string)
        item.setString(text, forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        item.setString(text, forType: NSPasteboard.PasteboardType(concealedPasteboardType))
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

    private func restore(_ saved: SavedClipboard<PasteboardItem>, to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        guard case .items(let saved) = saved else {
            output.log(.info, "clipboard held concealed contents; cleared instead of restoring")
            return
        }
        let items = saved.map { entries in
            let restored = NSPasteboardItem()
            for (type, data) in entries { restored.setData(data, forType: type) }
            return restored
        }
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }
}

private let axMessagingTimeout: Float = 0.3

/// Only presses can move focus. Pointer motion, scrolling, and releases keep arriving while the
/// shortcut is held, and the snapshot can wait behind microphone start on main, so counting them
/// would refuse insertions whose focus never changed.
private func focusInputStamp() -> [UInt32] {
    [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown].map {
        CGEventSource.counterForEventType(.combinedSessionState, eventType: $0)
    }
}

private enum FocusAttribute {
    case value(CFTypeRef), absent, noAnswer
}

private func focusAttribute(_ element: AXUIElement, _ name: String) -> FocusAttribute {
    var value: CFTypeRef?
    switch AXUIElementCopyAttributeValue(element, name as CFString, &value) {
    case .success:
        return value.map(FocusAttribute.value) ?? .absent
    case .noValue, .attributeUnsupported: return .absent
    default: return .noAnswer
    }
}

private func readTargetFocus(pid: pid_t) -> FocusReread<FocusElement> {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
    let element: FocusElement?
    switch focusAttribute(app, kAXFocusedUIElementAttribute) {
    case .value(let value):
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return .noAnswer }
        element = FocusElement(value: value as! AXUIElement)
    case .absent: element = nil
    case .noAnswer: return .noAnswer
    }
    let window: AXUIElement
    switch focusAttribute(app, kAXFocusedWindowAttribute) {
    case .value(let value):
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return .noAnswer }
        window = value as! AXUIElement
    case .absent: return .nothingFocused
    case .noAnswer: return .noAnswer
    }
    AXUIElementSetMessagingTimeout(window, axMessagingTimeout)
    let title: String?
    switch focusAttribute(window, kAXTitleAttribute) {
    case .value(let value):
        guard let string = value as? String else { return .noAnswer }
        title = string
    case .absent: title = nil
    case .noAnswer: return .noAnswer
    }
    return .focused(TargetFocus(element: element, window: FocusElement(value: window), title: title))
}

private func currentLayoutData() -> Data? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
}
