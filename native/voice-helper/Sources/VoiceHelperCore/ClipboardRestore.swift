/// The nspasteboard.org marker for passwords and other secrets.
public let concealedPasteboardType = "org.nspasteboard.ConcealedType"

public enum SavedClipboard<Item> {
    case items([Item])
    /// Any write marked concealed, such as a password manager's. The manager clears it on a
    /// timer, but only while the clipboard still holds its own write, so a restore would
    /// republish the password past that clear.
    case concealed

    public init(types: [String], items: () -> [Item]) {
        self = types.contains(concealedPasteboardType) ? .concealed : .items(items())
    }
}

extension SavedClipboard: Equatable where Item: Equatable {}
extension SavedClipboard: Sendable where Item: Sendable {}

public enum RestoreOutcome<Contents> {
    case restore(Contents)
    /// A later write of ours replaced this paste's pending restore.
    case superseded
    /// The clipboard no longer holds this paste's write.
    case changed
}

extension RestoreOutcome: Equatable where Contents: Equatable {}

/// Tracks the user's clipboard across paste insertions, keyed by the pasteboard `changeCount`
/// each paste's own write produced. Only the latest paste can restore: an earlier paste's
/// restore finds the clipboard changed and backs off.
public struct ClipboardRestore<Contents> {
    private var pending: (write: Int, saved: Contents)?
    private var kept: (write: Int, contents: Contents)?

    public init() {}

    /// What a paste about to overwrite the clipboard must put back later. While an earlier
    /// paste's write is still on the clipboard, the clipboard holds our transcript rather than
    /// the user's contents, so the earlier paste's saved contents carry over.
    public func contentsToSave(changeCount: Int, current: () -> Contents) -> Contents {
        if let pending, pending.write == changeCount { return pending.saved }
        // Our own kept transcript carries the concealed marker, which would read as a password.
        if let kept, kept.write == changeCount { return kept.contents }
        return current()
    }

    public mutating func wrote(_ write: Int, saved: Contents) {
        pending = (write, saved)
    }

    /// A paste that leaves its text on the clipboard. Nothing is left to restore, and a later
    /// save while the clipboard still holds `write` saves `contents`.
    public mutating func kept(_ write: Int, contents: Contents) {
        pending = nil
        kept = (write, contents)
    }

    public var hasPending: Bool { pending != nil }

    public mutating func restore(write: Int, changeCount: Int) -> RestoreOutcome<Contents> {
        guard let pending, pending.write == write else { return .superseded }
        self.pending = nil
        return changeCount == write ? .restore(pending.saved) : .changed
    }

    /// The contents to put back right now, for a helper exiting before the scheduled restore
    /// ran. Nil when nothing is pending or the clipboard no longer holds our write.
    public mutating func flush(changeCount: Int) -> Contents? {
        guard let pending, case .restore(let saved) = restore(write: pending.write, changeCount: changeCount)
        else { return nil }
        return saved
    }
}
