import os

public final class CaptureInput: Sendable {
    private let pending = OSAllocatedUnfairLock<[[Float]]?>(initialState: [])

    public init() {}

    public func enqueue(_ samples: [Float]) -> Bool {
        pending.withLock {
            guard $0 != nil else { return false }
            $0?.append(samples)
            return true
        }
    }

    public func drain(closing: Bool = false) -> [[Float]] {
        pending.withLock {
            guard let chunks = $0 else { return [] }
            $0 = closing ? nil : []
            return chunks
        }
    }
}
