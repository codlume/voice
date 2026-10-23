import Foundation

/// What the accessibility tree said about the focused element's selection. An explicit empty
/// range is an answer ("nothing is selected"), and only silence permits a synthetic Cmd+C: VS
/// Code and JetBrains copy the whole line when nothing is selected.
public enum AXSelectionAnswer: Equatable, Sendable {
    case text(String, range: AXTextRange?)
    /// `kAXSelectedTextRange` present with length 0.
    case emptyRange
    /// Subrole AXSecureTextField.
    case secureField
    /// No focused element, or an element that answers neither attribute. Chromium and Electron
    /// answer this way without an accessibility client.
    case noAnswer
}

/// How to check, right before writing, that the selection is still the one that was read.
public enum SelectionOrigin: Equatable, Sendable {
    /// Re-read the element's selected text and range before the write.
    case accessibility(text: String, range: AXTextRange?)
    /// No tree to re-read. `inputStamp` is `focusInputStamp()` taken after the copy settled;
    /// any key or mouse press since may have moved the selection.
    case copy(inputStamp: [UInt32])
}

public enum ReadPlan: Equatable, Sendable {
    case selected(text: String, origin: SelectionOrigin)
    case fail(SelectionFailure)
    case copyFallback
}

public func planRead(secureInput: Bool, answer: AXSelectionAnswer) -> ReadPlan {
    if secureInput { return .fail(.secureInput) }
    switch answer {
    case .secureField: return .fail(.secureInput)
    case .emptyRange: return .fail(.noSelection)
    case .noAnswer: return .copyFallback
    case .text(let text, let range):
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .fail(.noSelection) }
        return .selected(text: text, origin: .accessibility(text: text, range: range))
    }
}

public enum WriteVerdict: Equatable, Sendable { case proceed, refuseSelectionChanged }

/// `currentAX` is the element's answer now, nil when no re-read was made. An element that no
/// longer answers refuses: unverifiable is not unchanged.
public func writeVerdict(origin: SelectionOrigin, currentAX: AXSelectionAnswer?, currentStamp: [UInt32]) -> WriteVerdict {
    switch origin {
    case .accessibility(let text, let range):
        return currentAX == .text(text, range: range) ? .proceed : .refuseSelectionChanged
    case .copy(let stamp):
        return stamp == currentStamp ? .proceed : .refuseSelectionChanged
    }
}

/// Before anything is posted, the shortcut's key and every modifier must be up. A leaked Option
/// turns the synthetic Cmd+C into Option+Cmd+C, and repeats of the held key move the input stamp
/// the target record and the write guard depend on.
public enum ReleaseWait {
    public static let deadline: TimeInterval = 1.0

    public enum Step: Equatable, Sendable { case wait, proceed, giveUp }

    public static func step(flags: UInt64, keyDown: Bool, elapsed: TimeInterval) -> Step {
        if !keyDown, modifierFamilies(flags: flags).isEmpty { return .proceed }
        return elapsed >= deadline ? .giveUp : .wait
    }
}

/// The pasteboard watch after the synthetic Cmd+C. An unchanged pasteboard at the deadline means
/// the app had nothing to copy.
public struct CopyWait: Equatable, Sendable {
    public static let deadline: TimeInterval = 0.5
    public static let lateCheck: TimeInterval = 1.0

    public enum Step: Equatable, Sendable { case wait, changed, timedOut }

    public let startChangeCount: Int

    public init(startChangeCount: Int) {
        self.startChangeCount = startChangeCount
    }

    public func step(changeCount: Int, elapsed: TimeInterval) -> Step {
        if changeCount != startChangeCount { return .changed }
        return elapsed >= Self.deadline ? .timedOut : .wait
    }

    /// After a timeout, one late look. Exactly one write since the copy was posted is the app
    /// answering late, and the user's clipboard goes back; two or more mean the user copied
    /// something meanwhile, and the clipboard is theirs.
    public func lateRestoreNeeded(changeCount: Int) -> Bool {
        changeCount == startChangeCount + 1
    }
}

/// One slot, take-once, keyed by the run id. A new read replaces it, an insert takes it, and
/// `transform.end` drops only its own run's entry.
public struct SelectionShelf<Entry> {
    private var slot: (id: String, entry: Entry)?

    public init() {}

    public mutating func put(id: String, _ entry: Entry) {
        slot = (id, entry)
    }

    public mutating func take(id: String) -> Entry? {
        guard let slot, slot.id == id else { return nil }
        self.slot = nil
        return slot.entry
    }

    public mutating func clear(id: String) {
        if slot?.id == id { slot = nil }
    }
}
