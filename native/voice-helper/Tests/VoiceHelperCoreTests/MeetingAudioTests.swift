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
        #expect(MeetingChunker.cut(tone(seconds: 1.5) + silence(seconds: 1), final: false) == nil)
        let cut = MeetingChunker.cut(tone(seconds: 3) + silence(seconds: 1) + tone(seconds: 1), final: false)
        #expect(cut == Int(3.3 * 16_000), "cuts in the middle of the first pause")
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

@Suite struct EchoFilterTests {
    private func mic(_ start: Double, _ end: Double, _ text: String) -> TimedText {
        TimedText(source: .mic, startMs: start, endMs: end, text: text)
    }

    private func system(_ start: Double, _ end: Double, _ text: String) -> TimedText {
        TimedText(source: .system, startMs: start, endMs: end, text: text)
    }

    @Test func dropsMicTextThatRepeatsWhatSystemAudioSaidAtTheSameTime() {
        var filter = EchoFilter()
        filter.add(mic(1_100, 4_200, "Let's ship the beta on Friday."))
        filter.add(system(1_000, 4_000, "Let's ship the beta on Friday, okay?"))
        filter.systemReached(4_000)
        #expect(filter.release() == [system(1_000, 4_000, "Let's ship the beta on Friday, okay?")], "mic waits for system to pass it")
        filter.systemReached(6_000)
        #expect(filter.release().isEmpty)
        #expect(filter.takeDropped() == [mic(1_100, 4_200, "Let's ship the beta on Friday.")])
        #expect(filter.takeDropped().isEmpty)
    }

    @Test func keepsTheUsersOwnWordsEvenWhenTheyOverlapSystemAudio() {
        var filter = EchoFilter()
        filter.add(system(1_000, 4_000, "Can you send the report?"))
        filter.add(mic(3_500, 6_000, "Yes, I will send it tonight after dinner."))
        filter.systemReached(10_000)
        #expect(filter.release() == [system(1_000, 4_000, "Can you send the report?"),
                                     mic(3_500, 6_000, "Yes, I will send it tonight after dinner.")])
    }

    @Test func comparesOnlyWithSystemTextAroundTheSameTime() {
        var filter = EchoFilter()
        filter.add(system(0, 3_000, "the quarterly numbers look good"))
        filter.add(mic(20_000, 23_000, "the quarterly numbers look good"))
        filter.systemReached(30_000)
        #expect(filter.release().map(\.source) == [.system, .mic])
    }

    @Test func releasesEveryMicSegmentWhenNoSystemAudioIsComing() {
        var filter = EchoFilter()
        filter.add(mic(0, 2_000, "hello"))
        #expect(filter.release().isEmpty)
        filter.systemReached(.infinity)
        #expect(filter.release() == [mic(0, 2_000, "hello")])
    }
}

@Suite struct MeetingWatchTests {
    @Test func aRevokedPermissionOrASilentMicrophoneEndsTheLeg() {
        let fine = MeetingWatch.loss(micAllowed: true, systemRecording: true, systemAllowed: true, msSinceMicAudio: 200)
        #expect(fine == nil)
        #expect(MeetingWatch.loss(micAllowed: false, systemRecording: true, systemAllowed: true, msSinceMicAudio: 200)
                == AudioLoss(source: .mic, reason: .permission))
        #expect(MeetingWatch.loss(micAllowed: true, systemRecording: true, systemAllowed: false, msSinceMicAudio: 200)
                == AudioLoss(source: .system, reason: .permission))
        #expect(MeetingWatch.loss(micAllowed: true, systemRecording: true, systemAllowed: true, msSinceMicAudio: 6000)
                == AudioLoss(source: .mic, reason: .device))
    }

    @Test func quietSystemAudioAMicReopeningAndAnUnrecordedSourceAreNotLosses() {
        #expect(MeetingWatch.loss(micAllowed: true, systemRecording: false, systemAllowed: false, msSinceMicAudio: 0) == nil)
        #expect(MeetingWatch.loss(micAllowed: true, systemRecording: true, systemAllowed: true, msSinceMicAudio: nil) == nil)
    }
}
