import ApplicationServices
import Foundation

public struct AXTextRange: Equatable, Sendable {
    public var location: Int
    public var length: Int

    public init(location: Int, length: Int) {
        self.location = location
        self.length = length
    }
}

/// What the focused element reports around an `AXSelectedText` write. Either field is nil when
/// the app does not expose it. The text length in UTF-16 units stands in for the text itself:
/// the verdict only needs to know whether anything moved, and copying a long document on every
/// insert is slow.
public struct AXTextState: Equatable, Sendable {
    public var length: Int?
    public var selection: AXTextRange?

    public init(length: Int?, selection: AXTextRange?) {
        self.length = length
        self.selection = selection
    }

    public var isObservable: Bool { length != nil && selection != nil }
}

/// Whether a write the app reported as a success actually took. The write is doubted only when
/// the element was fully observable on both sides and nothing at all moved. Dictating the text
/// that was already selected leaves the value alone but collapses the selection, so it counts
/// as inserted; pasting it again would double the text.
public enum AXWriteVerdict: Equatable, Sendable {
    case inserted
    case unchanged

    public init(before: AXTextState, after: AXTextState) {
        self = before.isObservable && after.isObservable && before == after ? .unchanged : .inserted
    }
}

/// How the app answered the `AXSelectedText` write call itself.
public enum AXWriteAnswer: Equatable, Sendable {
    case succeeded
    case refused
    /// The call ran out its messaging timeout. The request was still sent, so a busy app can
    /// apply it later. Apple's `AXUIElement.h` says as much of an action that times out: it
    /// "does not necessarily mean that the function has failed".
    case timedOut

    /// `kAXErrorCannotComplete` also reports a message that could not be sent. That failure
    /// comes back at once and leaves no request behind, so only one that used up the timeout
    /// counts as unanswered. Half the timeout separates the two without leaning on how the
    /// system rounds its wait.
    public init(_ error: AXError, waited: TimeInterval, timeout: TimeInterval) {
        switch error {
        case .success: self = .succeeded
        case .cannotComplete where waited >= timeout / 2: self = .timedOut
        default: self = .refused
        }
    }
}

/// What an insert does once the write call has returned.
public enum AXWritePlan: Equatable, Sendable {
    case inserted(AccessibilityRoute)
    case paste(PasteRoute)
    /// The app accepted the write and nothing moved. One later re-read separates a slow app
    /// from a silent no-op.
    case reread
    /// The app never answered and nothing shows the write landed. It can still land, so a paste
    /// now could insert the text twice.
    case unknown

    /// `after` is read only when it can change the plan, because each read of a busy app can
    /// cost the insert a messaging timeout on main.
    public init(answer: AXWriteAnswer, before: AXTextState, after: () -> AXTextState) {
        switch answer {
        case .refused:
            self = .paste(.writeFailed)
        case .succeeded:
            self = AXWriteVerdict(before: before, after: after()) == .inserted ? .inserted(.direct) : .reread
        case .timedOut:
            // An accepted write counts unless a no-op is proven. An unanswered one counts only
            // when the text is seen to move.
            guard before.isObservable else {
                self = .unknown
                return
            }
            let after = after()
            self = after.isObservable && after != before ? .inserted(.late) : .unknown
        }
    }
}
