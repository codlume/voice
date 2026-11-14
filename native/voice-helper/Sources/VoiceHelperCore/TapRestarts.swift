/// How often a leg's system tap may be recreated before the leg gives up on it. Only restarts in
/// a row count: a tap that recorded for a while after a restart has recovered, however many
/// format changes and stalls a long meeting brings.
public struct TapRestarts: Sendable {
    public static let limit = 3
    /// A stalled tap is noticed and recreated within about five seconds, so a tap that went this
    /// long without a restart recorded for most of it.
    public static let settledMs = 30_000.0

    private var inARow = 0
    private var lastMs: Double?

    public init() {}

    /// Counts a restart at `nowMs` on any steady clock. False when this is one more than `limit`
    /// in a row: the tap keeps stalling, and the leg ends instead.
    public mutating func allows(restartAtMs nowMs: Double) -> Bool {
        if let lastMs, nowMs - lastMs >= Self.settledMs { inARow = 0 }
        lastMs = nowMs
        inARow += 1
        return inARow <= Self.limit
    }
}
