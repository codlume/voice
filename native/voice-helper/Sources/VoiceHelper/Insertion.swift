import AppKit
import ApplicationServices
import Carbon
import Foundation
import VoiceHelperCore

final class Insertion {
    private let output: Output
    private let forceRecovery: Bool

    init(output: Output, forceRecovery: Bool) {
        self.output = output
        self.forceRecovery = forceRecovery
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
        guard let pid = target.pid, AXIsProcessTrusted() else {
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
            return
        }
        if forceRecovery {
            output.emit(.insertResult(id: id, method: .none, reason: .failed))
            return
        }
        switch insertViaAccessibility(pid: pid, text: text) {
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

    private enum AccessibilityOutcome {
        case inserted, notEditable, unverified
        case unchanged(AXUIElement, before: AXTextState)
    }

    private func insertViaAccessibility(pid: pid_t, text: String) -> AccessibilityOutcome {
        var focusedRef: CFTypeRef?
        let app = AXUIElementCreateApplication(pid)
        // Bound synchronous AX calls so an unresponsive target cannot delay manual recovery.
        AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
        // Missing AX focus does not prove there is no editable field. Keep the transcript for
        // manual recovery because a blind paste cannot acknowledge completion safely.
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
            let focusedRef
        else {
            return .unverified
        }
        let focused = focusedRef as! AXUIElement
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
