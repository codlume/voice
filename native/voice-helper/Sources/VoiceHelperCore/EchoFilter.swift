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
    /// For each mic word, whether it is echo of `system`. Both lists in time order.
    public static func echoes(mic: [TimedWord], system: [TimedWord], output: OutputTimeline) -> [Bool] {
        let micKeys = mic.map { key($0.text) }
        let systemKeys = system.map { key($0.text) }
        func matches(_ i: Int, _ j: Int) -> Bool {
            !micKeys[i].isEmpty && micKeys[i] == systemKeys[j] && lagMs.contains(mic[i].startMs - system[j].startMs)
                && output.output(atMs: mic[i].startMs) == .speakers
        }
        // Longest common ordered subsequence under `matches`, then the system word each mic word repeats.
        var length = [[Int]](repeating: [Int](repeating: 0, count: system.count + 1), count: mic.count + 1)
        for i in stride(from: mic.count - 1, through: 0, by: -1) {
            for j in stride(from: system.count - 1, through: 0, by: -1) {
                length[i][j] = matches(i, j) ? length[i + 1][j + 1] + 1 : max(length[i + 1][j], length[i][j + 1])
            }
        }
        var repeats = [Int?](repeating: nil, count: mic.count)
        var i = 0
        var j = 0
        while i < mic.count, j < system.count {
            if matches(i, j), length[i][j] == length[i + 1][j + 1] + 1 {
                repeats[i] = j
                i += 1
                j += 1
            } else if length[i + 1][j] >= length[i][j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        // Runs of repeated words. A word the model heard differently ("bill" for "build") stays in
        // its run only where it sounds like the one system word the run skips there; the user's
        // own word between two echoes does not.
        var echoes = [Bool](repeating: false, count: mic.count)
        var start = 0
        while start < mic.count {
            guard var last = repeats[start] else {
                start += 1
                continue
            }
            var end = start + 1
            var count = 1
            while end < mic.count {
                if let next = repeats[end] {
                    last = next
                    count += 1
                    end += 1
                } else if end + 1 < mic.count, let next = repeats[end + 1], next == last + 2,
                          misheard(micKeys[end], as: systemKeys[last + 1]) {
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

    static func misheard(_ heard: String, as said: String) -> Bool {
        let a = Array(heard)
        let b = Array(said)
        guard !a.isEmpty, !b.isEmpty else { return false }
        var row = Array(0...b.count)
        for i in 1...a.count {
            var previous = row[0]
            row[0] = i
            for j in 1...b.count {
                let diagonal = previous
                previous = row[j]
                row[j] = min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
        }
        return row[b.count] * 2 <= max(a.count, b.count)
    }

    /// A word as compared: its letters and digits, lowercased, so "Friday." and "friday" match.
    static func key(_ text: String) -> String {
        String(text.lowercased().filter { $0.isLetter || $0.isNumber })
    }
}

/// The live view's echo check, which drops the echo runs `EchoPolicy` finds in a mic segment. A
/// mic segment waits until the system transcript passes it, so the
/// check sees every system word it needs, but never longer than `waitMs`: the user's own line
/// shows soon even while the other side talks on without a pause or its decode runs late. With
/// headphones on it does not wait at all.
public struct EchoFilter: Sendable {
    public static let waitMs = 3000.0
    /// System words this far behind can no longer match a mic segment.
    static let keepMs = 60_000.0

    private struct Waiting {
        let segment: TimedText
        let words: [TimedWord]
        let sinceMs: Double
    }

    private var system: [TimedWord] = []
    private var waiting: [Waiting] = []
    private var ready: [TimedText] = []
    private var dropped: [TimedText] = []

    public init() {}

    /// A final segment with the words it was decoded from, in meeting time. `nowMs` is a
    /// monotonic clock, the same one `release` gets.
    public mutating func add(_ segment: TimedText, words: [TimedWord], nowMs: Double) {
        switch segment.source {
        case .system:
            system += words
            ready.append(segment)
        case .mic:
            waiting.append(Waiting(segment: segment, words: words, sinceMs: nowMs))
        }
    }

    /// Segments to publish, in the order they became final. `systemMs` is how far the system
    /// transcript reaches, infinity when no system audio is coming.
    public mutating func release(systemMs: Double, nowMs: Double, output: OutputTimeline) -> [TimedText] {
        var due: [Waiting] = []
        waiting.removeAll { item in
            let segment = item.segment
            let isDue = output.output(atMs: segment.startMs) == .headphones && output.output(atMs: segment.endMs) == .headphones
                || segment.endMs + EchoPolicy.lagMs.upperBound <= systemMs
                || item.sinceMs + Self.waitMs <= nowMs
            if isDue { due.append(item) }
            return isDue
        }
        for item in due {
            let echoes = EchoPolicy.echoes(mic: item.words, system: system, output: output)
            guard echoes.contains(true) else {
                ready.append(item.segment)
                continue
            }
            // Only the echo goes; the user's words around it stay, as in the final pass.
            for run in runs(item.words, echoes) {
                let text = TimedText(source: .mic, startMs: run.words[0].startMs, endMs: run.words[run.words.count - 1].endMs,
                                     text: run.words.map(\.text).joined(separator: " "))
                if run.echo { dropped.append(text) } else { ready.append(text) }
            }
        }
        let horizon = min(systemMs, waiting.map(\.segment.startMs).min() ?? .infinity) - Self.keepMs
        system.removeAll { $0.endMs < horizon }
        defer { ready.removeAll() }
        return ready
    }

    private func runs(_ words: [TimedWord], _ echoes: [Bool]) -> [(echo: Bool, words: [TimedWord])] {
        zip(words, echoes).reduce(into: []) { runs, pair in
            if runs.last?.echo == pair.1 { runs[runs.count - 1].words.append(pair.0) } else { runs.append((pair.1, [pair.0])) }
        }
    }

    /// Mic text dropped as echo since the last call.
    public mutating func takeDropped() -> [TimedText] {
        defer { dropped.removeAll() }
        return dropped
    }
}
