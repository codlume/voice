import ApplicationServices
import Foundation
import VoiceHelperCore

final class HotkeyTap {
    private let output: Output
    private let captureActive: () -> Bool
    private var key: HotkeyKey = .fn
    private var interpreter: HotkeyInterpreter
    private var tap: CFMachPort?
    private var retry: DispatchSourceTimer?
    private var reportedFailure = false

    init(output: Output, captureActive: @escaping () -> Bool) {
        self.output = output
        self.captureActive = captureActive
        interpreter = HotkeyInterpreter(key: .fn, initialFlags: currentFlags())
    }

    func configure(_ key: HotkeyKey) {
        self.key = key
        interpreter = HotkeyInterpreter(key: key, initialFlags: currentFlags())
    }

    func install() {
        guard tap == nil else { return }
        if tryInstall() {
            retry?.cancel()
            retry = nil
            return
        }
        guard retry == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self, self.tryInstall() else { return }
            self.retry?.cancel()
            self.retry = nil
        }
        retry = timer
        timer.resume()
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
                let reason = AXIsProcessTrusted() ? "CGEvent.tapCreate returned nil" : "accessibility not granted"
                output.log(.error, "hotkey tap unavailable: \(reason)")
            }
            return false
        }
        let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        tap = port
        interpreter = HotkeyInterpreter(key: key, initialFlags: currentFlags())
        output.log(.info, "hotkey tap installed")
        return true
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
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
        let decision = interpreter.handle(keyEvent, captureActive: captureActive())
        if let action = decision.action {
            output.emit(.hotkey(action: action))
        }
        return decision.consume
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
