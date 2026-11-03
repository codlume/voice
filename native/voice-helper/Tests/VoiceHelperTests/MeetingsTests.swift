import AVFoundation
import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

private typealias Tone = (hz: Float, amplitude: Float)
/// The user's voice: louder than the other side's, so a fake decoder can tell the sources apart,
/// and at another pitch, as two voices are.
private let mine: Tone = (660, 0.3)
private let theirs: Tone = (440, 0.1)
/// The other side as the laptop's mic hears it through the speakers.
private let theirEcho: Tone = (440, 0.025)

/// Each span's tone, or silence for nil. A tone fades in and out over 10 ms, as a voice does,
/// rather than with a click.
private func writeTone(to url: URL, segments: [(seconds: Double, tone: Tone?)]) throws {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
    let frames = AVAudioFrameCount(segments.reduce(0) { $0 + $1.seconds } * 16_000)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    let channel = try #require(buffer.floatChannelData?[0])
    var offset = 0
    for segment in segments {
        let count = Int(segment.seconds * 16_000)
        for i in 0..<count {
            let fade = min(1, Float(min(i, count - i)) / 160)
            channel[offset + i] = segment.tone.map { fade * $0.amplitude * sin(Float(offset + i) * 2 * .pi * $0.hz / 16_000) } ?? 0
        }
        offset += Int(segment.seconds * 16_000)
    }
    try AVAudioFile(forWriting: url, settings: format.settings).write(from: buffer)
}


@MainActor
private final class Harness {
    let lines = EmittedLines()
    let output: Output
    let devices: AudioInputDevices
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("voice-meetings-\(UUID().uuidString)")
    var dictating = false
    var capturingDictation = false
    var decodes = 0
    var meetings: Meetings!

    /// `micHearsTheSpeakers`: the user is quiet while the other side talks, and the mic hears them.
    init(system: Bool = true, speed: Double = 16, micHearsTheSpeakers: Bool = false) throws {
        output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        devices = AudioInputDevices(output: output)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let mic = root.appendingPathComponent("mic.wav")
        try writeTone(to: mic, segments: [(2.5, mine), (1, nil), (2.5, micHearsTheSpeakers ? theirEcho : mine), (1, nil)])
        let systemPath = root.appendingPathComponent("system.wav")
        try writeTone(to: systemPath, segments: [(3.5, nil), (2.5, theirs), (1, nil)])
        meetings = Meetings(
            output: output, devices: devices,
            source: .fixture(mic: mic.path, system: system ? systemPath.path : "", speed: speed),
            decode: { [unowned self] samples, _ in
                decodes += 1
                let peak = samples.map(abs).max() ?? 0
                return spokenWords(peak > 0.2 ? "mine \(decodes)" : "theirs \(decodes)", in: samples)
            },
            finalPass: MeetingFinalPass(output: output, decode: { _, _ in [] }, diarize: { _ in nil }, isDictating: { false }),
            isDictating: { [unowned self] in dictating }, isCapturingDictation: { [unowned self] in capturingDictation })
    }

    var dir: URL { root.appendingPathComponent("m1") }

    func start(baseMs: Double = 0, from: MeetingCursor = MeetingCursor(mic: 0, system: 0)) {
        meetings.start(id: "m1", dir: dir.path, baseMs: baseMs, fromMs: from, language: .en, microphone: nil)
    }

    func events(_ type: String) -> [[String: Any]] {
        lines.snapshot().filter { $0["type"] as? String == type }
    }

    /// Segments in meeting order as source@start-end.
    func segments() -> [String] {
        events("meeting.segment").map { segment in
            let ms = { (key: String) in Int(segment[key] as? Double ?? -1) }
            return "\(segment["source"] as? String ?? "?")@\(ms("startMs"))-\(ms("endMs"))"
        }.sorted { $0.split(separator: "@")[1].localizedStandardCompare($1.split(separator: "@")[1]) == .orderedAscending }
    }

    func waitForFixtures(count: Int) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            let ended = lines.snapshot().filter { ($0["message"] as? String)?.hasPrefix("meeting fixture ended") == true }
            if ended.count >= count { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw ProtocolError("fixtures did not finish")
    }

    func waitForDrained(count: Int = 1) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if events("meeting.drained").count >= count { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw ProtocolError("no meeting.drained")
    }

    func frames(_ name: String) -> Int {
        PcmFile.frames(at: dir.appendingPathComponent(name))
    }

    deinit {
        try? FileManager.default.removeItem(at: root)
    }
}

@Suite(.serialized)
@MainActor
struct MeetingsTests {
    @Test func recordsBothSourcesToAlignedFilesAndTranscribesThemIntoSegments() async throws {
        let h = try Harness()
        defer { h.meetings.shutdown(); h.devices.shutdown() }
        h.start()
        _ = try await h.lines.wait(for: "meeting.started")
        let started = try #require(h.events("meeting.started").first)
        #expect(started["mic"] as? String == "active")
        #expect(started["system"] as? String == "active")
        try await h.waitForFixtures(count: 2)
        h.meetings.stop(id: "m1")
        try await h.waitForDrained()

        #expect(abs(h.frames("mic.pcm") - 7 * 16_000) < 1600, "the whole fixture, give or take the resampler's tail")
        #expect(h.frames("system.pcm") == h.frames("mic.pcm"), "stop pads both files to one timeline")
        #expect(Set(h.segments()) == ["mic@0-2500", "mic@3500-6000", "system@3500-6000"])
    }

    @Test func resumeAppendsToTheSameFilesAndContinuesTheTimeline() async throws {
        let h = try Harness()
        defer { h.meetings.shutdown(); h.devices.shutdown() }
        h.start()
        try await h.waitForFixtures(count: 2)
        h.meetings.stop(id: "m1")
        try await h.waitForDrained()
        let firstLeg = try Data(contentsOf: h.dir.appendingPathComponent("mic.pcm"))

        h.start()
        try await h.waitForFixtures(count: 4)
        h.meetings.stop(id: "m1")
        try await h.waitForDrained(count: 2)

        let both = try Data(contentsOf: h.dir.appendingPathComponent("mic.pcm"))
        #expect(both.count == firstLeg.count * 2)
        #expect(both.prefix(firstLeg.count) == firstLeg, "the first leg's audio is never rewritten")
        let leg = Int(PcmFile.milliseconds(firstLeg.count / 2))
        #expect(h.segments().filter { $0.hasPrefix("mic") }
            == ["mic@0-2500", "mic@3500-6000", "mic@\(leg)-\(leg + 2500)", "mic@\(leg + 3500)-\(leg + 6000)"])
    }

    @Test func micOnlyMeetingsReportSystemAudioUnavailableAndStillTranscribe() async throws {
        let h = try Harness(system: false)
        defer { h.meetings.shutdown(); h.devices.shutdown() }
        h.start()
        _ = try await h.lines.wait(for: "meeting.started")
        #expect(h.events("meeting.started").first?["system"] as? String == "unavailable")
        try await h.waitForFixtures(count: 1)
        h.meetings.stop(id: "m1")
        try await h.waitForDrained()
        #expect(!FileManager.default.fileExists(atPath: h.dir.appendingPathComponent("system.pcm").path))
        #expect(h.events("meeting.segment").map { $0["source"] as? String } == ["mic", "mic"])
    }

    @Test func theOtherSideHeardThroughTheSpeakersNeverReachesTheSpeechModelAsTheUser() async throws {
        let h = try Harness(micHearsTheSpeakers: true)
        defer { h.meetings.shutdown(); h.devices.shutdown() }
        h.start()
        try await h.waitForFixtures(count: 2)
        h.meetings.stop(id: "m1")
        try await h.waitForDrained()
        #expect(h.segments() == ["mic@0-2500", "system@3500-6000"])
    }

    @Test func dictationSilencesTheMeetingMicAndHoldsMeetingDecodes() async throws {
        let h = try Harness()
        defer { h.meetings.shutdown(); h.devices.shutdown() }
        h.dictating = true
        h.capturingDictation = true
        h.start()
        try await h.waitForFixtures(count: 2)
        h.meetings.stop(id: "m1")
        try await Task.sleep(for: .milliseconds(500))
        #expect(h.decodes == 0, "no meeting decode starts while a dictation runs")
        #expect(h.events("meeting.drained").isEmpty)
        let mic = try PcmFile.read(at: h.dir.appendingPathComponent("mic.pcm"), offset: 0, count: 7 * 16_000)
        #expect(mic.allSatisfy { $0 == 0 }, "dictated words never reach the meeting audio")

        h.dictating = false
        h.capturingDictation = false
        try await h.waitForDrained()
        #expect(h.events("meeting.segment").map { $0["source"] as? String } == ["system"])
    }

    @Test func aDictationBeingTranscribedKeepsTheMeetingMicButStillHoldsMeetingDecodes() async throws {
        let h = try Harness()
        defer { h.meetings.shutdown(); h.devices.shutdown() }
        h.dictating = true
        h.start()
        try await h.waitForFixtures(count: 2)
        h.meetings.stop(id: "m1")
        try await Task.sleep(for: .milliseconds(500))
        #expect(h.decodes == 0, "the dictation's decode keeps the speech model")
        let mic = try PcmFile.read(at: h.dir.appendingPathComponent("mic.pcm"), offset: 0, count: 7 * 16_000)
        #expect(mic.contains { $0 != 0 }, "after the key is released, the user speaks to the meeting again")

        h.dictating = false
        try await h.waitForDrained()
        #expect(Set(h.segments()) == ["mic@0-2500", "mic@3500-6000", "system@3500-6000"])
    }

    @Test func aGateThatCannotReadTheSystemAudioNeverHandsTheModelTheUngatedMic() async throws {
        let h = try Harness(micHearsTheSpeakers: true)
        defer { h.meetings.shutdown(); h.devices.shutdown() }
        h.start()
        try await h.waitForFixtures(count: 2)
        h.meetings.cancel(id: "m1")
        let system = h.dir.appendingPathComponent("system.pcm")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: system.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: system.path) }

        let fresh = try Harness()
        defer { fresh.meetings.shutdown(); fresh.devices.shutdown() }
        fresh.meetings.transcribe(id: "m1", dir: h.dir.path, baseMs: 0, fromMs: MeetingCursor(mic: 0, system: 0), language: .en)
        try await fresh.waitForDrained()
        #expect(fresh.events("meeting.drained").first?["failure"] as? String != nil)
        #expect(fresh.events("meeting.segment").filter { $0["source"] as? String == "mic" }.isEmpty,
                "the mic waits for the gate; it never reaches the model with the other side's echo in it")
    }

    @Test func recoveryTranscribesOnlyWhatTheTranscriptDoesNotReachWithoutRecording() async throws {
        let h = try Harness()
        defer { h.meetings.shutdown(); h.devices.shutdown() }
        h.start()
        try await h.waitForFixtures(count: 2)
        h.meetings.cancel(id: "m1")
        let recorded = h.frames("mic.pcm")

        let fresh = try Harness()
        defer { fresh.meetings.shutdown(); fresh.devices.shutdown() }
        fresh.meetings.transcribe(id: "m1", dir: h.dir.path, baseMs: 0, fromMs: MeetingCursor(mic: 3000, system: 0), language: .en)
        try await fresh.waitForDrained()
        #expect(fresh.events("meeting.started").isEmpty, "recovery never records")
        #expect(h.frames("mic.pcm") == recorded)
        let mic = fresh.events("meeting.segment").filter { $0["source"] as? String == "mic" }
        #expect(mic.compactMap { $0["startMs"] as? Double } == [3500])
    }

    @Test func testModeWithoutAFixtureRefusesToRecord() throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let devices = AudioInputDevices(output: output)
        defer { devices.shutdown() }
        let finalPass = MeetingFinalPass(output: output, decode: { _, _ in [] }, diarize: { _ in nil }, isDictating: { false })
        let meetings = Meetings(output: output, devices: devices, source: .disabled, decode: { _, _ in [] }, finalPass: finalPass,
                                isDictating: { false }, isCapturingDictation: { false })
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-meetings-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        meetings.start(id: "m1", dir: dir.path, baseMs: 0, fromMs: MeetingCursor(mic: 0, system: 0), language: .en, microphone: nil)
        #expect(MeetingAudioSource.resolve(environment: ["VOICE_HELPER_TEST": "1"]) == .disabled)
        #expect(MeetingAudioSource.resolve(environment: ["VOICE_HELPER_TEST_MEETING_MIC": "/m.wav"]) == .live)
        #expect(MeetingAudioSource.resolve(environment: ["VOICE_HELPER_TEST": "1", "VOICE_HELPER_TEST_MEETING_MIC": "/m.wav",
                                                         "VOICE_HELPER_TEST_MEETING_SPEED": "8"]) == .fixture(mic: "/m.wav", system: "", speed: 8))
    }
}
