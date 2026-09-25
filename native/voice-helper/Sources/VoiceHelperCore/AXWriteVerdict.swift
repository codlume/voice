public struct AXTextRange: Equatable, Sendable {
    public var location: Int
    public var length: Int

    public init(location: Int, length: Int) {
        self.location = location
        self.length = length
    }
}

/// What the focused element reports around an `AXSelectedText` write. Either field is nil when
/// the app does not expose it.
public struct AXTextState: Equatable, Sendable {
    public var value: String?
    public var selection: AXTextRange?

    public init(value: String?, selection: AXTextRange?) {
        self.value = value
        self.selection = selection
    }

    public var isObservable: Bool { value != nil && selection != nil }
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
