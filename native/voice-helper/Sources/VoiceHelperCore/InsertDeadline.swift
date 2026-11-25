import Foundation

/// Main waits a fixed time for `insert.result` and then tells the user the text was not
/// inserted. A write that starts after this deadline could land under that message, so every
/// write asks first, and an insert that ran out of time writes nothing.
public struct InsertDeadline: Sendable {
    /// Counted from the helper reading the `insert` line, so time the command spends queued
    /// behind other work on the main thread uses it up too.
    public static let window: TimeInterval = 4

    private let receivedAt: DispatchTime

    public init(receivedAt: DispatchTime) {
        self.receivedAt = receivedAt
    }

    public func passed(at now: DispatchTime = .now()) -> Bool {
        now >= receivedAt + Self.window
    }
}
