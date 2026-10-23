import ApplicationServices
import Foundation
import VoiceHelperCore
import os

/// Owns the CGEventTap on a thread of its own. The system disables a tap whose callback
/// stalls, and a disabled tap loses the key release that ends recording, so nothing that can
/// block (AX calls, engine start, pasteboard IO) may share this thread. Every stored property
/// below the run loop is touched only on that thread; `configure` and `install` hop onto it.
final class HotkeyTap {
    private let output: Output
    private let activity: () -> HelperActivity
    private let runLoop: CFRunLoop
    private let thread: Thread
    private var key: HotkeyKey = .fn
    private var toggleKey: HotkeyKey?
    private var transforms: [TransformShortcut] = []
    private var hotkeys: Hotkeys
    /// The key of the last shortcut that fired, for the selection reader to wait on its release.
    private let firedKey = OSAllocatedUnfairLock<Int64?>(initialState: nil)
    private var tap: CFMachPort?
    private var retry: Timer?
    private var backstop: Timer?
    private var reportedFailure = false

    init(output: Output, activity: @escaping () -> HelperActivity) {
        self.output = output
        self.activity = activity
        hotkeys = Hotkeys(key: .fn, toggleKey: nil, initialFlags: currentFlags())
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

    /// Whether the key that fired the last transform shortcut is still physically down.
    var firedKeyIsDown: Bool {
        guard let keycode = firedKey.withLock({ $0 }) else { return false }
        return CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(keycode))
    }

    /// The holds are rebuilt only when a dictation key changed, which ends a held dictation.
    /// A transforms-only change swaps the shortcuts under the live holds.
    func configure(key: HotkeyKey, toggleKey: HotkeyKey?, transforms: [TransformShortcut]) {
        perform {
            self.transforms = transforms
            if key == self.key, toggleKey == self.toggleKey {
                self.hotkeys.setTransforms(transforms)
                return
            }
            self.emit(self.hotkeys.reconcile(flags: 0))
            self.key = key
            self.toggleKey = toggleKey
            self.hotkeys = Hotkeys(key: key, toggleKey: toggleKey, transforms: transforms, initialFlags: currentFlags())
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
        hotkeys = Hotkeys(key: key, toggleKey: toggleKey, transforms: transforms, initialFlags: currentFlags())
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
            flags: event.flags.rawValue,
            isRepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        )
        let decision = hotkeys.handle(keyEvent, activity: activity())
        emit(decision.action)
        if let transformId = decision.transform {
            firedKey.withLock { $0 = keyEvent.keycode }
            output.emit(.transform(transformId: transformId))
        }
        syncBackstop()
        return decision.consume
    }

    private func reconcile() {
        emit(hotkeys.reconcile(flags: currentFlags()))
        syncBackstop()
    }

    private func emit(_ action: HotkeyAction?) {
        if let action { output.emit(.hotkey(action: action)) }
    }

    /// While a key may be down, a cheap poll of the live modifier state catches a release the
    /// tap never delivered, so a stuck hold cannot keep the microphone open.
    private func syncBackstop() {
        if hotkeys.awaitingRelease {
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
