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
    let pressStamp = focusInputStamp()
    var focus = CapturedFocus<FocusElement>.pending
    /// Who held key focus when the session began. It settles together with `focus`.
    var keyFocus = KeyFocusHolder.noAnswer
    var origin: SelectionOrigin?
    let host: OSAllocatedUnfairLock<HostRead>
    private let cancelled = OSAllocatedUnfairLock(initialState: false)

    init(pid: pid_t?, bundleId: String?, host: HostRead = .pending) {
        self.pid = pid
        self.bundleId = bundleId
        self.host = OSAllocatedUnfairLock(initialState: host)
    }

    var comparesTitle: Bool {
        origin == nil && focusInputStamp() != pressStamp
    }

    var isCancelled: Bool { cancelled.withLock { $0 } }

    func settleHost() {
        host.withLock { $0.settle() }
    }

    /// Ends the reads still running for a target that no insert will use.
    func cancel() {
        cancelled.withLock { $0 = true }
        settleHost()
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
    // Apps whose AX write reported success and still changed nothing on the late re-read, as
    // Chromium does with accessibility on. Kept in memory, so each Voice launch relearns them.
    private var pasteOnlyApps: Set<String> = []

    init(output: Output, forcePaste: Bool, pasteboard: Pasteboard) {
        self.output = output
        self.forcePaste = forcePaste
        self.pasteboard = pasteboard
        // The system-wide element answers only in a process connected to the window server, and
        // nothing else connects the helper before its first paste. Asking for the window with
        // id zero connects and lists no window. The first read after that costs about 30 ms, so
        // it is spent here and not on a session.
        DispatchQueue.global(qos: .utility).async {
            _ = CGWindowListCopyWindowInfo([.optionIncludingWindow], kCGNullWindowID)
            _ = readKeyFocus()
        }
    }

    func recordTarget(id: String, pid: pid_t?, bundleId: String?, host: HostRead, log: ((String) -> Void)?) -> InsertTarget {
        let target = InsertTarget(pid: pid, bundleId: bundleId, host: host)
        guard let pid, AXIsProcessTrusted() else {
            target.settleHost()
            settle(target, id: id, as: .unavailable(pid == nil ? .noApp : .untrusted), attempt: 0)
            return target
        }
        let readHost = host == .pending && isBrowser(bundleId)
        let inputUnchanged = { focusInputStamp() == target.pressStamp }
        let snapshot = FocusSnapshot<FocusElement>(
            read: { readTargetFocus(pid: pid) },
            inputUnchanged: inputUnchanged,
            // `frontmostApplication` is not documented as thread-safe. Main never waits on the
            // snapshot's thread, so the hop cannot deadlock.
            frontmost: { DispatchQueue.main.sync { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid } },
            cancelled: { target.isCancelled },
            pageURL: { pageURL(below: $0.value) },
            pause: { Thread.sleep(forTimeInterval: focusSnapshotRetryDelay) })
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            // Read before the baseline, whose retries can end well after the press.
            let keyFocus = readKeyFocus()
            let (focus, attempt) = snapshot.take()
            DispatchQueue.main.async { [self] in
                target.keyFocus = keyFocus
                settle(target, id: id, as: focus, attempt: attempt)
            }
            if readHost, case .captured(let captured) = focus {
                readPageHost(of: target, from: captured, inputUnchanged: inputUnchanged, log: log)
            } else {
                target.settleHost()
            }
        }
        return target
    }

    private func settle(_ target: InsertTarget, id: String, as focus: CapturedFocus<FocusElement>, attempt: Int) {
        target.focus = focus
        let outcome: String
        switch focus {
        case .captured(let captured): outcome = captured.anchor.element == nil ? "captured windowOnly" : "captured element"
        case .unavailable(let loss): outcome = "unavailable \(loss.rawValue)"
        case .pending: return
        }
        output.log(.info, "target focus \(id): \(outcome), attempt \(attempt)")
    }

    /// Every insert ends here, so each result has one log line naming its branch. The line holds
    /// the session id and enum names, never the transcript, a title, a URL, or the clipboard.
    private func finish(_ id: String, _ outcome: InsertOutcome, why: String? = nil) {
        output.emit(.insertResult(id: id, outcome: outcome))
        let branch: String
        switch outcome {
        case .accessibility(let route): branch = "accessibility \(route.rawValue)"
        case .paste(let route, _): branch = "paste \(route.rawValue)"
        case .refused(let reason): branch = "refused \(reason.rawValue)"
        }
        output.log(.info, "insert \(id): \(branch)" + (why.map { " (\($0))" } ?? ""))
    }

    func insert(id: String, text: String, html: String?, keepOnClipboard: Bool, target: InsertTarget?) {
        dispatchPrecondition(condition: .onQueue(.main))
        // An insert spends its target, so a baseline still retrying has no one left to read for.
        defer { target?.cancel() }
        // Taken before the checks, so a press while they run still refuses the paste keystroke.
        let checked = focusInputStamp()
        let focused: AXUIElement?
        let pasteOnly: String?
        switch check(target: target) {
        case .refused(let reason, let why):
            return finish(id, .refused(reason), why: why)
        case .ready(let element, let why):
            focused = element
            pasteOnly = why
        }
        let outcome: AccessibilityOutcome
        if forcePaste {
            outcome = .paste(.forced)
        } else if !takesText(focused) {
            outcome = .notEditable
        } else if html != nil {
            // The accessibility write takes plain text only; a paste keeps the formatting.
            outcome = .paste(.html)
        } else if let bundleId = target?.bundleId, pasteOnlyApps.contains(bundleId) {
            outcome = .paste(.pasteOnlyApp)
        } else if focused != nil, pasteOnly != nil {
            outcome = .paste(.notKeyFocus)
        } else {
            outcome = insertViaAccessibility(focused: focused, text: text)
        }
        switch outcome {
        case .inserted(let route):
            finish(id, .accessibility(route))
        case .notEditable:
            finish(id, .refused(.noFocusedField), why: "element takes no text")
        case .unknown:
            // Without this an app whose writes always time out would refuse every insert. The
            // next one pastes with no write, so it cannot land twice either.
            if let bundleId = target?.bundleId { pasteOnlyApps.insert(bundleId) }
            finish(id, .refused(.failed), why: "write timed out")
        case .paste(let route):
            paste(
                id: id, text: text, html: html, route: route, keepOnClipboard: keepOnClipboard, pid: target?.pid, checked: checked,
                why: pasteOnly)
        case .unchanged(let focused, let before):
            // Some apps apply the write after returning. One re-read separates a slow app from
            // Chromium's silent no-op before the paste fallback risks a second copy.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [self] in
                if AXWriteVerdict(before: before, after: textState(of: focused)) == .inserted {
                    finish(id, .accessibility(.late))
                } else {
                    if let bundleId = target?.bundleId { pasteOnlyApps.insert(bundleId) }
                    paste(
                        id: id, text: text, html: html, route: .unchanged, keepOnClipboard: keepOnClipboard, pid: target?.pid,
                        checked: checked)
                }
            }
        }
    }

    private enum TargetCheck {
        /// `pasteOnly` is nil when the target app holds key focus. Otherwise it says who does,
        /// and only a keystroke may deliver the text: a write into `focused` could land behind
        /// the window the user is typing in.
        case ready(focused: AXUIElement?, pasteOnly: String?)
        case refused(InsertFailure, why: String)
    }

    private func check(target destination: InsertTarget?) -> TargetCheck {
        guard let destination else { return .refused(.failed, why: "no finished capture or read with that id") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.pid else {
            return .refused(.focusChanged, why: "not frontmost")
        }
        guard !IsSecureEventInputEnabled() else { return .refused(.secureInput, why: "secure input") }
        // Without accessibility neither the AX write nor the Cmd+V keystroke can reach the app.
        guard let pid = destination.pid, AXIsProcessTrusted() else {
            return .refused(.failed, why: destination.pid == nil ? "no app" : "untrusted")
        }
        let captured: TargetFocus<FocusElement>
        switch destination.focus {
        case .captured(let focus): captured = focus
        case .pending: return .refused(.failed, why: "baseline pending")
        case .unavailable(let loss): return .refused(.failed, why: "baseline \(loss.rawValue)")
        }
        let current = readTargetFocus(pid: pid)
        let validation = destination.focus.validate(
            current, comparingTitle: destination.comparesTitle, pageURL: { pageURL(below: $0.value) })
        switch validation {
        case .unchanged:
            if let origin = destination.origin, selectionMoved(origin, element: captured.anchor.element?.value) {
                return .refused(.selectionChanged, why: "selection moved")
            }
            // A window-only baseline names no element. Once the reread does, that element says
            // whether the focus takes text, so a focused button is refused instead of pasted at.
            let element = captured.anchor.element?.value ?? current.focus?.anchor.element?.value
            // Asked last: it waits on the app holding key focus, and a target that hangs has
            // already spent one timeout in the reread above.
            let keyFocus = KeyFocus(target: pid)
            let holder = readKeyFocus()
            let holders = "key focus \(keyFocus.describe(destination.keyFocus)) then \(keyFocus.describe(holder))"
            switch keyFocus.route(atStart: destination.keyFocus, now: holder, selection: destination.origin) {
            case .write: return .ready(focused: element, pasteOnly: nil)
            case .keystroke: return .ready(focused: element, pasteOnly: holders)
            // The keystroke goes to the panel, so its element says whether the focus takes text.
            case .panel(let panel): return .ready(focused: focusedElement(of: panel), pasteOnly: holders)
            case .refused(let refusal): return .refused(.focusChanged, why: "\(holders), \(refusal.rawValue)")
            }
        case .changed(let change):
            return .refused(.focusChanged, why: "focus \(change.rawValue)")
        case .unverifiable:
            return .refused(.failed, why: "reread noAnswer")
        }
    }

    private func selectionMoved(_ origin: SelectionOrigin, element: AXUIElement?) -> Bool {
        writeVerdict(origin: origin, readAX: { readAXSelection(element) }, readStamp: focusInputStamp) == .refuseSelectionChanged
    }

    private enum AccessibilityOutcome {
        case inserted(AccessibilityRoute)
        case notEditable, unknown
        case paste(PasteRoute)
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
        guard let focused else { return .paste(.noElement) }
        let before = textState(of: focused)
        let sent = DispatchTime.now()
        let error = AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFString)
        let answer = AXWriteAnswer(error, waited: elapsed(since: sent), timeout: TimeInterval(axMessagingTimeout))
        switch AXWritePlan(answer: answer, before: before, after: { textState(of: focused) }) {
        case .inserted(let route): return .inserted(route)
        case .paste(let route): return .paste(route)
        case .reread: return .unchanged(focused, before: before)
        case .unknown: return .unknown
        }
    }

    private func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
    }

    private func textState(of element: AXUIElement) -> AXTextState {
        var selection: AXTextRange?
        if case .value(let range) = focusAttribute(element, kAXSelectedTextRangeAttribute) {
            selection = axTextRange(range)
        }
        return AXTextState(length: textLength(of: element), selection: selection)
    }

    // The count answers without copying the document. An element that has no count still gets
    // the value read, so one that was observable before the write stays observable after it and
    // a silent no-op still reaches the paste fallback.
    private func textLength(of element: AXUIElement) -> Int? {
        if case .value(let count) = focusAttribute(element, kAXNumberOfCharactersAttribute), let length = count as? Int {
            return length
        }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
            let text = value as? String
        else { return nil }
        return text.utf16.count
    }

    private func paste(
        id: String, text: String, html: String?, route: PasteRoute, keepOnClipboard: Bool, pid: pid_t?, checked: PressStamp,
        why: String? = nil
    ) {
        var clipboardSaveMs = 0.0
        let attempt = pasteKeystroke(
            save: { [pasteboard] in
                let saving = DispatchTime.now()
                defer { clipboardSaveMs = saving.millisecondsToNow() }
                return keepOnClipboard ? nil : pasteboard.save()
            },
            refusal: {
                KeystrokeDestination(
                    presses: focusInputStamp(), frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                    secureInput: IsSecureEventInputEnabled()
                ).refusal(target: pid, checked: checked)
            },
            write: { [pasteboard] in pasteboard.write(text: text, html: html, saved: $0) },
            post: { postCommand(typing: "v", fallback: PasteKey.ansiV) })
        let write: Int
        switch attempt {
        case .refused(let refusal):
            return finish(id, .refused(refusal.failure), why: "\(refusal.rawValue) before paste")
        case .posted(let posted):
            write = posted
        }
        // The target handles Cmd+V asynchronously and nothing here can observe it land, so the
        // result reports the keystroke, not the insertion. The restore only protects the user's
        // clipboard. A slow target (Electron under load, a remote desktop) can read the
        // pasteboard well after the keystroke, so the restore waits a full second.
        finish(id, .paste(route, clipboardSaveMs: clipboardSaveMs), why: why)
        guard !keepOnClipboard else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Pasteboard.pasteRestoreDelay) { [pasteboard] in
            pasteboard.restore(write: write)
        }
    }
}

let axMessagingTimeout: Float = 0.3

/// A transient miss gets two more snapshots while the user is still speaking, if the session's
/// first read named a target. The spacing is an estimate of how long Chromium takes to build its
/// tree, not a measurement. An app that never answers gets no retry and settles the baseline
/// after one timeout. One that answers each call just inside its timeout can take seconds, so
/// the selection reader still relies on its own `focusDeadline`, and an insert that arrives
/// first refuses with the baseline pending.
private let focusSnapshotRetryDelay: TimeInterval = 0.2

/// Only presses can move focus. Pointer motion, scrolling, and releases keep arriving while the
/// shortcut is held, and the snapshot can wait behind microphone start on main, so counting them
/// would refuse insertions whose focus never changed.
func focusInputStamp() -> PressStamp {
    PressStamp(counts: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown].map {
        CGEventSource.counterForEventType(.combinedSessionState, eventType: $0)
    })
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

/// One round trip to the app that holds key focus, so it can cost that app's timeout.
func readKeyFocus() -> KeyFocusHolder {
    let system = AXUIElementCreateSystemWide()
    // On the system-wide element this is the process default, for elements given no timeout
    // of their own. Every element the helper reads is given this same one.
    AXUIElementSetMessagingTimeout(system, axMessagingTimeout)
    var value: CFTypeRef?
    switch AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &value) {
    case .success:
        var pid: pid_t = 0
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID(),
            AXUIElementGetPid(value as! AXUIElement, &pid) == .success
        else { return .noAnswer }
        return .app(pid)
    case .noValue: return .unnamed
    default: return .noAnswer
    }
}

private func focusedElement(of pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
    guard case .value(let value) = focusAttribute(app, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
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
    let anchor = element.map(FocusAnchor.element) ?? .windowOnly(pageURL: pageURL(below: window))
    return .focused(TargetFocus(anchor: anchor, window: FocusElement(value: window), title: title))
}

func currentLayoutData() -> Data? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
}

/// Presses and releases the key that types `character` under Command in the current layout,
/// with Command as the only flag: a modifier the user still holds must not ride along.
func postCommand(typing character: Character, fallback: CGKeyCode) {
    let source = CGEventSource(stateID: .combinedSessionState)
    let key = currentLayoutData().flatMap { PasteKey.keycode(typing: character, in: $0) } ?? fallback
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { continue }
        event.flags = .maskCommand
        event.post(tap: .cghidEventTap)
    }
}

func elapsed(since start: DispatchTime) -> TimeInterval {
    TimeInterval(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
}
