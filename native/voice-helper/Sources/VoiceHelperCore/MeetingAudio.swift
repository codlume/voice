import Dispatch
import Foundation

extension MeetingSource {
    public func file(in dir: URL) -> URL {
        dir.appendingPathComponent("\(rawValue).pcm")
    }

    /// What the speech model hears of this source over `offset..<offset + count` (fewer at the end
    /// of the file): system audio as recorded, the mic with the other side's echo gated out. Runs
    /// off the main actor, which starts dictations and takes their audio.
    public func heard(in dir: URL, offset: Int, count: Int) async throws -> [Float] {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return switch self {
        case .system: try PcmFile.read(at: file(in: dir), offset: offset, count: count)
        case .mic: try EchoGate.read(mic: file(in: dir), system: MeetingSource.system.file(in: dir), offset: offset, count: count)
        }
    }
}
