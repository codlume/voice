import AppKit
@preconcurrency import ApplicationServices
import VoiceHelperProtocol

// Remembers the external editable target for one session and inserts into it later.
// It reads only element identity, role, and selection ranges. It never reads document text,
// selection contents, or clipboard data, and it never activates another application.
@MainActor
final class TargetService {
    private struct Watched {
        let session: String
        let pid: pid_t
        let application: AXUIElement
        let element: AXUIElement
        var fault: InsertionOutcome?
    }
    private let emit: @Sendable (Data) -> Void
    private let lastInput: () -> DispatchTime
    private var watched: Watched?
    private var observer: AXObserver?
    private var activation: NSObjectProtocol?
    private var armed: (session: String, since: DispatchTime)?
    private var pendingEvaluation: DispatchWorkItem?
    // Terminals need a non-executing route, which is not established yet.
    private let terminals: Set<String> = [
        "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "dev.warp.Warp",
        "io.alacritty", "org.alacritty", "com.github.wez.wezterm", "net.kovidgoyal.kitty",
        "com.mitchellh.ghostty", "co.zeit.hyper",
    ]
    init(emit: @escaping @Sendable (Data) -> Void, lastInput: @escaping () -> DispatchTime) {
        self.emit = emit
        self.lastInput = lastInput
    }

    func receive(_ command: SetupCommand) -> SetupResult? {
        switch command {
        case .captureTarget(let session):
            release()
            let (status, app, focus) = inspect()
            if status == .eligible, let focus { watch(session, focus) }
            return .target(session: session, status: status, app: app)
        case .armTarget(let session):
            release()
            armed = (session, .now())
            observeActivation(session)
            return .armed(session: session)
        case .releaseTarget(let session):
            if watched?.session == session || armed?.session == session { release() }
            return .released(session: session)
        case .insertTarget(let session, let text):
            return .insertion(session: session, outcome: insert(session, text))
        default:
            return nil
        }
    }
    // Any user input after arming schedules a check; focus settles after the event reaches the app.
    func userInput() {
        guard armed != nil else { return }
        pendingEvaluation?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.evaluateArmed() } }
        pendingEvaluation = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150), execute: work)
    }
    func release() {
        pendingEvaluation?.cancel()
        pendingEvaluation = nil
        armed = nil
        watched = nil
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
    }

    private func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }
    private func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var result = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &result) == .success && result.boolValue
    }
    private func range(_ element: AXUIElement) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var result = CFRange()
        // The generic value was type-checked above.
        guard AXValueGetValue(unsafeDowncast(value, to: AXValue.self), .cfRange, &result) else { return nil }
        return result
    }
    private func focused(_ application: AXUIElement) -> (AXError, AXUIElement?) {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &value)
        guard error == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return (error, nil) }
        // The generic value was type-checked above.
        let element = unsafeDowncast(value, to: AXUIElement.self)
        AXUIElementSetMessagingTimeout(element, 1)
        return (error, element)
    }
    private func inspect() -> (TargetStatus, String?, (AXUIElement, AXUIElement)?) {
        guard let front = NSWorkspace.shared.frontmostApplication else { return (.unavailable, nil, nil) }
        let pid = front.processIdentifier
        let bundle = front.bundleIdentifier
        if pid == getppid() || pid == ProcessInfo.processInfo.processIdentifier { return (.none, bundle, nil) }
        if let bundle, terminals.contains(bundle) { return (.terminal, bundle, nil) }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 1)
        let (error, element) = focused(application)
        guard let element else {
            return (error == .apiDisabled || error == .cannotComplete || error == .notImplemented ? .unavailable : .none, bundle, nil)
        }
        if string(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole { return (.protected, bundle, nil) }
        let role = string(element, kAXRoleAttribute)
        guard role == kAXTextAreaRole || role == kAXTextFieldRole,
              settable(element, kAXSelectedTextAttribute), range(element) != nil else { return (.unsupported, bundle, nil) }
        return (.eligible, bundle, (application, element))
    }
    private func watch(_ session: String, _ focus: (AXUIElement, AXUIElement)) {
        let (application, element) = focus
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        watched = Watched(session: session, pid: pid, application: application, element: element, fault: nil)
        observeActivation(session)
        let callback: AXObserverCallback = { _, element, notification, refcon in
            guard let refcon else { return }
            let service = Unmanaged<TargetService>.fromOpaque(refcon).takeUnretainedValue()
            let name = notification as String
            MainActor.assumeIsolated { service.focusChanged(element, destroyed: name == kAXUIElementDestroyedNotification) }
        }
        var created: AXObserver?
        guard AXObserverCreate(pid, callback, &created) == .success, let created else { return }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(created, application, kAXFocusedUIElementChangedNotification as CFString, refcon)
        AXObserverAddNotification(created, element, kAXUIElementDestroyedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
        observer = created
    }
    private func observeActivation(_ session: String) {
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated { self?.activated(pid, session) }
        }
    }
    private func activated(_ pid: pid_t?, _ session: String) {
        if let current = watched, current.session == session, current.pid != pid, current.fault == nil {
            watched?.fault = .changed
        }
        if armed?.session == session { evaluateArmed() }
    }
    private func focusChanged(_ element: AXUIElement, destroyed: Bool) {
        guard var current = watched, current.fault == nil else { return }
        if destroyed { current.fault = .closed } else if !CFEqual(element, current.element) { current.fault = .changed }
        watched = current
    }
    private func evaluateArmed() {
        guard let armed, lastInput() > armed.since else { return }
        let (status, app, focus) = inspect()
        guard status == .eligible, let focus else { return }
        self.armed = nil
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        watch(armed.session, focus)
        let event: [String: Any] = ["type": "target.selected", "session": armed.session, "status": status.rawValue, "app": app as Any? ?? NSNull()]
        if let data = try? JSONSerialization.data(withJSONObject: event) { emit(data) }
    }
    private func insert(_ session: String, _ text: String) -> InsertionOutcome {
        guard let current = watched, current.session == session else { return .missing }
        defer { release() }
        if let fault = current.fault { return fault }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == current.pid else { return .changed }
        let (error, element) = focused(current.application)
        guard let element, CFEqual(element, current.element) else { return error == .invalidUIElement ? .closed : .changed }
        if string(current.element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole { return .protected }
        guard settable(current.element, kAXSelectedTextAttribute) else { return .unsupported }
        let before = range(current.element)
        let result = AXUIElementSetAttributeValue(current.element, kAXSelectedTextAttribute as CFString, text as CFString)
        switch result {
        case .success:
            // Confirm placement from the collapsed selection after the insert, not from document text.
            guard let before, let after = range(current.element), after.length == 0,
                  after.location == before.location + text.utf16.count else { return .uncertain }
            return .inserted
        case .invalidUIElement: return .closed
        case .cannotComplete, .failure: return .uncertain
        default: return .failed
        }
    }
}
