public struct SpeechSpan: Sendable {
    private static let speechWithinPeak: Float = 0.0316  // -30 dB
    private static let speechFloor: Float = 0.00178  // -55 dBFS
    private static let paddingSeconds = 0.2

    private var frames: [Int] = []
    private var levels: [Float] = []

    public init() {}

    public mutating func add(frames count: Int, rms: Float) {
        frames.append(count)
        levels.append(rms)
    }

    public func milliseconds(sampleRate: Double) -> Double? {
        guard let peak = levels.max() else { return nil }
        let threshold = max(peak * Self.speechWithinPeak, Self.speechFloor)
        var offset = 0
        var first: Int?
        var last = 0
        for (count, level) in zip(frames, levels) {
            if level >= threshold {
                if first == nil { first = offset }
                last = offset + count
            }
            offset += count
        }
        guard let first else { return nil }
        let padding = Int(sampleRate * Self.paddingSeconds)
        let spoken = min(last + padding, offset) - max(first - padding, 0)
        return Double(spoken) * 1000 / sampleRate
    }
}
