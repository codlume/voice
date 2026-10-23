/// AX elements can be reused by chat composers. Compare the window and its title too,
/// accepting a refusal when a title changes for reasons other than navigation. A target with a
/// selection origin has its own guard against a composer switch (the selected text and range,
/// or the press stamp, move), so it can skip the title and survive unread counts and other
/// live titles ticking while a transform runs.
public struct TargetFocus<Element: Equatable>: Equatable {
    public let element: Element?
    public let window: Element
    public let title: String?

    public init(element: Element?, window: Element, title: String?) {
        self.element = element
        self.window = window
        self.title = title
    }

    public func matches(_ other: Self, comparingTitle: Bool) -> Bool {
        element == other.element && window == other.window && (!comparingTitle || title == other.title)
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

    public func validate(_ current: FocusReread<Element>, comparingTitle: Bool) -> FocusValidation {
        guard case .captured(let focus) = self else { return .unverifiable }
        switch current {
        case .focused(let now): return focus.matches(now, comparingTitle: comparingTitle) ? .unchanged : .changed
        case .nothingFocused: return .changed
        case .noAnswer: return .unverifiable
        }
    }
}
