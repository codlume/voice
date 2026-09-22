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

// Test-only synthetic mouse button transition at a screen point. `owned` stands in for whether
// the bar's window is topmost there, since a test process has no bar window.
struct SimulatedPointer: Sendable {
    let button: Int64
    let down: Bool
    let x: Double
    let y: Double
    let owned: Bool
    init?(_ object: [String: Any]) {
        guard Set(object.keys) == Set(["type", "button", "down", "x", "y", "owned"]),
              let button = object["button"] as? Int, (0...2).contains(button),
              let down = object["down"] as? Bool, let x = object["x"] as? Double, let y = object["y"] as? Double,
              let owned = object["owned"] as? Bool
        else { return nil }
        self.button = Int64(button)
        self.down = down
        self.x = x
        self.y = y
        self.owned = owned
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
    // Electron cannot make a window that takes clicks without activating Voice, which would move
    // focus away from the target. So clicks on the floating bar never reach the window server:
    // the tap consumes them and forwards left-button transitions in screen points to main, which
    // replays them into the bar's web contents. Only the location is used.
    private var bar: BarRegion?
    private var barButtons = Set<Int64>()
    private var barIsTopWindow: (CGPoint, UInt32) -> Bool = ShortcutService.topWindow
    private let emitQueue = DispatchQueue(label: "voice.shortcut.emit")
    var onInput: (() -> Void)?
    // Synthetic tests drive every key transition, so the physical keyboard's state is ignored.
    private let adoptsHeldKeys: Bool
    init(emit: @escaping @Sendable (Data) -> Void, adoptsHeldKeys: Bool = true) {
        self.emit = emit
        self.adoptsHeldKeys = adoptsHeldKeys
    }

    // Applies the full desired state and reports whether the native tap is listening.
    func configure(_ bindings: SetupShortcuts, active: Bool, bar: BarRegion?) -> Bool {
        self.active = active
        self.bar = bar
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

    // Test-only path: feeds a synthetic mouse transition through the same bar handling as the tap.
    func simulate(_ input: SimulatedPointer) -> Bool? {
        let types: [(CGEventType, CGEventType, CGMouseButton)] = [
            (.leftMouseDown, .leftMouseUp, .left), (.rightMouseDown, .rightMouseUp, .right), (.otherMouseDown, .otherMouseUp, .center),
        ]
        let (down, up, button) = types[Int(input.button)]
        guard let event = CGEvent(mouseEventSource: nil, mouseType: input.down ? down : up,
                                  mouseCursorPosition: CGPoint(x: input.x, y: input.y), mouseButton: button) else { return nil }
        let real = barIsTopWindow
        barIsTopWindow = { _, _ in input.owned }
        defer { barIsTopWindow = real }
        return handle(input.down ? down : up, event)
    }

    private func install() {
        let types: [CGEventType] = [
            .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
            .leftMouseUp, .rightMouseUp, .otherMouseUp,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
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
        // A replacement helper can start while Fn is still held from before. Adopt that as the
        // current state, so only a fresh press after its release becomes a hold.
        if adoptsHeldKeys, CGEventSource.flagsState(.combinedSessionState).contains(.maskSecondaryFn) { fnHeld = true }
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
    private func sendPointer(_ phase: String, _ event: CGEvent) {
        let point = event.location
        let message: [String: Any] = ["type": "bar.pointer", "phase": phase, "x": point.x, "y": point.y]
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        emitQueue.async { [emit] in emit(data) }
    }
    // Returns whether a mouse transition belongs to the floating bar, and forwards left clicks.
    // A press that started on the bar keeps its release, wherever the pointer ends up.
    private func pointer(_ type: CGEventType, _ event: CGEvent) -> Bool {
        let button = event.getIntegerValueField(.mouseEventButtonNumber)
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            guard let bar, bar.contains(x: event.location.x, y: event.location.y),
                  barIsTopWindow(event.location, bar.window) else { return false }
            barButtons.insert(button)
            if type == .leftMouseDown { sendPointer("down", event) }
            return true
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            guard barButtons.remove(button) != nil else { return false }
            if type == .leftMouseUp { sendPointer("up", event) }
            return true
        default:
            return false
        }
    }
    // A menu, alert, or other window drawn over the bar keeps its own clicks. Only window bounds
    // and numbers are read, which needs no screen-recording access.
    private nonisolated static func topWindow(_ point: CGPoint, _ number: UInt32) -> Bool {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return false }
        for window in windows {
            guard let bounds = window[kCGWindowBounds as String] as? [String: Double],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.contains(point),
                  (window[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
            return (window[kCGWindowNumber as String] as? UInt32) == number
        }
        return false
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
        // A click on the bar is not a destination choice for an armed paste.
        if pointer(type, event) { return true }
        if type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp { return false }
        let flags = event.flags
        // Fn is tracked before bindings exist, so a key already held when this helper was
        // configured is never mistaken for a fresh press later.
        let fnChanged = type == .flagsChanged && flags.contains(.maskSecondaryFn) != fnHeld
        if fnChanged { fnHeld.toggle() }
        guard let bindings else { return false }
        onInput?()
        switch type {
        case .flagsChanged:
            if fnChanged, bindings.hold == .fn { if fnHeld { holdDown() } else { holdUp() } }
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
