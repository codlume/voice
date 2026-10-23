import AppKit
import ApplicationServices
import Carbon
import Foundation
import VoiceHelperCore
import os

struct FocusElement: Equatable {
    let value: AXUIElement
    static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.value, rhs.value) }
}

final class InsertTarget {
    let pid: pid_t?
    let bundleId: String?
    var focus = CapturedFocus<FocusElement>.pending
    let host: OSAllocatedUnfairLock<HostRead>

    init(pid: pid_t?, bundleId: String?, host: HostRead = .pending) {
        self.pid = pid
        self.bundleId = bundleId
        self.host = OSAllocatedUnfairLock(initialState: host)
    }

    func settleHost() {
        host.withLock { $0.settle() }
    }

    func takeTranscriptTarget() -> TranscriptTarget? {
        let host = host.withLock { $0.take() }
        guard let bundleId else { return nil }
        return TranscriptTarget(bundleId: bundleId, host: host)
    }
}

final class Insertion {
    private let output: Output
    private let forcePaste: Bool
    private let pasteboard: Pasteboard

    init(output: Output, forcePaste: Bool, pasteboard: Pasteboard) {
        self.output = output
        self.forcePaste = forcePaste
        self.pasteboard = pasteboard
    }

    func recordTarget(pid: pid_t?, bundleId: String?, host: HostRead, log: ((String) -> Void)?) -> InsertTarget {
        let target = InsertTarget(pid: pid, bundleId: bundleId, host: host)
        guard let pid, AXIsProcessTrusted() else {
            target.focus = .unavailable
            target.settleHost()
            return target
        }
        let readHost = host == .pending && isBrowser(bundleId)
        if !readHost { target.settleHost() }
        let input = focusInputStamp()
        let inputUnchanged = { focusInputStamp() == input }
        DispatchQueue.global(qos: .userInitiated).async {
            guard inputUnchanged() else {
                target.settleHost()
                DispatchQueue.main.async { target.focus = .unavailable }
                return
            }
            let first = readTargetFocus(pid: pid)
            let second = readTargetFocus(pid: pid)
            let unchanged = inputUnchanged()
            DispatchQueue.main.async {
                target.focus.resolve(first: first, second: second, inputUnchanged: unchanged
                    && inputUnchanged()
                    && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid)
            }
            guard readHost else { return }
            guard unchanged, case .focused(let focus) = first, first == second else { return target.settleHost() }
            readPageHost(of: target, from: focus, inputUnchanged: inputUnchanged, log: log)
        }
        return target
    }

    /// `origin` is set for a transform run: the selection read earlier must still be the one
    /// under the caret, or the result would land somewhere the user did not mean.
    func insert(id: String, text: String, html: String?, target: InsertTarget?, origin: SelectionOrigin? = nil) {
        let focused: AXUIElement?
        switch check(id: id, target: target, origin: origin) {
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

    private func check(id: String, target destination: InsertTarget?, origin: SelectionOrigin?) -> TargetCheck {
        guard let destination else {
            output.log(.error, "insert \(id) refused: no finished capture or read with that id")
            return .refused(.failed)
        }
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
            if let origin, selectionMoved(origin, element: captured.element?.value) {
                output.log(.info, "insert refused: selection changed since the read")
                return .refused(.selectionChanged)
            }
            return .ready(focused: captured.element?.value)
        case .changed:
            output.log(.info, "insert refused: target focus changed")
            return .refused(.focusChanged)
        case .unverifiable:
            return .refused(.failed)
        }
    }

    private func selectionMoved(_ origin: SelectionOrigin, element: AXUIElement?) -> Bool {
        let current: AXSelectionAnswer?
        if case .accessibility = origin { current = readAXSelection(element) } else { current = nil }
        return writeVerdict(origin: origin, currentAX: current, currentStamp: focusInputStamp()) == .refuseSelectionChanged
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
        let text = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success
            ? value as? String : nil
        var selection: AXTextRange?
        if case .value(let range) = focusAttribute(element, kAXSelectedTextRangeAttribute) {
            selection = axTextRange(range)
        }
        return AXTextState(value: text, selection: selection)
    }

    private func paste(id: String, text: String, html: String?) {
        let write = pasteboard.write(text: text, html: html, saved: pasteboard.save())

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
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [pasteboard] in
            pasteboard.restore(write: write)
        }
    }
}

let axMessagingTimeout: Float = 0.3

/// Only presses can move focus. Pointer motion, scrolling, and releases keep arriving while the
/// shortcut is held, and the snapshot can wait behind microphone start on main, so counting them
/// would refuse insertions whose focus never changed.
func focusInputStamp() -> [UInt32] {
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

private func axTextRange(_ value: CFTypeRef) -> AXTextRange? {
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
    return AXTextRange(location: range.location, length: range.length)
}

/// The focused element's selection as the selection reader and the write guard see it. An
/// explicit zero-length range answers before the text is asked for, so apps that report "" for
/// an unselected field never reach the copy fallback.
func readAXSelection(_ element: AXUIElement?) -> AXSelectionAnswer {
    guard let element else { return .noAnswer }
    AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
    if case .value(let subrole) = focusAttribute(element, kAXSubroleAttribute), subrole as? String == kAXSecureTextFieldSubrole {
        return .secureField
    }
    var range: AXTextRange?
    if case .value(let value) = focusAttribute(element, kAXSelectedTextRangeAttribute), let found = axTextRange(value) {
        if found.length == 0 { return .emptyRange }
        range = found
    }
    guard case .value(let value) = focusAttribute(element, kAXSelectedTextAttribute), let text = value as? String else {
        return .noAnswer
    }
    return .text(text, range: range)
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

func currentLayoutData() -> Data? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
}
