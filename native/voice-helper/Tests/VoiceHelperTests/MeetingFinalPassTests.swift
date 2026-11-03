import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

private struct Unavailable: Error {}

private func tone(_ seconds: Double, _ amplitude: Float, hz: Float = 440) -> [Float] {
    (0..<Int(seconds * 16_000)).map { amplitude * sin(Float($0) * 2 * .pi * hz / 16_000) }
}

private func silence(_ seconds: Double) -> [Float] { [Float](repeating: 0, count: Int(seconds * 16_000)) }

private func write(_ samples: [Float], _ source: MeetingSource, in dir: URL) throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let writer = try PcmWriter(url: source.file(in: dir))
    try writer.append(samples)
    try writer.close()
}

private func until(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while !condition() {
        guard ContinuousClock.now < deadline else { throw ProtocolError("the condition never held") }
        try await Task.sleep(for: .milliseconds(5))
    }
}

/// One word per sound the model is handed: "loud" for the user's voice, "soft" for anything
/// quieter, such as the other side through the speakers.
private func soundWords(in samples: [Float]) -> [TimedWord] {
    let frames = stride(from: 0, to: samples.count, by: 1600).map { samples[$0..<min($0 + 1600, samples.count)].map(abs).max() ?? 0 }
    var words: [TimedWord] = []
    var start: Int?
    for (index, peak) in (frames + [0]).enumerated() {
        if peak > 0.01, start == nil { start = index }
        guard peak <= 0.01, let first = start else { continue }
        let loud = frames[first..<index].contains { $0 > 0.2 }
        words.append(TimedWord(text: loud ? "loud" : "soft", startMs: Double(first) * 100, endMs: Double(index) * 100))
        start = nil
    }
    return words
}

/// `mic.pcm` and `system.pcm` with a loud tone on the mic, then two quieter system turns
/// `systemPause` seconds apart (under a second, one decode covers both), which the mic hears
/// through the speakers when `micHearsTheSpeakers`.
private func writeMeeting(in dir: URL, micHearsTheSpeakers: Bool = false, systemPause: Double = 0.9) throws {
    let theirs = silence(3) + tone(2, 0.1) + silence(systemPause) + tone(1.5, 0.1) + silence(0.5)
    let echo = micHearsTheSpeakers ? theirs.map { $0 / 4 } : silence(8)
    try write(zip(tone(2, 0.3, hz: 660) + silence(6), echo).map(+), .mic, in: dir)
    try write(theirs, .system, in: dir)
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

    @Test func theOtherSideHeardThroughTheSpeakersIsNotTranscribedAsTheUser() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeMeeting(in: dir, micHearsTheSpeakers: true)
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        await MeetingFinalPass(output: output, decode: { samples, _ in soundWords(in: samples) }, diarize: { _ in nil }, isDictating: { false })
            .run(id: "m1", dir: dir, baseMs: 0, language: .en)
        let mic = try await finalized().filter { $0["source"] as? String == "mic" }
        #expect(mic.map { $0["text"] as? String } == ["loud"], "only the user's voice is transcribed as theirs")
        #expect(mic.map { Int($0["endMs"] as? Double ?? -1) } == [2000])
    }

    @Test func aDictationThatStartsWhileTheGateRunsHoldsTheDecode() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeMeeting(in: dir, micHearsTheSpeakers: true)
        var dictating = false
        var looks = 0
        var decodes = 0
        var decodedWhileDictating = 0
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let finalPass = MeetingFinalPass(output: output, decode: { samples, _ in
            decodes += 1
            if dictating { decodedWhileDictating += 1 }
            return soundWords(in: samples)
        }, diarize: { _ in nil }, isDictating: {
            looks += 1
            // The pass's first look finds no dictation, and one starts right after it.
            if looks == 1 { dictating = true; return false }
            return dictating
        }, idle: .milliseconds(5))
        let run = Task { await finalPass.run(id: "m1", dir: dir, baseMs: 0, language: .en) }
        try await until { looks > 1 || decodes > 0 }
        dictating = false
        await run.value
        #expect(decodedWhileDictating == 0)
        #expect(try await finalized().map { $0["text"] as? String } == ["loud", "soft", "soft"])
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
        #expect(failed.last?["reason"] as? String == "transcript")
        #expect(failed.last?["message"] as? String == "speech model is not downloaded")
        #expect(lines.snapshot().allSatisfy { $0["type"] as? String != "meeting.finalized" })
    }

    @Test func speakersThatCouldNotBeToldApartFailThePassInsteadOfMergingIntoOneVoice() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeMeeting(in: dir)
        await pass(diarize: { _ in throw MeetingFinalizeError(reason: .speakerModels, message: "speaker detection is not downloaded") })
            .run(id: "m1", dir: dir, baseMs: 0, language: .en)
        let failed = try await lines.wait(for: "meeting.finalizeFailed")
        #expect(failed.last?["reason"] as? String == "speakerModels")
        #expect(lines.snapshot().allSatisfy { $0["type"] as? String != "meeting.finalized" })
    }

    @Test func eachRunOfSpeechIsDecodedOnItsOwnAndTheSilenceBetweenNeverReachesTheModel() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeMeeting(in: dir, systemPause: 3)
        var decoded: [Int] = []
        await pass(diarize: { _ in nil }, decoded: { decoded.append($0) }).run(id: "m1", dir: dir, baseMs: 0, language: .en)
        _ = try await finalized()
        #expect(decoded == [2 * 16_000, 2 * 16_000, Int(1.5 * 16_000)],
                "the user's tone, then each system turn on its own, without the three seconds between them")
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
    @Test func theOtherSideHeardThroughTheSpeakersShowsNoPartialAsTheUser() async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-partial-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let theirs = (0..<3 * 16_000).map { 0.1 * sin(Float($0) * 2 * .pi * 440 / 16_000) }
        for (name, samples) in [("system.pcm", theirs), ("mic.pcm", theirs.map { $0 / 4 })] {
            let writer = try PcmWriter(url: dir.appendingPathComponent(name))
            try writer.append(samples)
            try writer.close()
        }
        let job = MeetingTranscription(id: "m1", output: output, decode: { samples, _ in spokenWords("words", in: samples) },
                                       isDictating: { false }, idle: .milliseconds(5))
        defer { job.cancel() }
        job.update(dir: dir, baseMs: 0, fromMs: MeetingCursor(mic: 0, system: 0), language: .en)
        job.record([.mic, .system])
        let partial = try await lines.wait(for: "meeting.partial").first { $0["type"] as? String == "meeting.partial" }
        #expect(partial?["source"] as? String == "system")
        try await Task.sleep(for: .milliseconds(100))
        #expect(lines.snapshot().allSatisfy { $0["type"] as? String != "meeting.partial" || $0["source"] as? String == "system" })
    }

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
        job.record([.mic])
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

@MainActor
@Suite struct MeetingLiveGateTests {
    let lines = EmittedLines()
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-live-\(UUID().uuidString)")

    private func job(isDictating: @escaping () -> Bool = { false }, decoded: @escaping () -> Void = {}) -> MeetingTranscription {
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let job = MeetingTranscription(id: "m1", output: output, decode: { samples, _ in
            decoded()
            return spokenWords("words", in: samples)
        }, isDictating: isDictating, idle: .milliseconds(5))
        job.update(dir: dir, baseMs: 0, fromMs: MeetingCursor(mic: 0, system: 0), language: .en)
        return job
    }

    private func micEvents() -> [String] {
        lines.snapshot().filter { $0["source"] as? String == "mic" }.compactMap { $0["type"] as? String }
    }

    /// The system tap writes its file every 100 ms, so the mic file is routinely ahead of it.
    @Test(arguments: [0, 1600, 12_800])
    func theEchoShowsAsNeitherPartialNorSegmentWhileSystemAudioLagsTheMic(lagFrames: Int) async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = tone(3, 0.1)
        try write(Array(theirs.prefix(theirs.count - lagFrames)), .system, in: dir)
        try write(theirs.map { $0 / 4 } + silence(1), .mic, in: dir)
        let job = job()
        defer { job.cancel() }
        job.record([.mic, .system])
        _ = try await lines.wait(for: "meeting.partial")
        try await Task.sleep(for: .milliseconds(300))
        #expect(micEvents().isEmpty)
    }

    @Test func aLegWithoutSystemAudioAfterOneWithItKeepsTranscribingTheMic() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        // The first leg stopped mid-sentence; the second records no system audio.
        try write(silence(3), .system, in: dir)
        try write(tone(4, 0.3) + silence(1), .mic, in: dir)
        let job = job()
        defer { job.cancel() }
        job.record([.mic])
        let segment = try await lines.wait(for: "meeting.segment").first { $0["type"] as? String == "meeting.segment" }
        #expect(segment?["source"] as? String == "mic")
    }

    @Test(arguments: ["window", "partial"])
    func aDictationThatStartsWhileTheGateRunsHoldsTheDecode(shown: String) async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(tone(3, 0.1), .system, in: dir)
        // A pause after the speech ends a window; without one, only a partial can show it.
        try write(tone(3, 0.3, hz: 660) + (shown == "window" ? silence(1) : []), .mic, in: dir)
        var dictating = false
        var looks = 0
        var decodes = 0
        var decodedWhileDictating = 0
        let job = job(isDictating: {
            looks += 1
            // The loop's first look finds no dictation, and one starts right after it.
            if looks == 1 { dictating = true; return false }
            return dictating
        }, decoded: {
            decodes += 1
            if dictating { decodedWhileDictating += 1 }
        })
        defer { job.cancel() }
        if shown == "window" { job.drain() } else { job.record([.mic, .system]) }
        try await until { looks > 1 || decodes > 0 }
        dictating = false
        _ = try await lines.wait(for: shown == "window" ? "meeting.drained" : "meeting.partial")
        #expect(decodedWhileDictating == 0)
    }
}
