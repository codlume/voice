import Dispatch
import Foundation

public struct HeardAudio: Sendable {
    public let samples: [Float]
    /// The sound in `samples`, split where quiet lasts a long pause. On the mic, only the sound
    /// the voice detector heard a voice in, or all of it when no detector could tell.
    public let runs: [Range<Int>]
    /// The voice detector after this stretch, to hear the stretch that follows with. nil for
    /// system audio, and for a mic stretch no detector could tell about: the stretch that
    /// follows starts with a new one.
    public let detector: (any VoiceDetector)?

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
    /// file). On the mic, only sound `detector` heard a voice in is decoded. System audio is
    /// never put to the detector.
    ///
    /// Pass the detector the stretch before this one returned, or a new one, and keep the one
    /// returned only once this stretch is done with. Without a detector, or with one that
    /// cannot tell, every sound is decoded.
    public func listen(in dir: URL, offset: Int, count: Int, detector: (any VoiceDetector)?) async throws -> HeardAudio {
        let samples = try await heard(in: dir, offset: offset, count: count)
        let runs = MeetingChunker.speechRuns(in: samples)
        let chunks = (samples.count + VoiceActivity.chunkSamples - 1) / VoiceActivity.chunkSamples
        guard self == .mic, let heard = await detector?.hear(samples), heard.probabilities.count == chunks else {
            return HeardAudio(samples: samples, runs: runs, detector: nil)
        }
        return HeardAudio(samples: samples, runs: VoiceActivity.confirmed(runs, by: heard.probabilities), detector: heard.next)
    }

    /// How much of this source from `offset` the live transcript takes as its next window, or nil
    /// while the audio there may still change. `available` frames are on disk; `ended` means the
    /// files stop growing. It reads and scans seconds of audio, so it never runs on main.
    public func liveWindow(in dir: URL, offset: Int, available: Int, ended: Bool) async throws -> Int? {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let raw = try PcmFile.read(at: file(in: dir), offset: offset, count: min(available, MeetingChunker.windowSamples))
        return MeetingChunker.cut(raw, final: ended && available <= raw.count)
    }

    /// How much of this source from `offset` the final pass takes as its next window, or nil at
    /// the end of the file. It never runs on main, for the same reason as `liveWindow`.
    public func finalWindow(in dir: URL, offset: Int) async throws -> Int? {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let samples = try PcmFile.read(at: file(in: dir), offset: offset, count: MeetingChunker.finalWindowSamples)
        return samples.isEmpty ? nil : MeetingChunker.finalCut(samples)
    }

    func heard(in dir: URL, offset: Int, count: Int) async throws -> [Float] {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return switch self {
        case .system: try PcmFile.read(at: file(in: dir), offset: offset, count: count)
        case .mic: try EchoGate.read(mic: file(in: dir), system: MeetingSource.system.file(in: dir), offset: offset, count: count)
        }
    }
}
