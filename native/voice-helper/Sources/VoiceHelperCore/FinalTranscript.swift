import Foundation

/// A word the speech model placed in time, in meeting ms.
public struct TimedWord: Equatable, Sendable {
    public let text: String
    public let startMs: Double
    public let endMs: Double

    public init(text: String, startMs: Double, endMs: Double) {
        self.text = text
        self.startMs = startMs
        self.endMs = endMs
    }
}

/// A stretch of system audio the diarizer gave to one voice, in meeting ms. `speaker` is the
/// diarizer's own cluster name, which means nothing outside one run.
public struct SpeakerTurn: Equatable, Sendable {
    public let speaker: String
    public let startMs: Double
    public let endMs: Double

    public init(speaker: String, startMs: Double, endMs: Double) {
        self.speaker = speaker
        self.startMs = startMs
        self.endMs = endMs
    }
}

/// A segment of the final transcript. `speaker` numbers the voices on system audio 0, 1, … in
/// the order they first speak; nil on the mic, and on system audio nobody could tell apart.
public struct FinalSegment: Equatable, Sendable {
    public let source: MeetingSource
    public let startMs: Double
    public let endMs: Double
    public let text: String
    public let speaker: Int?

    public init(source: MeetingSource, startMs: Double, endMs: Double, text: String, speaker: Int?) {
        self.source = source
        self.startMs = startMs
        self.endMs = endMs
        self.text = text
        self.speaker = speaker
    }
}

/// Builds the final transcript from both streams' timed words and the system stream's speaker
/// turns: words become segments at pauses, long runs and speaker changes, and mic segments that
/// only echo the other side are dropped, as during the meeting.
public enum FinalTranscript {
    /// A pause this long between two words starts a new segment.
    static let pauseMs = 800.0
    /// A segment this long ends at its next sentence end, and never runs past twice this.
    static let longMs = 30_000.0
    /// A word no turn covers takes the nearest turn this close.
    static let nearMs = 1000.0

    /// Words from the speech model's tokens, whose text starts with a space where a word starts.
    /// Times are ms from the start of the decoded audio plus `offsetMs`.
    public static func words(tokens: [(text: String, startMs: Double, endMs: Double)], offsetMs: Double) -> [TimedWord] {
        var words: [TimedWord] = []
        for token in tokens where !token.text.isEmpty {
            let piece = token.text.trimmingCharacters(in: .whitespaces)
            if let last = words.last, !token.text.hasPrefix(" ") {
                words[words.count - 1] = TimedWord(text: last.text + piece, startMs: last.startMs, endMs: offsetMs + token.endMs)
            } else if !piece.isEmpty {
                words.append(TimedWord(text: piece, startMs: offsetMs + token.startMs, endMs: offsetMs + token.endMs))
            }
        }
        return words
    }

    /// `turns` is nil when there was no diarization, which leaves every system speaker nil.
    public static func segments(mic: [TimedWord], system: [TimedWord], turns: [SpeakerTurn]?) -> [FinalSegment] {
        let systemRuns = group(system, speakers: turns.map { turns in assign(system, to: turns) })
        var filter = EchoFilter()
        for run in systemRuns { filter.add(TimedText(source: .system, startMs: run.startMs, endMs: run.endMs, text: run.text)) }
        let micRuns = group(mic, speakers: nil).filter {
            !filter.isEcho(TimedText(source: .mic, startMs: $0.startMs, endMs: $0.endMs, text: $0.text))
        }
        var numbers: [String: Int] = [:]
        let named = systemRuns.map { run in
            let number = run.speaker.map { speaker in
                if let known = numbers[speaker] { return known }
                numbers[speaker] = numbers.count
                return numbers.count - 1
            }
            return FinalSegment(source: .system, startMs: run.startMs, endMs: run.endMs, text: run.text, speaker: number)
        }
        let mine = micRuns.map { FinalSegment(source: .mic, startMs: $0.startMs, endMs: $0.endMs, text: $0.text, speaker: nil) }
        return (named + mine).sorted { $0.startMs < $1.startMs }
    }

    private struct Run {
        let startMs: Double
        let endMs: Double
        let text: String
        let speaker: String?
    }

    private static func group(_ words: [TimedWord], speakers: [String?]?) -> [Run] {
        var runs: [Run] = []
        var current: [TimedWord] = []
        var speaker: String?
        func close() {
            guard let first = current.first, let last = current.last else { return }
            runs.append(Run(startMs: first.startMs, endMs: last.endMs, text: current.map(\.text).joined(separator: " "), speaker: speaker))
            current = []
        }
        for (index, word) in words.enumerated() {
            let next = speakers?[index] ?? nil
            if let first = current.first, let last = current.last {
                let length = last.endMs - first.startMs
                let sentenceEnd = last.text.last.map { ".?!".contains($0) } ?? false
                if word.startMs - last.endMs >= pauseMs || next != speaker || length >= 2 * longMs || (length >= longMs && sentenceEnd) {
                    close()
                }
            }
            speaker = next
            current.append(word)
        }
        close()
        return runs
    }

    // Each word takes the turn it overlaps most, else the nearest close turn, else the speaker
    // before it, so a word the diarizer missed does not split its sentence.
    private static func assign(_ words: [TimedWord], to turns: [SpeakerTurn]) -> [String?] {
        var previous: String?
        return words.map { word in
            let overlapping = turns.map { turn in (turn, min(word.endMs, turn.endMs) - max(word.startMs, turn.startMs)) }
            let best = overlapping.filter { $0.1 > 0 }.max { $0.1 < $1.1 }?.0
            let near = turns.map { turn in (turn, max(turn.startMs - word.endMs, word.startMs - turn.endMs)) }
                .filter { $0.1 <= nearMs }.min { $0.1 < $1.1 }?.0
            let speaker = (best ?? near)?.speaker ?? previous
            previous = speaker
            return speaker
        }
    }
}
