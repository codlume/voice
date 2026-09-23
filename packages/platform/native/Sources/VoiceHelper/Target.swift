import AppKit
@preconcurrency import ApplicationServices
import Carbon
import VoiceHelperInsertion
import VoiceHelperProtocol

// Remembers the external editable target for one session and inserts into it later.
// It reads only element identity, role, and selection ranges. It never reads document text or
// selection contents, and it never activates another application. A field without an
// Accessibility text write gets a clipboard paste instead, whose prior clipboard contents stay
// inside `Clipboard` for the duration of that one paste. A terminal gets typed, single-line text
// (see `terminalLine`), so dictation can never run a command.
// All Accessibility calls run on a dedicated run-loop thread, so a slow or hung target app
// can never stall the main thread that services the shortcut event tap.
final class TargetService: @unchecked Sendable {
    private struct Watched {
        let session: String
        let pid: pid_t
        let application: AXUIElement
        let element: AXUIElement
        var fault: InsertionOutcome?
    }
    private final class Box<Value>: @unchecked Sendable { var value: Value? }
    private let emit: @Sendable (Data) -> Void
    private let loop: CFRunLoop
    private let clipboard = Clipboard(.general)
    // Everything below is touched only on the service thread.
    private var watched: Watched?
    private var observer: AXObserver?
    private var activation: NSObjectProtocol?
    private var armed: (session: String, since: DispatchTime)?
    private var lastInput = DispatchTime.now()
    private var evaluation = 0
    // Without NSApplication, NSWorkspace.frontmostApplication stays stale unless the process
    // observes workspace activation. This observer keeps it current between sessions, so a
    // session never remembers, or revalidates against, an app the user already left.
    private var frontmost: NSObjectProtocol?
    // Terminals take typed text only. Their Accessibility view is a scrollback buffer, not an
    // editable field, so they are recognised by bundle rather than by role.
    private let terminals: Set<String> = [
        "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "dev.warp.Warp",
        "io.alacritty", "org.alacritty", "com.github.wez.wezterm", "net.kovidgoyal.kitty",
        "com.mitchellh.ghostty", "co.zeit.hyper",
    ]
    init(emit: @escaping @Sendable (Data) -> Void) {
        self.emit = emit
        let box = Box<CFRunLoop>()
        let started = DispatchSemaphore(value: 0)
        let thread = Thread {
            RunLoop.current.add(Port(), forMode: .default)
            box.value = CFRunLoopGetCurrent()
            started.signal()
            CFRunLoopRun()
        }
        thread.name = "voice.target"
        thread.start()
        started.wait()
        guard let loop = box.value else { fatalError("Target thread did not start") }
        self.loop = loop
        frontmost = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
        ) { _ in }
    }

    // Handles target commands on the service thread; other commands return nil without hopping.
    func receive(_ command: SetupCommand) -> SetupResult? {
        switch command {
        case .captureTarget, .armTarget, .releaseTarget, .insertTarget:
            return perform { self.handle(command) }
        default:
            return nil
        }
    }
    // Any user input after arming schedules a check; focus settles after the event reaches the app.
    func userInput() {
        schedule {
            self.lastInput = .now()
            guard self.armed != nil else { return }
            self.evaluation += 1
            let token = self.evaluation
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(150)) {
                self.schedule { if self.evaluation == token { self.evaluateArmed() } }
            }
        }
    }
    func shutdown() {
        perform { self.release() }
        CFRunLoopStop(loop)
    }
    // For a helper that is being terminated mid-paste: put back a clipboard Voice still owns.
    func abandonPaste() { _ = clipboard.restore() }

    private func perform<Value: Sendable>(_ body: @escaping @Sendable () -> Value) -> Value {
        if CFRunLoopGetCurrent() == loop { return body() }
        let done = DispatchSemaphore(value: 0)
        let result = Box<Value>()
        CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue) {
            result.value = body()
            done.signal()
        }
        CFRunLoopWakeUp(loop)
        done.wait()
        guard let value = result.value else { fatalError("Target thread produced no result") }
        return value
    }
    private func schedule(_ body: @escaping @Sendable () -> Void) {
        CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue, body)
        CFRunLoopWakeUp(loop)
    }
    private func handle(_ command: SetupCommand) -> SetupResult? {
        switch command {
        case .captureTarget(let session):
            release()
            let (status, focus) = inspect()
            // A target that cannot be watched for focus changes is not safe for automatic delivery.
            if status == .eligible, let focus { return .target(session: session, status: watch(session, focus) ? .eligible : .unavailable) }
            return .target(session: session, status: status)
        case .armTarget(let session):
            release()
            armed = (session, .now())
            observeActivation(session)
            return .armed(session: session)
        case .releaseTarget(let session):
            if watched?.session == session || armed?.session == session { release() }
            return .released(session: session)
        case .insertTarget(let session, let text):
            return .insertion(session: session, result: insert(session, text))
        default:
            return nil
        }
    }
    private func release() {
        evaluation += 1
        armed = nil
        watched = nil
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        if let observer { CFRunLoopRemoveSource(loop, AXObserverGetRunLoopSource(observer), .defaultMode) }
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
    private func inspect() -> (TargetStatus, (AXUIElement, AXUIElement)?) {
        guard let front = NSWorkspace.shared.frontmostApplication else { return (.unavailable, nil) }
        let pid = front.processIdentifier
        if pid == getppid() || pid == ProcessInfo.processInfo.processIdentifier { return (.none, nil) }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 1)
        // Electron apps (Slack, VS Code, Notion) and Chromium build their Accessibility tree only
        // once an assistive client asks; without it the focused element is the bare window. Apps
        // that do not know the attribute reject it harmlessly.
        AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        let (error, element) = focused(application)
        guard let element else {
            return (error == .apiDisabled || error == .cannotComplete || error == .notImplemented ? .unavailable : .none, nil)
        }
        if string(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole { return (.protected, nil) }
        // Secure keyboard entry (a password prompt, or the Terminal menu setting) withholds typing.
        if terminal(pid) { return IsSecureEventInputEnabled() ? (.protected, nil) : (.eligible, (application, element)) }
        let role = string(element, kAXRoleAttribute)
        // A readable selection is required either way: it confirms a native write or a paste.
        guard role == kAXTextAreaRole || role == kAXTextFieldRole, range(element) != nil else { return (.unsupported, nil) }
        return (.eligible, (application, element))
    }
    // Returns false, leaving nothing watched, when focus changes inside the app cannot be observed.
    private func watch(_ session: String, _ focus: (AXUIElement, AXUIElement)) -> Bool {
        let (application, element) = focus
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        let callback: AXObserverCallback = { _, element, notification, refcon in
            guard let refcon else { return }
            let service = Unmanaged<TargetService>.fromOpaque(refcon).takeUnretainedValue()
            service.focusChanged(element, destroyed: notification as String == kAXUIElementDestroyedNotification)
        }
        var created: AXObserver?
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard AXObserverCreate(pid, callback, &created) == .success, let created,
              AXObserverAddNotification(created, application, kAXFocusedUIElementChangedNotification as CFString, refcon) == .success,
              AXObserverAddNotification(created, element, kAXUIElementDestroyedNotification as CFString, refcon) == .success else {
            release()
            return false
        }
        CFRunLoopAddSource(loop, AXObserverGetRunLoopSource(created), .defaultMode)
        observer = created
        watched = Watched(session: session, pid: pid, application: application, element: element, fault: nil)
        observeActivation(session)
        return true
    }
    private func observeActivation(_ session: String) {
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
        ) { [weak self] note in
            guard let service = self else { return }
            let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            service.schedule { service.activated(pid, session) }
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
        guard let armed, lastInput > armed.since else { return }
        let (status, focus) = inspect()
        guard status == .eligible, let focus else { return }
        self.armed = nil
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        guard watch(armed.session, focus) else { return }
        let event: [String: Any] = ["type": "target.selected", "session": armed.session, "status": status.rawValue]
        if let data = try? JSONSerialization.data(withJSONObject: event) { emit(data) }
    }
    private func terminal(_ pid: pid_t) -> Bool {
        NSRunningApplication(processIdentifier: pid)?.bundleIdentifier.map(terminals.contains) ?? false
    }
    // Why the remembered target may not receive text now, or nil when it still may.
    private func refusal(_ session: String) -> InsertionOutcome? {
        guard let current = watched, current.session == session else { return .missing }
        if let fault = current.fault { return fault }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == current.pid else { return .changed }
        let (error, element) = focused(current.application)
        guard let element, CFEqual(element, current.element) else { return error == .invalidUIElement ? .closed : .changed }
        if string(current.element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole { return .protected }
        if terminal(current.pid), IsSecureEventInputEnabled() { return .protected }
        return nil
    }
    private func insert(_ session: String, _ text: String) -> InsertionResult {
        guard let current = watched, current.session == session else { return InsertionResult(.missing) }
        defer { release() }
        if let refusal = refusal(session) { return InsertionResult(refusal) }
        // A terminal gives no evidence of what it received without reading its buffer, so typed
        // text is always uncertain: "Check your target", never retyped.
        if terminal(current.pid) { return InsertionResult(type(terminalLine(text), to: current.pid) ? .uncertain : .failed) }
        let length = text.utf16.count
        // Placement is confirmed from the collapsed selection after the insert, never from text.
        func advanced(_ before: CFRange?) -> Bool {
            guard let before, let after = range(current.element) else { return false }
            return after.length == 0 && after.location == before.location + length
        }
        let native: (() -> InsertionOutcome?)? = settable(current.element, kAXSelectedTextAttribute) ? {
            let before = self.range(current.element)
            let result = AXUIElementSetAttributeValue(current.element, kAXSelectedTextAttribute as CFString, text as CFString)
            return nativeOutcome(result, confirmed: result == .success && advanced(before))
        } : nil
        var before: CFRange?
        return deliver(text, native: native, clipboard: clipboard, steps: PasteSteps(
            ready: {
                // Deliver focus notifications that arrived meanwhile; a focus change stays a fault.
                CFRunLoopRunInMode(.defaultMode, 0, false)
                if let refusal = self.refusal(session) { return refusal }
                before = self.range(current.element)
                return before == nil ? .unsupported : nil
            },
            paste: { self.paste(to: current.pid) },
            consumed: {
                // The target has taken the paste once its selection lands right after the text.
                // Past the bound the result is uncertain and the clipboard is still restored: a
                // target that handles the paste even later would paste the user's own content,
                // which is less harmful than leaving the transcript over it.
                let deadline = DispatchTime.now() + .milliseconds(1500)
                while DispatchTime.now() < deadline {
                    if advanced(before) { return true }
                    CFRunLoopRunInMode(.defaultMode, 0.01, false)
                }
                return advanced(before)
            }
        ))
    }
    // Command-V delivered to the target process only, from a private event source so keys the
    // user is holding do not change it. The key is the one typing "v" in the current layout.
    private func paste(to pid: pid_t) -> Bool {
        let key = DispatchQueue.main.sync { TargetService.key(typing: "v") } ?? CGKeyCode(kVK_ANSI_V)
        let source = CGEventSource(stateID: .privateState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else { return false }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.postToPid(pid)
        up.postToPid(pid)
        return true
    }
    // Unicode keyboard events to the target process only, so no key code or modifier the user is
    // holding reinterprets them. Printable characters only; see `terminalLine`.
    private func type(_ text: String, to pid: pid_t) -> Bool {
        let source = CGEventSource(stateID: .privateState)
        for chunk in typingChunks(text) {
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return false }
            for event in [down, up] {
                event.flags = []
                chunk.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                event.postToPid(pid)
            }
        }
        return true
    }
    private static func key(typing character: String) -> CGKeyCode? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
        return data.withUnsafeBytes { bytes -> CGKeyCode? in
            guard let layout = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
            for code in 0..<128 {
                var dead: UInt32 = 0
                var length = 0
                var characters = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
                                            OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, characters.count, &length, &characters)
                if status == noErr, length == 1, String(utf16CodeUnits: characters, count: 1) == character { return CGKeyCode(code) }
            }
            return nil
        }
    }
}
