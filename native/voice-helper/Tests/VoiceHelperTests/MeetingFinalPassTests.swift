import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

private struct Unavailable: Error {}

private func tone(_ seconds: Double, _ amplitude: Float, hz: Float = 440) -> [Float] {
    (0..<Int(seconds * 16_000)).map { amplitude * sin(Float($0) * 2 * .pi * hz / 16_000) }
}

private func silence(_ seconds: Double) -> [Float] { [Float](repeating: 0, count: Int(seconds * 16_000)) }

/// The other side talking: noise in syllables, as broadband as a voice, so its echo shows the
/// lag the mic hears it at.
private func talk(_ seconds: Double, _ amplitude: Float = 0.3) -> [Float] {
    var state: UInt32 = 1
    return (0..<Int(seconds * 16_000)).map { n in
        state = state &* 1_664_525 &+ 1_013_904_223
        let syllable = max(0, sin(Float(n) * 2 * .pi * 3 / 16_000))
        return amplitude * syllable * (Float(state >> 8) / Float(1 << 23) - 1)
    }
}

/// What the mic hears of `played` through the speakers, `lagMs` later, over the room's hiss.
private func throughTheSpeakers(_ played: [Float], lagMs: Double) -> [Float] {
    var state: UInt32 = 7
    let late = silence(lagMs / 1000) + played
    return played.indices.map { n in
        state = state &* 1_664_525 &+ 1_013_904_223
        return late[n] / 4 + (Float(state >> 8) / Float(1 << 23) - 1) * 0.001
    }
}

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
        }, diarize: diarize, newDetector: { nil }, isDictating: dictating, idle: .milliseconds(5))
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
        await MeetingFinalPass(output: output, decode: { samples, _ in soundWords(in: samples) }, diarize: { _ in nil }, newDetector: { nil }, isDictating: { false })
            .run(id: "m1", dir: dir, baseMs: 0, language: .en)
        let mic = try await finalized().filter { $0["source"] as? String == "mic" }
        #expect(mic.map { $0["text"] as? String } == ["loud"], "only the user's voice is transcribed as theirs")
        #expect(mic.map { Int($0["endMs"] as? Double ?? -1) } == [2000])
    }

    /// The mic's lines as text@start, from a fake speech model that says "loud" for each sound.
    private func micLines(newDetector: @escaping MeetingTranscription.NewDetector) async throws -> [String] {
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        await MeetingFinalPass(output: output, decode: { samples, _ in soundWords(in: samples) }, diarize: { _ in nil },
                               newDetector: newDetector, isDictating: { false })
            .run(id: "m1", dir: dir, baseMs: 0, language: .en)
        return try await finalized().filter { $0["source"] as? String == "mic" }
            .map { "\($0["text"] as? String ?? "?")@\(Int($0["startMs"] as? Double ?? -1))" }
    }

    /// The user speaks for two seconds, and two seconds later something knocks.
    private let voiceThenKnock = tone(2, 0.3, hz: 660) + silence(2) + tone(0.3, 0.3, hz: 660) + silence(1.7)

    @Test func aSoundTheVoiceDetectorHearsNoVoiceInIsNotTranscribedAsTheUser() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(voiceThenKnock, .mic, in: dir)
        let mic = try await micLines(newDetector: { ScriptedDetector(voiced: [0..<32_000]) })
        #expect(mic == ["loud@0"])
    }

    @Test func withoutAVoiceDetectorEverySoundOnTheMicIsStillTranscribed() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(voiceThenKnock, .mic, in: dir)
        let mic = try await micLines(newDetector: { nil })
        #expect(mic == ["loud@0", "loud@4000"])
    }

    @Test func theVoiceDetectorHearsTheMicInOrderFromOneWindowToTheNext() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        // Two minutes with nothing after the user's words end the first window at 60.9 s, in
        // the middle of the silence. The knock comes a second after the two minutes.
        try write(tone(2, 0.3, hz: 660) + silence(119) + tone(0.3, 0.3, hz: 660) + silence(1), .mic, in: dir)
        // That is 60.1 s into the second window. A detector that started over there would
        // hear the knock where this one hears a voice.
        let detector = ScriptedDetector(voiced: [0..<32_000, 961_600..<966_400])
        let mic = try await micLines(newDetector: { detector })
        #expect(mic == ["loud@0"])
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
        }, diarize: { _ in nil }, newDetector: { nil }, isDictating: {
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
                                       newDetector: { nil }, isDictating: { false }, idle: .milliseconds(5))
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
                                       newDetector: { nil }, isDictating: { false }, idle: .milliseconds(5))
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

    /// A lag that just moved does not show in the newest 0.75 s, so what the gate left of
    /// them, where the other side played, waits.
    @Test func theUsersVoiceOverTheOtherSideShowsAsAPartialUpToTheNewestAudio() async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-partial-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        // Both talk on with no pause.
        let theirs = talk(7)
        try write(theirs, .system, in: dir)
        try write(zip(throughTheSpeakers(theirs, lagMs: 80), silence(1) + tone(6, 0.3, hz: 660)).map(+), .mic, in: dir)
        let job = MeetingTranscription(id: "m1", output: output, decode: { samples, _ in spokenWords("\(samples.count / 16) ms", in: samples) },
                                       newDetector: { nil }, isDictating: { false }, idle: .milliseconds(5))
        defer { job.cancel() }
        job.update(dir: dir, baseMs: 0, fromMs: MeetingCursor(mic: 0, system: 0), language: .en)
        job.record([.mic, .system])
        let mine = { lines.snapshot().filter { $0["type"] as? String == "meeting.partial" && $0["source"] as? String == "mic" } }
        try await until { !mine().isEmpty }
        #expect(mine().first?["text"] as? String == "6250 ms")
    }

    /// Main deletes a meeting's audio after its final pass and sends no cancel, so a later leg
    /// starts the files over under a new base and reaches the job the first leg used.
    @Test func aLegOnNewFilesAfterTheAudioWasDeletedShowsItsUnfinishedSpeech() async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-partial-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let job = MeetingTranscription(id: "m1", output: output, decode: { samples, _ in spokenWords("words \(samples.count / 16_000)", in: samples) },
                                       newDetector: { nil }, isDictating: { false }, idle: .milliseconds(5))
        defer { job.cancel() }
        let partials = { lines.snapshot().filter { $0["type"] as? String == "meeting.partial" }.compactMap { $0["text"] as? String } }

        try write(tone(10, 0.3), .mic, in: dir)
        job.update(dir: dir, baseMs: 0, fromMs: MeetingCursor(mic: 0, system: 0), language: .en)
        job.record([.mic])
        try await until { partials().contains("words 10") }
        try write(silence(1), .mic, in: dir)
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")

        try FileManager.default.removeItem(at: MeetingSource.mic.file(in: dir))
        try write(tone(3, 0.3), .mic, in: dir)
        job.update(dir: dir, baseMs: 60_000, fromMs: MeetingCursor(mic: 60_000, system: 60_000), language: .en)
        job.record([.mic])
        try? await until { partials().contains("words 3") }
        #expect(partials().last == "words 3", "the new leg's speech shows while it is still being said")
    }
}

@MainActor
@Suite struct MeetingLiveGateTests {
    let lines = EmittedLines()
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-live-\(UUID().uuidString)")

    private func job(
        newDetector: @escaping MeetingTranscription.NewDetector = { nil }, isDictating: @escaping () -> Bool = { false },
        decoded: @escaping () throws -> Void = {}
    ) -> MeetingTranscription {
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let job = MeetingTranscription(id: "m1", output: output, decode: { samples, _ in
            try decoded()
            return spokenWords("words", in: samples)
        }, newDetector: newDetector, isDictating: isDictating, idle: .milliseconds(5), retry: .milliseconds(5))
        job.update(dir: dir, baseMs: 0, fromMs: MeetingCursor(mic: 0, system: 0), language: .en)
        return job
    }

    private func micEvents() -> [String] {
        lines.snapshot().filter { $0["source"] as? String == "mic" }.compactMap { $0["type"] as? String }
    }

    /// The mic's segments as start-end in ms.
    private func micSegments() -> [String] {
        lines.snapshot().filter { $0["type"] as? String == "meeting.segment" && $0["source"] as? String == "mic" }
            .map { "\(Int($0["startMs"] as? Double ?? -1))-\(Int($0["endMs"] as? Double ?? -1))" }
    }

    /// The user speaks for two seconds, and two seconds later something knocks. The windows
    /// end at 2.3 s and 3.7 s, so the knock is 0.3 s into the third.
    private let voiceThenKnock = tone(2, 0.3, hz: 660) + silence(2) + tone(0.3, 0.3, hz: 660) + silence(1.5)
    /// A detector that started over at any window but the first would hear the knock where
    /// this one hears the user.
    private let hearsTheVoice = ScriptedDetector(voiced: [0..<32_000])

    @Test func aSoundTheVoiceDetectorHearsNoVoiceInShowsAsNoSegment() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(voiceThenKnock, .mic, in: dir)
        let job = job(newDetector: { hearsTheVoice })
        defer { job.cancel() }
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")
        #expect(micSegments() == ["0-2000"])
    }

    @Test func withoutAVoiceDetectorEverySoundOnTheMicStillShows() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(voiceThenKnock, .mic, in: dir)
        let job = job()
        defer { job.cancel() }
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")
        #expect(micSegments() == ["0-2000", "4000-4300"])
    }

    @Test func aSoundTheVoiceDetectorHearsNoVoiceInShowsAsNoPartial() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        // No pause follows the knock yet, so no window takes it and only a partial could show it.
        try write(silence(0.3) + tone(0.3, 0.3, hz: 660) + silence(0.5), .mic, in: dir)
        let hearsNoVoice = ScriptedDetector(voiced: [])
        let job = job(newDetector: { hearsNoVoice })
        defer { job.cancel() }
        job.record([.mic])
        try await until { hearsNoVoice.asked.withLock { $0 } > 0 || !micEvents().isEmpty }
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")
        #expect(micEvents() == [])
    }

    @Test func aPartialLeavesTheVoiceDetectorWhereTheWindowStarts() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let mic = try PcmWriter(url: MeetingSource.mic.file(in: dir))
        try mic.append(tone(3, 0.3, hz: 660))
        let job = job(newDetector: { ScriptedDetector(voiced: [0..<48_000]) })
        defer { job.cancel() }
        job.record([.mic])
        _ = try await lines.wait(for: "meeting.partial")
        // The window takes the same three seconds the partial showed. A detector the partial
        // had moved on would hear them as what comes after the user's words.
        try mic.append(silence(2) + tone(0.3, 0.3, hz: 660) + silence(1.5))
        try mic.close()
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")
        #expect(micSegments() == ["0-3000"])
    }

    @Test func aWindowDecodedAgainAfterAFailureIsHeardByTheSameVoiceDetector() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(voiceThenKnock, .mic, in: dir)
        var decodes = 0
        let job = job(newDetector: { hearsTheVoice }, decoded: {
            decodes += 1
            if decodes == 1 { throw TranscribeError(reason: .unknown, message: "the speech model stumbled") }
        })
        defer { job.cancel() }
        // While a leg records, a failed decode is tried again.
        job.record([.mic])
        try await until { !micSegments().isEmpty }
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")
        #expect(micSegments() == ["0-2000"])
        #expect(decodes == 2)
    }

    /// Main deletes a meeting's audio after its final pass, so a later leg starts the files
    /// over and reaches the job the first leg used.
    @Test func aLegOnNewFilesIsHeardByANewVoiceDetector() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(voiceThenKnock, .mic, in: dir)
        let job = job(newDetector: { hearsTheVoice })
        defer { job.cancel() }
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")

        try FileManager.default.removeItem(at: MeetingSource.mic.file(in: dir))
        try write(voiceThenKnock, .mic, in: dir)
        job.update(dir: dir, baseMs: 60_000, fromMs: MeetingCursor(mic: 60_000, system: 60_000), language: .en)
        job.drain()
        try await until { lines.snapshot().filter { $0["type"] as? String == "meeting.drained" }.count == 2 }
        #expect(micSegments() == ["0-2000", "60000-62000"])
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

    /// The sound goes to another output device 1.3 s before the mic's live window ends: the mic
    /// hears the other side 300 ms late where it heard them 80 ms late.
    @Test func anEchoWhoseLagJustMovedShowsAsNeitherPartialNorSegment() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = talk(9) + silence(0.7) + talk(6)
        let moveAt = Int(8.3 * 16_000)
        let mic = Array(throughTheSpeakers(theirs, lagMs: 80).prefix(moveAt)) + throughTheSpeakers(theirs, lagMs: 300).dropFirst(moveAt)
        // The files end in the other side's pause, which ends the mic's window at 9.6 s.
        let live = Int(9.9 * 16_000)
        try write(Array(theirs.prefix(live)), .system, in: dir)
        try write(Array(mic.prefix(live)), .mic, in: dir)
        var looks = 0
        let job = job(isDictating: {
            looks += 1
            return false
        })
        defer { job.cancel() }
        job.record([.mic, .system])
        // The loop looks for a dictation before every window, so four looks after the system
        // window the mic's has had its turn.
        try await until { lines.snapshot().contains { $0["type"] as? String == "meeting.segment" && $0["source"] as? String == "system" } }
        let seen = looks
        try await until { looks >= seen + 4 }

        try write(Array(theirs.dropFirst(live)), .system, in: dir)
        try write(Array(mic.dropFirst(live)), .mic, in: dir)
        job.drain()
        _ = try await lines.wait(for: "meeting.drained")
        #expect(micSegments() == [], "the user said nothing")
        #expect(micEvents() == [])
    }

    /// The echo's lag has not moved, so the gate already told the user's voice from the other side.
    @Test func anAnswerRightAfterTheOtherSideShowsWithoutWaiting() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        // The user answers 0.2 s after the other side's last sound, and the files end 0.7 s
        // after the answer.
        let theirs = talk(2.8) + silence(1.6)
        try write(theirs, .system, in: dir)
        try write(zip(throughTheSpeakers(theirs, lagMs: 80), silence(3) + tone(0.7, 0.3, hz: 660) + silence(0.7)).map(+), .mic, in: dir)
        var looks = 0
        let job = job(isDictating: {
            looks += 1
            return false
        })
        defer { job.cancel() }
        job.record([.mic, .system])
        try await until { lines.snapshot().contains { $0["type"] as? String == "meeting.segment" && $0["source"] as? String == "system" } }
        let seen = looks
        try await until { looks >= seen + 4 }
        #expect(micSegments() == ["3000-3700"])
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
