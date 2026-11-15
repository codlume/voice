/// A voice detector at one point in a stream of audio. Hearing more gives the detector as it is
/// after that audio and leaves this one where it was. So whoever keeps a detector decides what
/// it has heard: keep the new one to move on, keep the old one to hear the same audio again.
public protocol VoiceDetector: Sendable {
    /// How likely each 256 ms chunk of `samples` holds a voice, a short last chunk included, and
    /// the detector after them. nil when it could not tell.
    func hear(_ samples: [Float]) async -> (probabilities: [Float], next: any VoiceDetector)?
}
