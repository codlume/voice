/// Where a chunk of meeting audio goes in its file. A leg writes both of its files by this rule,
/// from the frame each chunk's capture time maps to, so audio captured at one moment sits at one
/// frame in both. `EchoGate` finds the other side's echo in the mic only when that holds.
public enum MeetingTimeline {
    /// A chunk this close to the file's end follows it as it is. Covers the resampler's latency,
    /// timestamp jitter and one dropped IO buffer, so steady capture is never cut or padded.
    public static let slack = PcmFile.frames(milliseconds: 20)
    /// A source clock that runs fast falls behind by `slack` at a time. A chunk stamped further
    /// behind than this has a bad timestamp, and its audio is kept.
    public static let longestSlip = PcmFile.frames(milliseconds: 200)

    public enum Placement: Equatable, Sendable {
        case append
        /// The source recorded nothing for this many frames, which go in first.
        case pad(silence: Int)
        /// This many leading samples repeat frames the file already holds.
        case skip(Int)
    }

    /// `target` is the frame the chunk's first sample was captured at, `written` the file's
    /// length and `count` the chunk's.
    public static func place(target: Int, written: Int, count: Int) -> Placement {
        let ahead = target - written
        if ahead > slack { return .pad(silence: ahead) }
        if ahead < -slack, ahead >= -longestSlip { return .skip(min(-ahead, count)) }
        return .append
    }
}
