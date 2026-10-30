/// Reports each pause that follows speech as audio arrives, so a decode of everything so far can
/// start before the user releases. Speech is anything within 40 dB of the loudest chunk so far
/// (SpeechSpan uses 30 dB; the wider band errs toward treating a soft trailing word as speech, so
/// a decode that ran before it is not reused).
public struct PauseDetector: Sendable {
    private static let speechWithinPeak: Float = 0.01
    private static let speechFloor: Float = 0.00178

    private let pauseSamples: Int
    private var peak: Float = 0
    private var silenceRun = 0
    public private(set) var speechSinceLastPause = false

    public init(sampleRate: Double, pauseSeconds: Double = 0.3) {
        pauseSamples = Int(sampleRate * pauseSeconds)
    }

    /// True on the chunk that completes a pause after speech; once per pause.
    public mutating func add(frames count: Int, rms: Float) -> Bool {
        peak = max(peak, rms)
        if rms >= max(peak * Self.speechWithinPeak, Self.speechFloor) {
            speechSinceLastPause = true
            silenceRun = 0
            return false
        }
        silenceRun += count
        guard speechSinceLastPause, silenceRun >= pauseSamples else { return false }
        speechSinceLastPause = false
        silenceRun = 0
        return true
    }
}
