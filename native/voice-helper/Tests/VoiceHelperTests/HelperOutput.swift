import AVFoundation
import Foundation
import Testing
import VoiceHelperCore
import os

final class EmittedLines: @unchecked Sendable {
    let pipe = Pipe()
    private let lock = NSLock()
    private var buffer = Data()
    private var lines: [[String: Any]] = []
    private var unparseable: [String] = []

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
            } else {
                unparseable.append(part)
            }
        }
    }

    func snapshot() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }

    private func firstUnparseable() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return unparseable.first
    }

    func wait(for type: String, timeout: Duration = .seconds(5)) async throws -> [[String: Any]] {
        let deadline = ContinuousClock.now + timeout
        while true {
            if let line = firstUnparseable() { throw ProtocolError("unparseable helper line: \(line)") }
            let current = snapshot()
            if current.contains(where: { $0["type"] as? String == type }) { return current }
            guard ContinuousClock.now < deadline else { throw ProtocolError("no \(type) event within \(timeout)") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

func writeAudio(to url: URL, seconds: Double, silent: Bool) throws {
    try writeAudio(to: url, segments: [(seconds, silent)])
}

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

struct ScriptedDetector: VoiceDetector {
    let voiced: [Range<Int>]
    var heard = 0
    let asked = OSAllocatedUnfairLock(initialState: 0)

    func hear(_ samples: [Float]) async -> (probabilities: [Float], next: any VoiceDetector)? {
        asked.withLock { $0 += 1 }
        let probabilities = stride(from: 0, to: samples.count, by: 4096).map { start -> Float in
            let chunk = heard + start..<heard + min(start + 4096, samples.count)
            return voiced.contains { $0.overlaps(chunk) } ? 1 : 0
        }
        var next = self
        next.heard += samples.count
        return (probabilities, next)
    }
}
