import Dispatch
import Foundation

/// What the speech model hears of one stretch of a source, and the runs in it to decode.
public struct HeardAudio: Sendable {
    public let samples: [Float]
    /// The sound in `samples`, split where quiet lasts a long pause.
    public let runs: [Range<Int>]
    /// The voice detector after this stretch, to hear the stretch that follows with.
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
    /// file). Every decode of meeting audio reads through here.
    public func listen(in dir: URL, offset: Int, count: Int, detector: (any VoiceDetector)?) async throws -> HeardAudio {
        let samples = try await heard(in: dir, offset: offset, count: count)
        return HeardAudio(samples: samples, runs: MeetingChunker.speechRuns(in: samples), detector: nil)
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
