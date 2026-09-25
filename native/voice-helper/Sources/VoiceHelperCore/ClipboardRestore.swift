/// Tracks the user's clipboard across paste insertions, keyed by the pasteboard `changeCount`
/// each paste's own write produced. Only the latest paste can restore: an earlier paste's
/// restore finds the clipboard changed and backs off.
public struct ClipboardRestore<Contents> {
    private var pending: (write: Int, saved: Contents)?

    public init() {}

    /// What a paste about to overwrite the clipboard must put back later. While an earlier
    /// paste's write is still on the clipboard, the clipboard holds our transcript rather than
    /// the user's contents, so the earlier paste's saved contents carry over.
    public func contentsToSave(changeCount: Int, current: () -> Contents) -> Contents {
        if let pending, pending.write == changeCount { return pending.saved }
        return current()
    }

    public mutating func wrote(_ write: Int, saved: Contents) {
        pending = (write, saved)
    }

    /// The contents to put back for the paste whose write was `write`, or nil when the clipboard
    /// no longer holds that write.
    public mutating func restore(write: Int, changeCount: Int) -> Contents? {
        guard let pending, pending.write == write else { return nil }
        self.pending = nil
        return changeCount == write ? pending.saved : nil
    }
}
