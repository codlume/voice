public struct KeyEvent: Equatable, Sendable {
    public enum Kind: Sendable { case flagsChanged, keyDown, keyUp }

    public var kind: Kind
    public var keycode: Int64
    /// Raw `CGEventFlags` bits, including the device-side left/right modifier bits.
    public var flags: UInt64
    public var isRepeat: Bool

    public init(kind: Kind, keycode: Int64, flags: UInt64, isRepeat: Bool = false) {
        self.kind = kind
        self.keycode = keycode
        self.flags = flags
        self.isRepeat = isRepeat
    }
}

public struct HotkeyDecision: Equatable, Sendable {
    public var action: HotkeyAction?
    public var consume: Bool

    public init(action: HotkeyAction?, consume: Bool) {
        self.action = action
        self.consume = consume
    }

    public static let none = HotkeyDecision(action: nil, consume: false)
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
}

public struct HotkeyInterpreter: Sendable {
    private enum Hold { case released, held, staleHeld, heldCancelled }

    public let key: HotkeyKey
    private var hold: Hold

    public init(key: HotkeyKey, initialFlags: UInt64) {
        self.key = key
        hold = initialFlags & key.flagMask != 0 ? .staleHeld : .released
    }

    public mutating func handle(_ event: KeyEvent, captureActive: Bool) -> HotkeyDecision {
        switch event.kind {
        case .flagsChanged:
            guard event.keycode == key.keycode else { return .none }
            let isDown = event.flags & key.flagMask != 0
            switch (hold, isDown) {
            case (.released, true):
                hold = .held
                return HotkeyDecision(action: .down, consume: false)
            case (.held, false):
                hold = .released
                return HotkeyDecision(action: .up, consume: false)
            case (.staleHeld, false), (.heldCancelled, false):
                hold = .released
                return .none
            case (.held, true), (.staleHeld, true), (.heldCancelled, true), (.released, false):
                return .none
            }
        case .keyDown:
            if event.keycode == escapeKeycode {
                guard captureActive else { return .none }
                if hold == .held { hold = .heldCancelled }
                return HotkeyDecision(action: .cancel, consume: true)
            }
            guard hold == .held, event.keycode != key.keycode, !modifierKeycodes.contains(event.keycode) else {
                return .none
            }
            hold = .heldCancelled
            return HotkeyDecision(action: .cancel, consume: false)
        case .keyUp:
            return .none
        }
    }
}

private let escapeKeycode: Int64 = 53
private let modifierKeycodes: Set<Int64> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]
