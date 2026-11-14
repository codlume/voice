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

    /// What separates `now` from this target, or nil when it is still the same one. Chromium
    /// starts answering with an element once an assistive client switches its web accessibility
    /// on, which can happen mid-session. A window-only target never named an element, so there
    /// the page URL it saw still decides. A target that saw no URL refuses the element. A lookup
    /// that gave up reads the same as an app with no URL (Electron), and nothing else ties the
    /// element to the page the session began on. `pageURL` is asked only when a URL decides,
    /// because the search costs the insert up to 100 ms on main.
    func change(to now: Self, comparingTitle: Bool, pageURL: (Element) -> String?) -> FocusChange? {
        guard window == now.window else { return .window }
        if comparingTitle, title != now.title { return .title }
        switch (anchor, now.anchor) {
        case (.element(let then), .element(let current)): return then == current ? nil : .element
        case (.windowOnly(let then), .windowOnly(let current)): return then == current ? nil : .pageURL
        case (.windowOnly(let then), .element):
            guard let then else { return .anchorKind }
            return then == pageURL(now.window) ? nil : .pageURL
        case (.element, .windowOnly): return .anchorKind
        }
    }

    /// Whether a later snapshot still describes this target, whatever its title now says.
    public func isSameTarget(as later: Self, pageURL: (Element) -> String?) -> Bool {
        change(to: later, comparingTitle: false, pageURL: pageURL) == nil
    }
}

extension FocusAnchor: Sendable where Element: Sendable {}
extension TargetFocus: Sendable where Element: Sendable {}

public enum FocusReread<Element: Equatable>: Equatable {
    case focused(TargetFocus<Element>)
    case nothingFocused
    case noAnswer

    public var focus: TargetFocus<Element>? {
        if case .focused(let focus) = self { return focus }
        return nil
    }
}

/// Why a session has no focus baseline.
public enum FocusLoss: String, Equatable, Sendable {
    case noApp, untrusted, inputMoved, notFrontmost, noAnswer, nothingFocused, readsDisagree, focusMoved, cancelled

    /// A busy app, or two reads on either side of Chromium switching its accessibility tree on,
    /// can pass without the user doing anything, so the snapshot is worth taking again. The
    /// others describe the user or the app, and another read would say the same. `focusMoved`
    /// ends a retry whose snapshot no longer shows the first read's target, and `cancelled` one
    /// whose session was abandoned first.
    public var isTransient: Bool { self == .noAnswer || self == .readsDisagree }
}

/// What differs between the baseline and the focus at insert time.
public enum FocusChange: String, Equatable, Sendable {
    case element, window, title, pageURL, anchorKind, nothingFocused
}

public enum FocusValidation: Equatable {
    case unchanged, unverifiable
    case changed(FocusChange)
}

public enum CapturedFocus<Element: Equatable>: Equatable {
    case pending
    case unavailable(FocusLoss)
    case captured(TargetFocus<Element>)

    /// `movedSinceFirstRead` says the agreeing reads describe another target than the session's
    /// first read. Focus can move with no press (a swipe back, a page focusing another field), and
    /// a retry must not adopt that target as the user's.
    public mutating func resolve(
        first: FocusReread<Element>, second: FocusReread<Element>, inputUnchanged: Bool, frontmost: Bool,
        movedSinceFirstRead: Bool = false
    ) {
        guard inputUnchanged else { return self = .unavailable(.inputMoved) }
        guard frontmost else { return self = .unavailable(.notFrontmost) }
        switch (first, second) {
        case (.noAnswer, _), (_, .noAnswer): self = .unavailable(.noAnswer)
        case (.focused(let focus), .focused(let again)) where focus == again:
            self = movedSinceFirstRead ? .unavailable(.focusMoved) : .captured(focus)
        case (.nothingFocused, .nothingFocused): self = .unavailable(.nothingFocused)
        default: self = .unavailable(.readsDisagree)
        }
    }

    public func validate(
        _ current: FocusReread<Element>, comparingTitle: Bool, pageURL: (Element) -> String?
    ) -> FocusValidation {
        guard case .captured(let focus) = self else { return .unverifiable }
        switch current {
        case .focused(let now):
            return focus.change(to: now, comparingTitle: comparingTitle, pageURL: pageURL).map(FocusValidation.changed) ?? .unchanged
        case .nothingFocused: return .changed(.nothingFocused)
        case .noAnswer: return .unverifiable
        }
    }
}

/// Why a paste keystroke posted now could miss the target the insert checked.
public enum KeystrokeRefusal: String, Equatable, Sendable {
    case inputMoved, notFrontmost, secureInput

    public var failure: InsertFailure { self == .secureInput ? .secureInput : .focusChanged }
}

/// Where a Cmd+V posted now would go. The system delivers it to whichever app is frontmost at
/// that moment, not to the target the insert checked.
public struct KeystrokeDestination: Equatable, Sendable {
    public let presses: PressStamp
    public let frontmostPid: Int32?
    public let secureInput: Bool

    public init(presses: PressStamp, frontmostPid: Int32?, secureInput: Bool) {
        self.presses = presses
        self.frontmostPid = frontmostPid
        self.secureInput = secureInput
    }

    /// `checked` is the press stamp from before the insert's target check. A press since then
    /// can have switched apps, and nothing read from the target shows that: an app answers for
    /// its own focused element whether or not it is in front.
    public func refusal(target pid: Int32?, checked: PressStamp) -> KeystrokeRefusal? {
        if secureInput { return .secureInput }
        if presses != checked { return .inputMoved }
        guard let pid, frontmostPid == pid else { return .notFrontmost }
        return nil
    }
}

public enum PasteAttempt<Write> {
    case posted(Write)
    case refused(KeystrokeRefusal)
}

extension PasteAttempt: Equatable where Write: Equatable {}

/// The order of a paste. Saving the user's clipboard can block for as long as its owner takes
/// to provide the data, so `refusal` is asked after the save, and a target that moved gets no
/// keystroke and no clipboard write.
public func pasteKeystroke<Saved, Write>(
    save: () -> Saved, refusal: () -> KeystrokeRefusal?, write: (Saved) -> Write, post: () -> Void
) -> PasteAttempt<Write> {
    let saved = save()
    if let refusal = refusal() { return .refused(refusal) }
    let write = write(saved)
    post()
    return .posted(write)
}
