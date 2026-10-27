/// What a session's insert must still find: the focused element, or when the app exposes none,
/// as Chromium does, the page URL below the window. A swipe back changes that URL with no press,
/// and an unread count leaves it alone. A page that rewrites its own URL also refuses.
public enum FocusAnchor<Element: Equatable>: Equatable {
    case element(Element)
    case windowOnly(pageURL: String?)

    public var element: Element? {
        if case .element(let element) = self { return element }
        return nil
    }
}

/// AX elements can be reused by chat composers, so the window and its title are compared too.
/// Live titles tick on their own (an unread count), so the title is compared only when a press
/// could have switched the composer. A target with a selection origin has its own guard against
/// a composer switch (the selected text and range, or the press stamp, move), so it never
/// compares the title.
public struct TargetFocus<Element: Equatable>: Equatable {
    public let anchor: FocusAnchor<Element>
    public let window: Element
    public let title: String?

    public init(anchor: FocusAnchor<Element>, window: Element, title: String?) {
        self.anchor = anchor
        self.window = window
        self.title = title
    }

    public func matches(_ other: Self, comparingTitle: Bool) -> Bool {
        anchor == other.anchor && window == other.window && (!comparingTitle || title == other.title)
    }
}

extension FocusAnchor: Sendable where Element: Sendable {}
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

    public func validate(_ current: FocusReread<Element>, comparingTitle: Bool) -> FocusValidation {
        guard case .captured(let focus) = self else { return .unverifiable }
        switch current {
        case .focused(let now): return focus.matches(now, comparingTitle: comparingTitle) ? .unchanged : .changed
        case .nothingFocused: return .changed
        case .noAnswer: return .unverifiable
        }
    }
}
