/// AX elements can be reused by chat composers, so the window and its title are compared too.
/// Live titles tick on their own (an unread count), so a target without a selection origin
/// compares the title only after a press, which every switch the user makes takes. A target
/// with a selection origin has its own guard against a composer switch (the selected text and
/// range, or the press stamp, move), so it never compares the title.
public enum SwitchGuard: Equatable, Sendable {
    case selectionOrigin
    case pressStamp(moved: Bool)

    var comparesTitle: Bool {
        if case .pressStamp(moved: true) = self { return true }
        return false
    }
}

public struct TargetFocus<Element: Equatable>: Equatable {
    public let element: Element?
    public let window: Element
    public let title: String?

    public init(element: Element?, window: Element, title: String?) {
        self.element = element
        self.window = window
        self.title = title
    }

    public func matches(_ other: Self, guardedBy switchGuard: SwitchGuard) -> Bool {
        element == other.element && window == other.window && (!switchGuard.comparesTitle || title == other.title)
    }
}

extension TargetFocus: Sendable where Element: Sendable {}

public enum FocusReread<Element: Equatable>: Equatable {
    case focused(TargetFocus<Element>)
    case nothingFocused
    case noAnswer
}

public enum FocusValidation: Equatable {
    case unchanged, changed, unverifiable
}

public enum CapturedFocus<Element: Equatable>: Equatable {
    case pending, unavailable
    case captured(TargetFocus<Element>)

    public mutating func resolve(first: FocusReread<Element>, second: FocusReread<Element>, inputUnchanged: Bool) {
        guard inputUnchanged, case .focused(let focus) = first, first == second else {
            self = .unavailable
            return
        }
        self = .captured(focus)
    }

    public func validate(_ current: FocusReread<Element>, guardedBy switchGuard: SwitchGuard) -> FocusValidation {
        guard case .captured(let focus) = self else { return .unverifiable }
        switch current {
        case .focused(let now): return focus.matches(now, guardedBy: switchGuard) ? .unchanged : .changed
        case .nothingFocused: return .changed
        case .noAnswer: return .unverifiable
        }
    }
}
