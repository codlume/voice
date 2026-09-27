/// Successful windows are the only acknowledgement available from the streaming ASR adapter.
public struct StreamingCoverage: Sendable {
    private let chunkSamples: Int
    private let minimumSamples: Int
    private var maximumPendingSamples: Int { 2 * minimumSamples }

    private var fedSamples = 0
    private var successfulWindows = 0

    public init(chunkSamples: Int, minimumSamples: Int) {
        self.chunkSamples = chunkSamples
        self.minimumSamples = minimumSamples
    }

    public mutating func feed(_ sampleCount: Int) -> Bool {
        guard sampleCount >= 0,
            fedSamples + sampleCount - successfulWindows * chunkSamples <= maximumPendingSamples
        else { return false }
        fedSamples += sampleCount
        return true
    }

    public mutating func completeWindow() {
        successfulWindows += 1
    }

    public func covers(_ sampleCount: Int) -> Bool {
        sampleCount >= minimumSamples && fedSamples == sampleCount
            && successfulWindows == (sampleCount + chunkSamples - 1) / chunkSamples
    }
}
