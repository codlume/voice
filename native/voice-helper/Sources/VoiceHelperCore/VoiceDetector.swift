/// A voice detector at one point in a stream of audio. Hearing more gives the detector as it is
/// after that audio and leaves this one where it was. So whoever keeps a detector decides what
/// it has heard: keep the new one to move on, keep the old one to hear the same audio again.
public protocol VoiceDetector: Sendable {
    /// How likely each 256 ms chunk of `samples` holds a voice, a short last chunk included, and
    /// the detector after them. nil when it could not tell.
    func hear(_ samples: [Float]) async -> (probabilities: [Float], next: any VoiceDetector)?
}

public enum VoiceActivity {
    /// The detector scores audio in chunks of 256 ms.
    public static let chunkSamples = 4096
    static let voice: Float = 0.9

    static func confirmed(_ runs: [Range<Int>], by probabilities: [Float]) -> [Range<Int>] {
        runs.filter { run in
            (run.lowerBound / chunkSamples...(run.upperBound - 1) / chunkSamples).contains { probabilities[$0] >= voice }
        }
    }
}
