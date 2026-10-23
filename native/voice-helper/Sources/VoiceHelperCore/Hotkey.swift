public struct KeyEvent: Equatable, Sendable {
    public enum Kind: Sendable { case flagsChanged, keyDown, keyUp }

    public var kind: Kind
    public var keycode: Int64
    /// Raw `CGEventFlags` bits, including the device-side left/right modifier bits.
    public var flags: UInt64
    /// `kCGKeyboardEventAutorepeat`: the key is still held and the system is repeating it.
    public var isRepeat: Bool

    public init(kind: Kind, keycode: Int64, flags: UInt64, isRepeat: Bool = false) {
        self.kind = kind
        self.keycode = keycode
        self.flags = flags
        self.isRepeat = isRepeat
    }
}

/// What the helper is busy with, read on the tap thread for every event. While `capturing`,
/// transform shortcuts pass through to the app; while `transforming`, Escape cancels the run and
/// shortcuts are still consumed (main drops them) so a held Option+1 cannot type into the app.
public enum HelperActivity: Sendable { case idle, capturing, transforming }

public struct HotkeyDecision: Equatable, Sendable {
    public var action: HotkeyAction?
    /// The transform shortcut that fired. Never set together with `action`.
    public var transform: String?
    public var consume: Bool

    public init(action: HotkeyAction?, transform: String? = nil, consume: Bool) {
        self.action = action
        self.transform = transform
        self.consume = consume
    }

    public static let none = HotkeyDecision(action: nil, consume: false)
}

/// The generic modifier bits of `flags` as the families a shortcut names. Caps Lock, fn and the
/// numeric-pad bits are ignored: arrow and function keys set the fn bit on their own.
public func modifierFamilies(flags: UInt64) -> Set<Modifier> {
    var families = Set<Modifier>()
    if flags & 0x2_0000 != 0 { families.insert(.shift) }
    if flags & 0x4_0000 != 0 { families.insert(.control) }
    if flags & 0x8_0000 != 0 { families.insert(.option) }
    if flags & 0x10_0000 != 0 { families.insert(.command) }
    return families
}

extension HotkeyKey {
    public var keycode: Int64 {
        switch self {
        case .fn: return 63
        case .rightOption: return 61
        case .rightCommand: return 54
        }
    }

    /// The flag bit that is set while the key is physically down. Left and right
    /// option/command share the generic mask, so the device-side bits are used.
    public var flagMask: UInt64 {
        switch self {
        case .fn: return 0x80_0000
        case .rightOption: return 0x40
        case .rightCommand: return 0x10
        }
    }

    /// Bits that must all be clear in the live modifier state before the key is known to be
    /// up. The generic option/command bit is included so a poll never declares a release on
    /// evidence weaker than the flagsChanged event would carry.
    public var releasedMask: UInt64 {
        switch self {
        case .fn: return flagMask
        case .rightOption: return flagMask | 0x8_0000
        case .rightCommand: return flagMask | 0x10_0000
        }
    }
}

/// Watches the hold key and the optional toggle key. The hold key reports `down`, `up`, and
/// `chord`; the toggle key reports only `toggle`, on a clean tap, so a shortcut that uses it
/// (Right Option + a for "ą") never reaches the session. Escape is `cancel`.
///
/// Transform shortcuts match a keyDown by keycode and the exact generic modifier set, and only
/// while neither dictation key is down: Right Option+1 with dictation on Right Option stays a
/// chord, Left Option+1 fires. A matched key is swallowed until its keyUp, so the app sees
/// neither the press, its repeats, nor the release.
public struct Hotkeys: Sendable {
    private var hold: KeyHold
    private var toggle: KeyHold?
    private var shortcuts: [TransformShortcut]
    private var swallowed: Set<Int64> = []

    public init(key: HotkeyKey, toggleKey: HotkeyKey?, transforms: [TransformShortcut] = [], initialFlags: UInt64) {
        hold = KeyHold(key: key, initialFlags: initialFlags)
        toggle = toggleKey.map { KeyHold(key: $0, initialFlags: initialFlags) }
        shortcuts = transforms
    }

    /// Replaces the registered shortcuts. The holds are untouched, so a transforms change in
    /// the middle of a held dictation never ends it, and a swallowed key stays swallowed until
    /// its release even when its shortcut was just removed.
    public mutating func setTransforms(_ transforms: [TransformShortcut]) {
        shortcuts = transforms
    }

    /// True while a key may still be down, so the live state deserves a periodic check.
    public var awaitingRelease: Bool { hold.awaitingRelease || toggle?.awaitingRelease == true }

    /// Re-derives each hold from the live modifier state after events may have been missed: a
    /// tap disabled by timeout, or a release that never reached the tap. Emits `up` for a hold
    /// key that was down. Never emits `down` or `toggle`: a press or release seen only through
    /// polling is not a deliberate one. Swallowed keys are forgotten too: their releases were
    /// among the missed events.
    public mutating func reconcile(flags: UInt64) -> HotkeyAction? {
        swallowed.removeAll()
        _ = toggle?.reconcile(flags: flags)
        return hold.reconcile(flags: flags)
    }

    /// At most one action per event: settings keep the two keys distinct, so a flagsChanged
    /// event belongs to one of them, and a keyDown chord speaks only for the hold key.
    public mutating func handle(_ event: KeyEvent, activity: HelperActivity) -> HotkeyDecision {
        if event.kind == .keyDown, event.keycode == escapeKeycode {
            guard activity != .idle else { return .none }
            hold.cancel()
            toggle?.cancel()
            return HotkeyDecision(action: .cancel, consume: true)
        }
        if event.kind == .keyUp, swallowed.remove(event.keycode) != nil {
            return HotkeyDecision(action: nil, consume: true)
        }
        if event.kind == .keyDown, let shortcut = matchingShortcut(event, activity: activity) {
            if event.isRepeat { return HotkeyDecision(action: nil, consume: true) }
            swallowed.insert(event.keycode)
            return HotkeyDecision(action: nil, transform: shortcut.id, consume: true)
        }
        if event.kind == .keyDown, event.isRepeat, swallowed.contains(event.keycode) {
            return HotkeyDecision(action: nil, consume: true)
        }
        let tapped = toggle?.handle(event) == .up
        let action = hold.handle(event) ?? (tapped ? .toggle : nil)
        return HotkeyDecision(action: action, consume: false)
    }

    private func matchingShortcut(_ event: KeyEvent, activity: HelperActivity) -> TransformShortcut? {
        guard activity != .capturing, !awaitingRelease else { return nil }
        let families = modifierFamilies(flags: event.flags)
        return shortcuts.first { $0.keycode == event.keycode && Set($0.modifiers) == families }
    }
}

private struct KeyHold: Sendable {
    private enum State { case released, held, staleHeld, heldCancelled }

    let key: HotkeyKey
    private var state: State

    init(key: HotkeyKey, initialFlags: UInt64) {
        self.key = key
        state = initialFlags & key.flagMask != 0 ? .staleHeld : .released
    }

    var awaitingRelease: Bool { state != .released }

    mutating func reconcile(flags: UInt64) -> HotkeyAction? {
        guard flags & key.releasedMask == 0, state != .released else { return nil }
        let wasHeld = state == .held
        state = .released
        return wasHeld ? .up : nil
    }

    /// The session ended while the key is down, so its release must stay silent.
    mutating func cancel() {
        if state == .held { state = .heldCancelled }
    }

    mutating func handle(_ event: KeyEvent) -> HotkeyAction? {
        switch event.kind {
        case .flagsChanged:
            guard event.keycode == key.keycode else { return nil }
            let isDown = event.flags & key.flagMask != 0
            switch (state, isDown) {
            case (.released, true):
                state = .held
                return .down
            case (.held, false):
                state = .released
                return .up
            case (.staleHeld, false), (.heldCancelled, false):
                state = .released
                return nil
            case (.held, true), (.staleHeld, true), (.heldCancelled, true), (.released, false):
                return nil
            }
        case .keyDown:
            guard state == .held, event.keycode != key.keycode, !modifierKeycodes.contains(event.keycode) else {
                return nil
            }
            state = .heldCancelled
            return .chord
        case .keyUp:
            return nil
        }
    }
}

private let escapeKeycode: Int64 = 53
private let modifierKeycodes: Set<Int64> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]
