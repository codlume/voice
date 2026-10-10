import AVFoundation
import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

private final class EmittedLines: @unchecked Sendable {
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

private func writeAudio(to url: URL, seconds: Double, silent: Bool) throws {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
    let frames = AVAudioFrameCount(seconds * 16_000)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    if !silent, let channel = buffer.floatChannelData?[0] {
        for i in 0..<Int(frames) { channel[i] = 0.3 * sin(Float(i) * 2 * .pi * 440 / 16_000) }
    }
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    try file.write(from: buffer)
}

private func sessionEvents(_ events: [[String: Any]]) -> [[String: Any]] {
    events.filter { event in
        guard let type = event["type"] as? String else { return false }
        return type != "capture.level" && (type.hasPrefix("capture.") || type.hasPrefix("transcript"))
    }
}

@Suite(.serialized)
struct CaptureStopTests {
    @Test(arguments: [(audio: "silence", terminal: "transcript"), (audio: "tone with no model", terminal: "transcript.failed")])
    @MainActor func reportsTheDurationCapBeforeTheCaptureEnds(audio: String, terminal: String) async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("capture.caf")
        try writeAudio(to: file, seconds: 1, silent: audio == "silence")
        let devices = AudioInputDevices(output: output)
        defer { devices.shutdown() }
        let noModels = dir.appendingPathComponent("no-models")
        let capture = Capture(output: output, transcriber: Transcriber(modelsDir: noModels, output: output), devices: devices, maxSamples: 4800)
        capture.testAudioPath = file.path

        capture.start(id: "s1", language: .en, frontmostPid: nil, receivedAt: .now(), muteWhileDictating: false, microphone: nil)
        let events = sessionEvents(try await lines.wait(for: terminal))

        #expect(events.map { $0["type"] as? String } == ["capture.started", "capture.stopped", terminal])
        #expect(events[1]["id"] as? String == "s1")
        #expect(events[1]["reason"] as? String == "maxDuration")
        #expect(!capture.isActive)

        capture.stop(id: "s1")
        try await Task.sleep(for: .milliseconds(300))
        #expect(sessionEvents(lines.snapshot()).count == events.count)
    }
}
