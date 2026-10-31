import Foundation

public struct TimedText: Equatable, Sendable {
    public let source: MeetingSource
    public let startMs: Double
    public let endMs: Double
    public let text: String

    public init(source: MeetingSource, startMs: Double, endMs: Double, text: String) {
        self.source = source
        self.startMs = startMs
        self.endMs = endMs
        self.text = text
    }
}

/// Where the other side's voices played. Only speakers can play them into the microphone.
public enum MeetingOutput: String, Codable, Sendable { case speakers, headphones }

/// The output over a meeting's timeline, from the `output.ndjson` each recording leg appends to
/// beside the audio: one `{"frame":…,"output":…}` line per change, in frames of the audio files.
/// Before the first entry, or with no file, the output counts as speakers.
public struct OutputTimeline: Equatable, Sendable {
    public static let fileName = "output.ndjson"

    private var changes: [(atMs: Double, output: MeetingOutput)] = []

    public init(_ changes: [(atMs: Double, output: MeetingOutput)] = []) {
        self.changes = changes.sorted { $0.atMs < $1.atMs }
    }

    /// The file in `dir`, with frames turned into meeting ms from `baseMs`. A torn last line is skipped.
    public static func read(dir: URL, baseMs: Double) -> OutputTimeline {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(fileName)) else { return OutputTimeline() }
        let entries = data.split(separator: UInt8(ascii: "\n")).compactMap { line in
            try? JSONDecoder().decode(Entry.self, from: Data(line))
        }
        return OutputTimeline(entries.map { (baseMs + PcmFile.milliseconds($0.frame), $0.output) })
    }

    public static func append(_ output: MeetingOutput, atFrame frame: Int, dir: URL) throws {
        let url = dir.appendingPathComponent(fileName)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: try JSONEncoder().encode(Entry(frame: frame, output: output)) + Data("\n".utf8))
    }

    public func output(atMs ms: Double) -> MeetingOutput {
        changes.last { $0.atMs <= ms }?.output ?? .speakers
    }

    public static func == (lhs: OutputTimeline, rhs: OutputTimeline) -> Bool {
        lhs.changes.elementsEqual(rhs.changes) { $0.atMs == $1.atMs && $0.output == $1.output }
    }

    private struct Entry: Codable {
        let frame: Int
        let output: MeetingOutput
    }
}

/// When the microphone heard the other side through the speakers, their words come back as the
/// user's. A lost user line is worse than a repeated one, so a mic word counts as echo only with
/// acoustic evidence: the other side played on speakers, and the word is part of a run of at
/// least `minimumWords` that repeats system words in order, each a moment after the system said
/// it. People answer by repeating what they heard, but a beat later, never at the same instant.
/// The live view and the final pass both decide with this.
public enum EchoPolicy {
    /// Shorter runs always stay the user's: "Yes.", "Okay, Friday."
    public static let minimumWords = 4
    /// How far a mic word may trail the system word it repeats. It may also lead it a little: the
    /// two files' clocks start a device's latency apart, and word times are only that exact.
    static let lagMs = -400.0...700.0
    /// The share of a live segment's words that must be echo to drop it; a segment that mixes the
    /// user's words with echo stays whole.
    static let segmentShare = 0.8

    /// For each mic word, whether it is echo of `system`. Both lists in time order.
    public static func echoes(mic: [TimedWord], system: [TimedWord], output: OutputTimeline) -> [Bool] {
        let micKeys = mic.map { key($0.text) }
        let systemKeys = system.map { key($0.text) }
        func matches(_ i: Int, _ j: Int) -> Bool {
            !micKeys[i].isEmpty && micKeys[i] == systemKeys[j] && lagMs.contains(mic[i].startMs - system[j].startMs)
                && output.output(atMs: mic[i].startMs) == .speakers
        }
        // Longest common ordered subsequence under `matches`, then the mic words it uses.
        var length = [[Int]](repeating: [Int](repeating: 0, count: system.count + 1), count: mic.count + 1)
        for i in stride(from: mic.count - 1, through: 0, by: -1) {
            for j in stride(from: system.count - 1, through: 0, by: -1) {
                length[i][j] = matches(i, j) ? length[i + 1][j + 1] + 1 : max(length[i + 1][j], length[i][j + 1])
            }
        }
        var matched = [Bool](repeating: false, count: mic.count)
        var i = 0
        var j = 0
        while i < mic.count, j < system.count {
            if matches(i, j), length[i][j] == length[i + 1][j + 1] + 1 {
                matched[i] = true
                i += 1
                j += 1
            } else if length[i + 1][j] >= length[i][j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        // Runs of matched words, bridging one word the model heard differently.
        var echoes = [Bool](repeating: false, count: mic.count)
        var start = 0
        while start < mic.count {
            guard matched[start] else {
                start += 1
                continue
            }
            var end = start + 1
            var count = 1
            while end < mic.count {
                if matched[end] {
                    count += 1
                    end += 1
                } else if end + 1 < mic.count, matched[end + 1] {
                    end += 1
                } else {
                    break
                }
            }
            if count >= minimumWords { for index in start..<end { echoes[index] = true } }
            start = end
        }
        return echoes
    }

    /// Whether a whole live segment is echo.
    public static func isEcho(_ mic: [TimedWord], system: [TimedWord], output: OutputTimeline) -> Bool {
        guard mic.count >= minimumWords else { return false }
        let echoed = echoes(mic: mic, system: system, output: output).filter { $0 }.count
        return Double(echoed) / Double(mic.count) >= segmentShare
    }

    /// A word as compared: its letters and digits, lowercased, so "Friday." and "friday" match.
    static func key(_ text: String) -> String {
        String(text.lowercased().filter { $0.isLetter || $0.isNumber })
    }
}

/// The live view's echo check. A mic segment waits until the system transcript passes it, so the
/// check sees every system word it needs, but never longer than `waitMs` of further mic audio:
/// the user's own line shows soon even while the other side talks on without a pause. With
/// headphones on it does not wait at all.
public struct EchoFilter: Sendable {
    public static let waitMs = 3000.0
    /// System words this far behind can no longer match a mic segment.
    static let keepMs = 60_000.0

    private struct Waiting {
        let segment: TimedText
        let words: [TimedWord]
    }

    private var system: [TimedWord] = []
    private var waiting: [Waiting] = []
    private var ready: [TimedText] = []
    private var dropped: [TimedText] = []

    public init() {}

    /// A final segment with the words it was decoded from, in meeting time.
    public mutating func add(_ segment: TimedText, words: [TimedWord]) {
        switch segment.source {
        case .system:
            system += words
            ready.append(segment)
        case .mic:
            waiting.append(Waiting(segment: segment, words: words))
        }
    }

    /// Segments to publish, in the order they became final. `systemMs` is how far the system
    /// transcript reaches (infinity when no system audio is coming), `micMs` how far mic audio is
    /// recorded.
    public mutating func release(systemMs: Double, micMs: Double, output: OutputTimeline) -> [TimedText] {
        var due: [Waiting] = []
        waiting.removeAll { item in
            let segment = item.segment
            let isDue = output.output(atMs: segment.startMs) == .headphones && output.output(atMs: segment.endMs) == .headphones
                || segment.endMs + EchoPolicy.lagMs.upperBound <= systemMs
                || segment.endMs + Self.waitMs <= micMs
            if isDue { due.append(item) }
            return isDue
        }
        for item in due {
            if EchoPolicy.isEcho(item.words, system: system, output: output) {
                dropped.append(item.segment)
            } else {
                ready.append(item.segment)
            }
        }
        let horizon = min(systemMs, waiting.map(\.segment.startMs).min() ?? .infinity) - Self.keepMs
        system.removeAll { $0.endMs < horizon }
        defer { ready.removeAll() }
        return ready
    }

    /// Mic segments dropped as echo since the last call.
    public mutating func takeDropped() -> [TimedText] {
        defer { dropped.removeAll() }
        return dropped
    }
}
