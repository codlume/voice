import Foundation
import Testing
@testable import VoiceHelperCore

private func scratchFile() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("voice-pcm-\(UUID().uuidString).pcm")
}

private func tone(seconds: Double, amplitude: Float = 0.3) -> [Float] {
    (0..<Int(seconds * 16_000)).map { amplitude * sin(Float($0) * 2 * .pi * 440 / 16_000) }
}

private func silence(seconds: Double) -> [Float] {
    [Float](repeating: 0, count: Int(seconds * 16_000))
}

@Suite struct PcmFileTests {
    @Test func appendsAcrossReopensAndReadsBackAtFrameOffsets() throws {
        let url = scratchFile()
        defer { try? FileManager.default.removeItem(at: url) }
        let first = try PcmWriter(url: url)
        try first.append([0.5, -0.5, 1, -1])
        try first.close()
        let second = try PcmWriter(url: url)
        #expect(second.frames == 4)
        try second.append([0.25, 2])
        try second.close()

        #expect(PcmFile.frames(at: url) == 6)
        let samples = try PcmFile.read(at: url, offset: 2, count: 10)
        #expect(samples.count == 4)
        #expect(abs(samples[0] - 1) < 0.001)
        #expect(abs(samples[1] + 1) < 0.001)
        #expect(abs(samples[2] - 0.25) < 0.001)
        #expect(abs(samples[3] - 1) < 0.001, "out-of-range samples clip")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect(attributes[.posixPermissions] as? Int == 0o600)
    }

    @Test func dropsTheHalfFrameACrashLeftSoLaterAudioStaysAligned() throws {
        let url = scratchFile()
        defer { try? FileManager.default.removeItem(at: url) }
        try Data([0x00, 0x40, 0x7F]).write(to: url)
        let writer = try PcmWriter(url: url)
        #expect(writer.frames == 1)
        try writer.append([-0.5])
        try writer.close()
        let samples = try PcmFile.read(at: url, offset: 0, count: 4)
        #expect(samples.count == 2)
        #expect(abs(samples[1] + 0.5) < 0.001)
    }

    @Test func padsWithSilenceUpToATargetAndNeverShortens() throws {
        let url = scratchFile()
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = try PcmWriter(url: url)
        try writer.append([0.5, 0.5])
        try writer.pad(to: 5)
        try writer.pad(to: 3)
        try writer.close()
        #expect(try PcmFile.read(at: url, offset: 0, count: 10).map { $0 == 0 } == [false, false, true, true, true])
    }

    @Test func convertsBetweenFramesAndMilliseconds() {
        #expect(PcmFile.milliseconds(16_000) == 1000)
        #expect(PcmFile.frames(milliseconds: 1250.5) == 20_008)
        #expect(PcmFile.frames(at: scratchFile()) == 0)
    }
}

@Suite struct MeetingChunkerTests {
    @Test func waitsForMoreAudioUntilAPauseFollowsTwoSecondsOfSpeech() {
        #expect(MeetingChunker.cut(tone(seconds: 1.5) + silence(seconds: 0.8), final: false) == nil)
        let cut = MeetingChunker.cut(tone(seconds: 3) + silence(seconds: 1) + tone(seconds: 1), final: false)
        #expect(cut == Int(3.3 * 16_000), "cuts in the middle of the first pause")
    }

    @Test func aShortReplyEndsItsWindowOnceASecondOfSilenceFollows() {
        // "Yes." right after a cut: its pause starts before the two-second minimum.
        let reply = tone(seconds: 0.8) + silence(seconds: 1)
        #expect(MeetingChunker.cut(reply, final: false) == Int(1.3 * 16_000))
        #expect(MeetingChunker.cut(reply + silence(seconds: 5), final: false) == Int(1.3 * 16_000), "a pause that keeps growing still cuts")
    }

    @Test func aPauseThatStartsEarlyCutsBeforeTheNextTurnInsteadOfInsideIt() {
        let cut = MeetingChunker.cut(tone(seconds: 1.8) + silence(seconds: 3) + tone(seconds: 12), final: false)
        #expect(cut.map { (18 * 1600..<48 * 1600).contains($0) } == true, "\(String(describing: cut))")
    }

    @Test func leadingSilenceIsTakenAtOnceAndLeavesALeadInBeforeSpeech() {
        #expect(MeetingChunker.cut(silence(seconds: 0.5), final: false) == nil)
        #expect(MeetingChunker.cut(silence(seconds: 5), final: false) == Int(4.7 * 16_000))
        #expect(MeetingChunker.cut(silence(seconds: 2) + tone(seconds: 1), final: false) == Int(1.7 * 16_000))
        #expect(MeetingChunker.cut(silence(seconds: 2), final: true) == 2 * 16_000)
    }

    @Test func cutsALongStretchWithoutPausesAtItsQuietestMomentBeforeFifteenSeconds() throws {
        var samples = tone(seconds: 16)
        let quiet = Int(12.2 * 16_000)
        for index in quiet..<quiet + 1600 { samples[index] *= 0.1 }
        let cut = try #require(MeetingChunker.cut(samples, final: false))
        #expect(cut == quiet)
        #expect(cut <= MeetingChunker.windowSamples)
    }

    @Test func takesTheRestWhenNoMoreAudioFollows() {
        #expect(MeetingChunker.cut(tone(seconds: 1), final: true) == 16_000)
        #expect(MeetingChunker.cut([], final: true) == nil)
    }

    @Test func findsTheSpeechInAWindowAndSkipsSilence() {
        #expect(MeetingChunker.speech(in: silence(seconds: 3)) == nil)
        let speech = MeetingChunker.speech(in: silence(seconds: 1) + tone(seconds: 2) + silence(seconds: 1))
        #expect(speech == 16_000..<48_000)
    }
}

@Suite struct MeetingWatchTests {
    private func check(mic: Bool = true, system: Bool = true, micMs: Double? = 200, systemMs: Double? = 200) -> MeetingWatch.Finding? {
        MeetingWatch.check(micAllowed: mic, systemAllowed: system, msSinceMicAudio: micMs, msSinceSystemAudio: systemMs)
    }

    @Test func aRevokedPermissionOrASilentMicrophoneEndsTheLeg() {
        #expect(check() == nil)
        #expect(check(mic: false) == .lost(AudioLoss(source: .mic, reason: .permission)))
        #expect(check(system: false) == .lost(AudioLoss(source: .system, reason: .permission)))
        #expect(check(micMs: 6000) == .lost(AudioLoss(source: .mic, reason: .device)))
    }

    @Test func aTapThatStopsDeliveringFramesHasStalled() {
        #expect(check(systemMs: 2000) == nil)
        #expect(check(systemMs: 3500) == .systemStalled)
    }

    @Test func aMicReopeningAndAnUnrecordedSourceAreNotLosses() {
        #expect(check(system: false, micMs: 0, systemMs: nil) == nil)
        #expect(check(micMs: nil) == nil)
    }
}

@MainActor
@Suite struct MeetingSourceHeardTests {
    @Test func theModelHearsSystemAudioAsRecordedAndTheMicWithoutTheEcho() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-heard-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let theirs = silence(seconds: 1) + tone(seconds: 2, amplitude: 0.1)
        for (source, samples) in [(MeetingSource.system, theirs), (.mic, theirs.map { $0 / 4 })] {
            let writer = try PcmWriter(url: source.file(in: dir))
            try writer.append(samples)
            try writer.close()
        }
        let system = try await MeetingSource.system.heard(in: dir, offset: 8000, count: 32_000)
        #expect(system == (try PcmFile.read(at: MeetingSource.system.file(in: dir), offset: 8000, count: 32_000)))
        let mic = try await MeetingSource.mic.heard(in: dir, offset: 8000, count: 32_000)
        #expect(mic.count == 32_000)
        #expect(MeetingChunker.speech(in: mic) == nil, "the echo is gated out")
    }

    @Test func aMicWithNoSystemAudioIsHeardAsRecorded() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-heard-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let writer = try PcmWriter(url: MeetingSource.mic.file(in: dir))
        try writer.append(tone(seconds: 1))
        try writer.close()
        let mic = try await MeetingSource.mic.heard(in: dir, offset: 0, count: 16_000)
        #expect(mic == (try PcmFile.read(at: MeetingSource.mic.file(in: dir), offset: 0, count: 16_000)))
    }
}
