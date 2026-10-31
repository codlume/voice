import AVFoundation
import Foundation
import Testing
import VoiceHelperCore

final class EmittedLines: @unchecked Sendable {
    let pipe = Pipe()
    private let lock = NSLock()
    private var buffer = Data()
    private var lines: [[String: Any]] = []

    init() {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
    }

    private func consume(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(data)
        guard let text = String(data: buffer, encoding: .utf8) else { return }
        var parts = text.components(separatedBy: "\n")
        buffer = Data(parts.removeLast().utf8)
        for part in parts where !part.isEmpty {
            if let object = try? JSONSerialization.jsonObject(with: Data(part.utf8)) as? [String: Any] {
                lines.append(object)
            }
        }
    }

    func snapshot() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }

    func wait(for type: String, timeout: Duration = .seconds(5)) async throws -> [[String: Any]] {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            let current = snapshot()
            if current.contains(where: { $0["type"] as? String == type }) { return current }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw ProtocolError("no \(type) event within \(timeout)")
    }
}

func writeAudio(to url: URL, seconds: Double, silent: Bool) throws {
    try writeAudio(to: url, segments: [(seconds, silent)])
}

/// A 440 Hz tone for each non-silent segment, silence for the rest, in order.
func writeAudio(to url: URL, segments: [(seconds: Double, silent: Bool)]) throws {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
    let frames = AVAudioFrameCount(segments.reduce(0) { $0 + $1.seconds } * 16_000)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    let channel = try #require(buffer.floatChannelData?[0])
    var offset = 0
    for segment in segments {
        let count = Int(segment.seconds * 16_000)
        for i in offset..<offset + count {
            channel[i] = segment.silent ? 0 : 0.3 * sin(Float(i) * 2 * .pi * 440 / 16_000)
        }
        offset += count
    }
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    try file.write(from: buffer)
}

func sessionEvents(_ events: [[String: Any]]) -> [[String: Any]] {
    events.filter { event in
        guard let type = event["type"] as? String else { return false }
        return type != "capture.level" && (type.hasPrefix("capture.") || type.hasPrefix("transcript"))
    }
}

/// `text` as words spread over the loud part of `samples`, timed in ms into them, as a fake
/// speech model's answer.
func spokenWords(_ text: String, in samples: [Float]) -> [TimedWord] {
    let first = samples.firstIndex { abs($0) > 0.01 } ?? 0
    let last = samples.lastIndex { abs($0) > 0.01 } ?? samples.count
    let words = text.split(separator: " ")
    let wordMs = PcmFile.milliseconds(last - first) / Double(max(words.count, 1))
    return words.enumerated().map { index, word in
        let startMs = PcmFile.milliseconds(first) + Double(index) * wordMs
        return TimedWord(text: String(word), startMs: startMs, endMs: startMs + wordMs)
    }
}
