import Dispatch
import Foundation

/// What the speech model hears of one stretch of a source, and the runs in it to decode.
public struct HeardAudio: Sendable {
    public let samples: [Float]
    /// The sound in `samples`, split where quiet lasts a long pause. On the mic, only the sound
    /// the voice detector heard a voice in, or all of it when no detector could tell.
    public let runs: [Range<Int>]
    /// The voice detector after this stretch, to hear the stretch that follows with. nil for
    /// system audio, and for a mic stretch no detector could tell about: the stretch that
    /// follows starts with a new one.
    public let detector: (any VoiceDetector)?

    /// From the first run to the last, or nil when there is nothing to decode.
    public var speech: Range<Int>? {
        guard let first = runs.first, let last = runs.last else { return nil }
        return first.lowerBound..<last.upperBound
    }
}

extension MeetingSource {
    public func file(in dir: URL) -> URL {
        dir.appendingPathComponent("\(rawValue).pcm")
    }

    /// What to decode of this source over `offset..<offset + count` (fewer at the end of the
    /// file). Every decode of meeting audio reads through here, so nothing on the mic becomes
    /// the user's words unless `detector` heard a voice in it: the speech model invents a word
    /// for a knock or a footstep decoded on its own. System audio is never put to the detector.
    ///
    /// Pass the detector the stretch before this one returned, or a new one, and keep the one
    /// returned only once this stretch is done with. Without a detector, or with one that
    /// cannot tell, every sound is decoded.
    public func listen(in dir: URL, offset: Int, count: Int, detector: (any VoiceDetector)?) async throws -> HeardAudio {
        let samples = try await heard(in: dir, offset: offset, count: count)
        let runs = MeetingChunker.speechRuns(in: samples)
        let chunks = (samples.count + VoiceActivity.chunkSamples - 1) / VoiceActivity.chunkSamples
        // Scores that do not cover the stretch say nothing about the sound they leave out.
        guard self == .mic, let heard = await detector?.hear(samples), heard.probabilities.count == chunks else {
            return HeardAudio(samples: samples, runs: runs, detector: nil)
        }
        return HeardAudio(samples: samples, runs: VoiceActivity.confirmed(runs, by: heard.probabilities), detector: heard.next)
    }

    /// What the speech model hears of this source over `offset..<offset + count` (fewer at the end
    /// of the file): system audio as recorded, the mic with the other side's echo gated out. Runs
    /// off the main actor, which starts dictations and takes their audio.
    func heard(in dir: URL, offset: Int, count: Int) async throws -> [Float] {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return switch self {
        case .system: try PcmFile.read(at: file(in: dir), offset: offset, count: count)
        case .mic: try EchoGate.read(mic: file(in: dir), system: MeetingSource.system.file(in: dir), offset: offset, count: count)
        }
    }
}
