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

/// On speakers the microphone also hears the other participants, so their words would show up
/// twice: once from system audio and once as "You". A mic segment whose words mostly appear in
/// system segments around the same time is that echo and is dropped. Mic segments wait until
/// the system transcript has passed them, so the comparison sees every system word it needs.
public struct EchoFilter: Sendable {
    public static let toleranceMs = 1500.0
    public static let echoShare = 0.6
    /// System segments this far behind the system transcript can no longer match a mic segment.
    static let keepMs = 60_000.0

    private var system: [TimedText] = []
    private var waiting: [TimedText] = []
    private var ready: [TimedText] = []
    private var systemThroughMs = 0.0
    public private(set) var dropped: [TimedText] = []

    public init() {}

    public mutating func add(_ segment: TimedText) {
        switch segment.source {
        case .system:
            system.append(segment)
            ready.append(segment)
        case .mic:
            waiting.append(segment)
        }
    }

    /// How far the system transcript reaches; infinity when no system audio is coming.
    public mutating func systemReached(_ ms: Double) {
        systemThroughMs = ms
    }

    /// Segments to publish, in the order they became final.
    public mutating func release() -> [TimedText] {
        let due = waiting.filter { $0.endMs + Self.toleranceMs <= systemThroughMs }
        waiting.removeAll { $0.endMs + Self.toleranceMs <= systemThroughMs }
        for segment in due {
            if isEcho(segment) { dropped.append(segment) } else { ready.append(segment) }
        }
        let horizon = min(systemThroughMs, waiting.map(\.startMs).min() ?? .infinity) - Self.keepMs
        system.removeAll { $0.endMs < horizon }
        defer { ready.removeAll() }
        return ready
    }

    public func isEcho(_ mic: TimedText) -> Bool {
        let words = Self.words(mic.text)
        guard !words.isEmpty else { return false }
        let heard = Set(system.filter {
            $0.startMs <= mic.endMs + Self.toleranceMs && $0.endMs >= mic.startMs - Self.toleranceMs
        }.flatMap { Self.words($0.text) })
        let echoed = words.filter(heard.contains).count
        return Double(echoed) / Double(words.count) >= Self.echoShare
    }

    static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }
}
