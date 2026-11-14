/// Who the system-wide accessibility element names as holding key focus: the app whose window
/// takes typed keys. It is not always the frontmost app. Spotlight, Raycast, Alfred, and
/// Voice's own meeting notepad show a panel that takes the keys while the app behind it stays
/// frontmost.
public enum KeyFocusHolder: Equatable, Sendable {
    case app(Int32)
    /// An app holds key focus and does not answer for itself. Chromium and Electron apps do
    /// this until an assistive client switches their accessibility on. Once they answer for a
    /// focused element they are named here too.
    case unnamed
    case noAnswer
}

public enum KeyFocusRefusal: String, Equatable, Sendable {
    case moved
    /// The selection was read by accessibility from the target app, and that app is not named
    /// as holding key focus. A keystroke would paste the transform over another window's text.
    case selectionNotKeyFocus
}

/// How an insert can reach the text the user is typing in.
public enum KeyFocusRoute: Equatable, Sendable {
    /// The target app holds key focus, so a write into its focused element lands where the
    /// user types.
    case write
    /// Another app's panel has held key focus over the target since the session began. Only a
    /// keystroke reaches it. A write into the target's element would land behind it.
    case panel(Int32)
    /// Nothing names the app that holds key focus, and nothing shows it changed. A keystroke
    /// goes to that app whichever it is. A write could land behind a panel that does not answer.
    case keystroke
    case refused(KeyFocusRefusal)
}

public struct KeyFocus: Equatable, Sendable {
    private enum Holder: Equatable {
        case target, other(Int32), unnamed, noAnswer
    }

    private let target: Int32

    public init(target: Int32) {
        self.target = target
    }

    private func holder(_ holder: KeyFocusHolder) -> Holder {
        switch holder {
        case .app(let pid): return pid == target ? .target : .other(pid)
        case .unnamed: return .unnamed
        case .noAnswer: return .noAnswer
        }
    }

    /// For a log line. It carries no process id and no app name.
    public func describe(_ holder: KeyFocusHolder) -> String {
        switch self.holder(holder) {
        case .target: return "target"
        case .other: return "other"
        case .unnamed: return "unnamed"
        case .noAnswer: return "noAnswer"
        }
    }

    /// A write needs the target named as the holder now. Anything else gets at most a
    /// keystroke, and only while nothing shows that key focus changed hands. A panel that
    /// closed during the session leaves the target holding key focus, so the write goes ahead.
    public func route(atStart: KeyFocusHolder, now: KeyFocusHolder, selection: SelectionOrigin? = nil) -> KeyFocusRoute {
        let keystroke: KeyFocusRoute
        switch (holder(atStart), holder(now)) {
        case (_, .target):
            return .write
        case (.other(let then), .other(let panel)) where then == panel:
            keystroke = .panel(panel)
        case (_, .other), (.target, .unnamed), (.other, .unnamed):
            return .refused(.moved)
        case (.unnamed, .unnamed), (.noAnswer, .unnamed), (_, .noAnswer):
            keystroke = .keystroke
        }
        if case .accessibility = selection { return .refused(.selectionNotKeyFocus) }
        return keystroke
    }
}
