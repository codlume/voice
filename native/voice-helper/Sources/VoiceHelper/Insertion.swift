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
    private let forceRecovery: Bool

    init(output: Output, forceRecovery: Bool) {
        self.output = output
        self.forceRecovery = forceRecovery
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

    func insert(id: String, text: String, target: (id: String, target: InsertTarget)?) {
        guard let target, target.id == id else {
            output.log(.error, "insert \(id) refused: no finished capture with that id")
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
            return
        }
        let destination = target.target
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.pid else {
            output.emit(.insertResult(id: id, method: .none, reason: .focusChanged))
            return
        }
        guard !IsSecureEventInputEnabled() else {
            output.emit(.insertResult(id: id, method: .none, reason: .secureInput))
            return
        }
        guard let pid = destination.pid, AXIsProcessTrusted() else {
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
            return
        }
        guard let current = verifiedFocus(id: id, target: destination, pid: pid) else { return }
        if forceRecovery {
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
            return
        }
        switch insertViaAccessibility(focused: current.element?.value, text: text) {
        case .inserted:
            output.emit(.insertResult(id: id, method: .accessibility, reason: nil))
        case .notEditable:
            output.emit(.insertResult(id: id, method: .none, reason: .noFocusedField))
        case .unverified:
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
        case .unchanged(let focused, let before):
            // Some apps apply the write after returning. Re-read once before directing the
            // user to recover the transcript manually.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [self] in
                if AXWriteVerdict(before: before, after: textState(of: focused)) == .inserted {
                    output.emit(.insertResult(id: id, method: .accessibility, reason: nil))
                } else {
                    output.emit(.insertResult(id: id, method: .none, reason: .failed))
                }
            }
        }
    }

    private func verifiedFocus(id: String, target: InsertTarget, pid: pid_t) -> TargetFocus<FocusElement>? {
        guard case .captured = target.focus else {
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
            return nil
        }
        let current = readTargetFocus(pid: pid)
        switch target.focus.validate(current) {
        case .unchanged:
            guard case .focused(let focus) = current else { return nil }
            return focus
        case .changed:
            output.log(.info, "insert refused: target focus changed")
            output.emit(.insertResult(id: id, method: .none, reason: .focusChanged))
        case .unverifiable:
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
        }
        return nil
    }

    private enum AccessibilityOutcome {
        case inserted, notEditable, unverified
        case unchanged(AXUIElement, before: AXTextState)
    }

    private func insertViaAccessibility(focused: AXUIElement?, text: String) -> AccessibilityOutcome {
        guard let focused else { return .unverified }
        AXUIElementSetMessagingTimeout(focused, axMessagingTimeout)

        guard isSettable(focused, kAXSelectedTextAttribute) || isSettable(focused, kAXValueAttribute) else {
            return .notEditable
        }
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
}

private let axMessagingTimeout: Float = 0.3

private func focusInputStamp() -> [UInt32] {
    [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
     .leftMouseUp, .rightMouseUp, .otherMouseUp, .mouseMoved,
     .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel, .tabletPointer, .tabletProximity].map {
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
