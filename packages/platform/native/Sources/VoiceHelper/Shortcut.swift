import Foundation
import CoreGraphics
import VoiceHelperProtocol

// Test-only synthetic key transition, decoded on the reader thread before crossing to the main actor.
struct SimulatedKey: Sendable {
    let key: String
    let down: Bool
    let flags: [String]
    let repeats: Bool
    init?(_ object: [String: Any]) {
        guard Set(object.keys).isSubset(of: ["type", "key", "down", "flags", "repeat"]),
              let key = object["key"] as? String, let down = object["down"] as? Bool else { return nil }
        self.key = key
        self.down = down
        flags = object["flags"] as? [String] ?? []
        repeats = object["repeat"] as? Bool == true
    }
}

// Translates native key transitions into shortcut actions using the configured bindings.
// The tap consumes only keys it interprets, so a toggle chord never types a space into the target
// and the cancel key reaches the target app again as soon as no session or paste is active.
// Session ownership stays in Electron main; this class never starts or stops capture itself.
@MainActor
final class ShortcutService {
    private enum Trigger: Equatable {
        case fn
        case key(code: Int64, modifiers: CGEventFlags, fn: Bool)
    }
    private let emit: @Sendable (Data) -> Void
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var bindings: SetupShortcuts?
    // Binding changes wait until a held hold key is released, so its release is still recognised.
    private var pendingBindings: SetupShortcuts?
    private var active = false
    private var fnHeld = false
    private var holdHeld = false
    private var consumed = Set<Int64>()
    private let emitQueue = DispatchQueue(label: "voice.shortcut.emit")
    var onInput: (() -> Void)?
    init(emit: @escaping @Sendable (Data) -> Void) { self.emit = emit }

    // Applies the full desired state and reports whether the native tap is listening.
    func configure(_ bindings: SetupShortcuts, active: Bool) -> Bool {
        self.active = active
        if holdHeld, bindings != self.bindings { pendingBindings = bindings } else { self.bindings = bindings; pendingBindings = nil }
        if tap == nil { install() }
        return tap != nil
    }
    func uninstall() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }
    // Test-only path: feeds a synthetic key transition through the same translation as the tap.
    func simulate(_ input: SimulatedKey) -> Bool? {
        let (key, down) = (input.key, input.down)
        let codes: [String: CGKeyCode] = ["fn": 63, "space": 49, "escape": 53, "a": 0, "tab": 48]
        guard let code = codes[key] else { return nil }
        var flags = CGEventFlags()
        for name in input.flags {
            switch name {
            case "fn": flags.insert(.maskSecondaryFn)
            case "control": flags.insert(.maskControl)
            case "option": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            case "command": flags.insert(.maskCommand)
            default: return nil
            }
        }
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { return nil }
        if key == "fn" { if down { flags.insert(.maskSecondaryFn) } else { flags.remove(.maskSecondaryFn) } }
        event.flags = flags
        if input.repeats { event.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
        return handle(key == "fn" ? .flagsChanged : down ? .keyDown : .keyUp, event)
    }

    private func install() {
        let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue) | (1 << CGEventType.otherMouseDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let service = Unmanaged<ShortcutService>.fromOpaque(refcon).takeUnretainedValue()
            let consumed = MainActor.assumeIsolated { service.handle(type, event) }
            return consumed ? nil : Unmanaged.passUnretained(event)
        }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                          eventsOfInterest: mask, callback: callback,
                                          userInfo: Unmanaged.passUnretained(self).toOpaque()),
              let source = CFMachPortCreateRunLoopSource(nil, tap, 0) else { return }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
    }
    private func trigger(_ binding: ShortcutBinding) -> Trigger {
        switch binding {
        case .fn: return .fn
        case .fnSpace: return .key(code: 49, modifiers: [], fn: true)
        case .escape: return .key(code: 53, modifiers: [], fn: false)
        case .controlOptionSpace: return .key(code: 49, modifiers: [.maskControl, .maskAlternate], fn: false)
        case .controlShiftSpace: return .key(code: 49, modifiers: [.maskControl, .maskShift], fn: false)
        case .controlOptionEscape: return .key(code: 53, modifiers: [.maskControl, .maskAlternate], fn: false)
        }
    }
    private func matches(_ trigger: Trigger, code: Int64, flags: CGEventFlags) -> Bool {
        guard case .key(let expected, let modifiers, let fn) = trigger, expected == code else { return false }
        let relevant: CGEventFlags = [.maskControl, .maskAlternate, .maskShift, .maskCommand]
        guard flags.intersection(relevant) == modifiers else { return false }
        return !fn || flags.contains(.maskSecondaryFn)
    }
    // Writes leave the tap callback immediately; a slow reader must never stall system input.
    private func send(_ action: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": "shortcut", "action": action]) else { return }
        emitQueue.async { [emit] in emit(data) }
    }
    private func holdDown() {
        guard !holdHeld else { return }
        holdHeld = true
        send("hold.down")
    }
    private func holdUp() {
        guard holdHeld else { return }
        holdHeld = false
        send("hold.up")
        if let pendingBindings { bindings = pendingBindings; self.pendingBindings = nil }
    }
    // Returns true when the event must not reach other applications.
    func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return false
        }
        guard let bindings else { return false }
        onInput?()
        let flags = event.flags
        switch type {
        case .flagsChanged:
            let fnNow = flags.contains(.maskSecondaryFn)
            if fnNow != fnHeld {
                fnHeld = fnNow
                if bindings.hold == .fn { if fnNow { holdDown() } else { holdUp() } }
            }
            if case .key(_, let modifiers, _) = trigger(bindings.hold), holdHeld, !modifiers.isEmpty,
               !flags.contains(modifiers) { holdUp() }
            return false
        case .keyDown, .keyUp:
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            if type == .keyUp {
                let wasConsumed = consumed.remove(code) != nil
                if case .key(let expected, _, _) = trigger(bindings.hold), expected == code { holdUp() }
                return wasConsumed
            }
            if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return consumed.contains(code) }
            if matches(trigger(bindings.cancel), code: code, flags: flags) {
                // Idle Escape belongs to the frontmost app; a hold in progress counts as a session
                // even before main has confirmed it.
                guard active || holdHeld else { return false }
                send("cancel")
                consumed.insert(code)
                return true
            }
            if matches(trigger(bindings.toggle), code: code, flags: flags) {
                send("toggle")
                consumed.insert(code)
                return true
            }
            if matches(trigger(bindings.hold), code: code, flags: flags) {
                holdDown()
                consumed.insert(code)
                return true
            }
            return false
        default:
            return false
        }
    }
}
