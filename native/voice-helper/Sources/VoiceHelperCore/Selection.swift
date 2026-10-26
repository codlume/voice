import Foundation

/// What the accessibility tree said about the focused element's selection. An explicit empty
/// range is an answer ("nothing is selected"), and only silence permits a synthetic Cmd+C,
/// because code editors copy the caret's whole line when nothing is selected. Electron is
/// silent, so a Monaco line copy (VS Code, Cursor) is caught afterwards by the metadata Monaco
/// writes next to the text; see `isMonacoEmptySelectionCopy`. Any other editor that both stays
/// silent and copies the line still reads that line as the selection.
public enum AXSelectionAnswer: Equatable, Sendable {
    case text(String, range: AXTextRange?)
    case emptyRange
    case secureField
    /// No focused element, or an element that answers neither attribute. Chromium and Electron
    /// answer this way without an accessibility client.
    case noAnswer
}

/// The system-wide key and mouse press counters at one moment. Any press moves it.
public struct PressStamp: Equatable, Sendable {
    public let counts: [UInt32]
    public init(counts: [UInt32]) { self.counts = counts }
}

public enum SelectionOrigin: Equatable, Sendable {
    case accessibility(text: String, range: AXTextRange?)
    case copy(pressStamp: PressStamp)
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

/// Chromium pickles a page's custom clipboard types into one pasteboard item of this type.
public let chromiumWebCustomDataType = "org.chromium.web-custom-data"

/// Whether Chromium custom clipboard data carries Monaco's `vscode-editor-data` entry for a
/// copy made with nothing selected. The pickle holds UTF-16 strings, and Monaco's JSON names
/// the flag the same way in every version, so a byte search needs no pickle walk.
public func isMonacoEmptySelectionCopy(webCustomData: Data) -> Bool {
    let marker = Data("\"isFromEmptySelection\":true".utf16.flatMap { [UInt8($0 & 0xFF), UInt8($0 >> 8)] })
    return webCustomData.range(of: marker) != nil
}

public enum WriteVerdict: Equatable, Sendable { case proceed, refuseSelectionChanged }

public func writeVerdict(origin: SelectionOrigin, readAX: () -> AXSelectionAnswer, readStamp: () -> PressStamp) -> WriteVerdict {
    switch origin {
    case .accessibility(let text, let range):
        return readAX() == .text(text, range: range) ? .proceed : .refuseSelectionChanged
    case .copy(let stamp):
        return readStamp() == stamp ? .proceed : .refuseSelectionChanged
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

    /// A target that answers the synthetic Cmd+C after the deadline leaves its selection on the
    /// clipboard with no run left to restore it. The change count alone cannot tell that late
    /// answer from a Cmd+C or Edit > Copy the user made in the window, so the press counters
    /// decide: the user's copy moves them, the helper's late answer does not, because its
    /// keystroke was posted before `deadlineStamp` was taken.
    public func lateRestoreNeeded(changeCount: Int, deadlineStamp: PressStamp, stamp: PressStamp) -> Bool {
        changeCount == startChangeCount + 1 && stamp == deadlineStamp
    }
}

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

    public mutating func clear() {
        slot = nil
    }
}
