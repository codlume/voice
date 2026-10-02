import ApplicationServices
import Foundation
import VoiceHelperCore

/// Owns the CGEventTap on a thread of its own. The system disables a tap whose callback
/// stalls, and a disabled tap loses the key release that ends recording, so nothing that can
/// block (AX calls, engine start, pasteboard IO) may share this thread. Every stored property
/// below the run loop is touched only on that thread; `configure` and `install` hop onto it.
final class HotkeyTap {
    private let output: Output
    private let captureActive: () -> Bool
    private let runLoop: CFRunLoop
    private let thread: Thread
    private var key: HotkeyKey = .fn
    private var interpreter: HotkeyInterpreter
    private var tap: CFMachPort?
    private var retry: Timer?
    private var backstop: Timer?
    private var reportedFailure = false

    init(output: Output, captureActive: @escaping () -> Bool) {
        self.output = output
        self.captureActive = captureActive
        interpreter = HotkeyInterpreter(key: .fn, initialFlags: currentFlags())
        let ready = DispatchSemaphore(value: 0)
        var loop: CFRunLoop?
        thread = Thread {
            loop = CFRunLoopGetCurrent()
            // A run loop with no sources returns at once; the port keeps it alive until the
            // tap's own source arrives.
            RunLoop.current.add(Port(), forMode: .default)
            ready.signal()
            RunLoop.current.run()
        }
        thread.name = "hotkey-tap"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
        runLoop = loop!
    }

    func configure(_ key: HotkeyKey) {
        perform {
            let oldKeyRelease = self.interpreter.reconcile(flags: 0)
            if let action = oldKeyRelease {
                self.output.emit(.hotkey(action: action))
            }
            self.key = key
            self.interpreter = HotkeyInterpreter(key: key, initialFlags: currentFlags())
            self.syncBackstop()
        }
    }

    func install() {
        perform { self.installOnTapThread() }
    }

    private func perform(_ block: @escaping () -> Void) {
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, block)
        CFRunLoopWakeUp(runLoop)
    }

    private func installOnTapThread() {
        guard tap == nil else { return }
        if tryInstall() {
            retry?.invalidate()
            retry = nil
            return
        }
        guard retry == nil else { return }
        retry = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self, self.tryInstall() else { return }
            self.retry?.invalidate()
            self.retry = nil
        }
    }

    private func tryInstall() -> Bool {
        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: hotkeyTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            if !reportedFailure {
                reportedFailure = true
                output.log(
                    .error,
                    AXIsProcessTrusted()
                        ? "hotkey tap unavailable: CGEvent.tapCreate returned nil"
                        : "hotkey tap unavailable: accessibility not granted"
                )
            }
            return false
        }
        let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        CFRunLoopAddSource(runLoop, source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        tap = port
        interpreter = HotkeyInterpreter(key: key, initialFlags: currentFlags())
        syncBackstop()
        output.log(.info, "hotkey tap installed")
        return true
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            // Anything that happened while the tap was off is gone; the release may be among it.
            reconcile()
            return false
        }
        let kind: KeyEvent.Kind
        switch type {
        case .flagsChanged: kind = .flagsChanged
        case .keyDown: kind = .keyDown
        case .keyUp: kind = .keyUp
        default: return false
        }
        let keyEvent = KeyEvent(
            kind: kind,
            keycode: event.getIntegerValueField(.keyboardEventKeycode),
            flags: event.flags.rawValue
        )
        let decision = interpreter.handle(keyEvent, captureActive: captureActive())
        if let action = decision.action {
            output.emit(.hotkey(action: action))
        }
        syncBackstop()
        return decision.consume
    }

    private func reconcile() {
        if let action = interpreter.reconcile(flags: currentFlags()) {
            output.emit(.hotkey(action: action))
        }
        syncBackstop()
    }

    /// While the key may be down, a cheap poll of the live modifier state catches a release the
    /// tap never delivered, so a stuck hold cannot keep the microphone open.
    private func syncBackstop() {
        if interpreter.awaitingRelease {
            guard backstop == nil else { return }
            backstop = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                self?.reconcile()
            }
        } else {
            backstop?.invalidate()
            backstop = nil
        }
    }
}

private func currentFlags() -> UInt64 {
    CGEventSource.flagsState(.combinedSessionState).rawValue
}

private func hotkeyTapCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let tap = Unmanaged<HotkeyTap>.fromOpaque(refcon).takeUnretainedValue()
    return tap.handle(type: type, event: event) ? nil : Unmanaged.passUnretained(event)
}
