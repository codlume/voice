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
/// turns: words become segments at pauses, long runs and speaker changes, and the mic words
/// `EchoPolicy` finds echo the other side are dropped, as during the meeting.
public enum FinalTranscript {
    /// A pause this long between two words starts a new segment.
    static let pauseMs = 800.0
    /// A segment this long ends at its next sentence end, and never runs past twice this.
    static let longMs = 30_000.0
    /// A word no turn covers takes the nearest turn this close.
    static let nearMs = 1000.0

    /// The longest a token is taken to sound. A token the model gave no duration otherwise ends
    /// where the next token starts, across any silence between them.
    static let tokenMs = 500.0

    /// Words from the speech model's tokens. A word starts at a token that begins with a space,
    /// or after a token that is only a space, as before a number. Punctuation joins its word but
    /// not its time: the model often emits a period well into the silence after the sentence.
    /// Times are ms from the start of the decoded audio plus `offsetMs`.
    public static func words(tokens: [(text: String, startMs: Double, endMs: Double)], offsetMs: Double) -> [TimedWord] {
        var words: [TimedWord] = []
        var boundary = true
        for token in tokens where !token.text.isEmpty {
            let piece = token.text.trimmingCharacters(in: .whitespaces)
            let startMs = offsetMs + token.startMs
            let endMs = offsetMs + min(token.endMs, token.startMs + tokenMs)
            if piece.isEmpty {
                boundary = true
                continue
            }
            let punctuation = !piece.contains { $0.isLetter || $0.isNumber }
            if let last = words.last, punctuation {
                // A second period emitted for the same sentence end is dropped.
                if !last.text.hasSuffix(piece) { words[words.count - 1] = TimedWord(text: last.text + piece, startMs: last.startMs, endMs: last.endMs) }
            } else if let last = words.last, !boundary, !token.text.hasPrefix(" ") {
                words[words.count - 1] = TimedWord(text: last.text + piece, startMs: last.startMs, endMs: max(last.endMs, endMs))
            } else {
                words.append(TimedWord(text: piece, startMs: startMs, endMs: endMs))
            }
            boundary = false
        }
        return words
    }

    /// `turns` is nil when there was no diarization, which leaves every system speaker nil.
    public static func segments(mic: [TimedWord], system: [TimedWord], turns: [SpeakerTurn]?, output: OutputTimeline) -> [FinalSegment] {
        let systemRuns = group(system, voices: turns.map { turns in assign(system, to: turns).map(Voice.speaker) })
        let echoes = EchoPolicy.echoes(mic: mic, system: system, output: output)
        let micRuns = group(mic, voices: echoes.map { $0 ? .echo : .user }).filter { $0.voice != .echo }
        var numbers: [String: Int] = [:]
        let named = systemRuns.map { run in
            var number: Int?
            if case .speaker(let speaker?) = run.voice {
                number = numbers[speaker] ?? numbers.count
                numbers[speaker] = number
            }
            return FinalSegment(source: .system, startMs: run.startMs, endMs: run.endMs, text: run.text, speaker: number)
        }
        let mine = micRuns.map { FinalSegment(source: .mic, startMs: $0.startMs, endMs: $0.endMs, text: $0.text, speaker: nil) }
        return (named + mine).sorted { $0.startMs < $1.startMs }
    }

    /// Who said a word: on the mic the user or the other side's echo; on system audio a
    /// diarizer cluster, nil where none covers it.
    private enum Voice: Equatable {
        case user
        case echo
        case speaker(String?)
    }

    private struct Run {
        let startMs: Double
        let endMs: Double
        let text: String
        let voice: Voice
    }

    private static func group(_ words: [TimedWord], voices: [Voice]?) -> [Run] {
        var runs: [Run] = []
        var current: [TimedWord] = []
        var voice = Voice.speaker(nil)
        func close() {
            guard let first = current.first, let last = current.last else { return }
            runs.append(Run(startMs: first.startMs, endMs: last.endMs, text: current.map(\.text).joined(separator: " "), voice: voice))
            current = []
        }
        for (index, word) in words.enumerated() {
            let next = voices?[index] ?? .speaker(nil)
            if let first = current.first, let last = current.last {
                let length = last.endMs - first.startMs
                let sentenceEnd = last.text.last.map { ".?!".contains($0) } ?? false
                if word.startMs - last.endMs >= pauseMs || next != voice || length >= 2 * longMs || (length >= longMs && sentenceEnd) {
                    close()
                }
            }
            voice = next
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
