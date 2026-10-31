import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

private struct Unavailable: Error {}

/// `mic.pcm` and `system.pcm` with a loud tone on the mic, then two quieter system turns.
private func writeMeeting(in dir: URL) throws {
    func tone(_ seconds: Double, _ amplitude: Float) -> [Float] {
        (0..<Int(seconds * 16_000)).map { amplitude * sin(Float($0) * 2 * .pi * 440 / 16_000) }
    }
    func silence(_ seconds: Double) -> [Float] { [Float](repeating: 0, count: Int(seconds * 16_000)) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let mic = try PcmWriter(url: dir.appendingPathComponent("mic.pcm"))
    try mic.append(tone(2, 0.3) + silence(6))
    try mic.close()
    let system = try PcmWriter(url: dir.appendingPathComponent("system.pcm"))
    try system.append(silence(3) + tone(2, 0.1) + silence(1) + tone(1.5, 0.1) + silence(0.5))
    try system.close()
}

@MainActor
@Suite struct MeetingFinalPassTests {
    let lines = EmittedLines()
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-final-\(UUID().uuidString)")

    private func pass(
        diarize: @escaping MeetingFinalPass.Diarize, dictating: @escaping () -> Bool = { false },
        fail: Bool = false, decoded: @escaping (Int) -> Void = { _ in }
    ) -> MeetingFinalPass {
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        return MeetingFinalPass(output: output, decode: { samples, _ in
            decoded(samples.count)
            if fail { throw TranscribeError(reason: .asrUnavailable, message: "speech model is not downloaded") }
            let loud = (samples.map(abs).max() ?? 0) > 0.2
            let seconds = Double(samples.count) / 16
            // The system window's speech runs from its first turn to the end of its second.
            return loud
                ? [TimedWord(text: "Hello", startMs: 0, endMs: seconds / 2), TimedWord(text: "everyone", startMs: seconds / 2, endMs: seconds)]
                : [TimedWord(text: "Hi", startMs: 0, endMs: 2000), TimedWord(text: "again", startMs: 3000, endMs: 4500)]
        }, diarize: diarize, isDictating: dictating, idle: .milliseconds(5))
    }

    private func finalized() async throws -> [[String: Any]] {
        let events = try await lines.wait(for: "meeting.finalized")
        return try #require(events.last?["segments"] as? [[String: Any]])
    }

    @Test func numbersTheVoicesTheDiarizerFindsInMeetingTime() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeMeeting(in: dir)
        var diarized: [String] = []
        let run = pass(diarize: { url in
            diarized.append(url.lastPathComponent)
            return [SpeakerTurn(speaker: "S4", startMs: 3000, endMs: 5000), SpeakerTurn(speaker: "S1", startMs: 6000, endMs: 7500)]
        })
        await run.run(id: "m1", dir: dir, baseMs: 60_000, language: .en)
        let segments = try await finalized()
        #expect(diarized == ["system.pcm"])
        #expect(segments.map { $0["source"] as? String } == ["mic", "system", "system"])
        #expect(segments.map { $0["text"] as? String } == ["Hello everyone", "Hi", "again"])
        #expect(segments.map { $0["speaker"] as? Int } == [nil, 0, 1])
        #expect(segments.map { Int($0["startMs"] as? Double ?? -1) } == [60_000, 63_000, 66_000])
    }

    @Test func withoutDiarizationTheSystemSideStaysOneVoice() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeMeeting(in: dir)
        await pass(diarize: { _ in nil }).run(id: "m1", dir: dir, baseMs: 0, language: .en)
        let segments = try await finalized()
        #expect(segments.filter { $0["source"] as? String == "system" }.count == 2)
        #expect(segments.allSatisfy { $0["speaker"] is NSNull })
    }

    @Test func aDecodeThatFailsReportsTheFailureAndNoTranscript() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeMeeting(in: dir)
        await pass(diarize: { _ in [] }, fail: true).run(id: "m1", dir: dir, baseMs: 0, language: .en)
        let failed = try await lines.wait(for: "meeting.finalizeFailed")
        #expect(failed.last?["message"] as? String == "speech model is not downloaded")
        #expect(lines.snapshot().allSatisfy { $0["type"] as? String != "meeting.finalized" })
    }

    @Test func dictationHoldsEveryDecodeAndTheDiarizer() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeMeeting(in: dir)
        var dictating = true
        var decodes = 0
        var diarizations = 0
        let run = Task {
            await pass(diarize: { _ in diarizations += 1; return [] }, dictating: { dictating }, decoded: { _ in decodes += 1 })
                .run(id: "m1", dir: dir, baseMs: 0, language: .en)
        }
        try await Task.sleep(for: .milliseconds(100))
        #expect(decodes == 0)
        dictating = false
        await run.value
        #expect(decodes == 2)
        #expect(diarizations == 1)
    }
}

@MainActor
@Suite struct MeetingPartialTests {
    @Test func unfinishedSpeechShowsAsAPartialThatTheSegmentClears() async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-partial-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let mic = try PcmWriter(url: dir.appendingPathComponent("mic.pcm"))
        // Speech with no pause yet: no window can be cut, so only a partial can show it.
        try mic.append((0..<3 * 16_000).map { 0.3 * sin(Float($0) * 2 * .pi * 440 / 16_000) })
        let job = MeetingTranscription(id: "m1", output: output, decode: { samples, _ in spokenWords("words \(samples.count / 16_000)", in: samples) },
                                       isDictating: { false }, idle: .milliseconds(5))
        job.update(dir: dir, baseMs: 0, fromMs: MeetingCursor(mic: 0, system: 0), language: .en)
        job.record(systemActive: false)
        let partial = try await lines.wait(for: "meeting.partial").first { $0["type"] as? String == "meeting.partial" }
        #expect(partial?["source"] as? String == "mic")
        #expect(partial?["text"] as? String == "words 3")
        #expect(lines.snapshot().allSatisfy { $0["type"] as? String != "meeting.segment" })

        try mic.append([Float](repeating: 0, count: 16_000))
        try mic.close()
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")
        let events = lines.snapshot().compactMap { $0["type"] as? String }.filter { $0 != "log" }
        let partials = lines.snapshot().filter { $0["type"] as? String == "meeting.partial" }.compactMap { $0["text"] as? String }
        #expect(partials.last == "")
        #expect(events.firstIndex(of: "meeting.segment").map { $0 < events.lastIndex(of: "meeting.partial")! } == true)
        #expect(lines.snapshot().contains { $0["type"] as? String == "meeting.segment" && $0["source"] as? String == "mic" })
    }
}
