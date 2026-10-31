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

private func said(_ text: String, at startMs: Double, wordMs: Double = 300) -> [TimedWord] {
    text.split(separator: " ").enumerated().map { index, word in
        let start = startMs + Double(index) * wordMs
        return TimedWord(text: String(word), startMs: start, endMs: start + wordMs - 50)
    }
}

@Suite struct EchoPolicyTests {
    private let speakers = OutputTimeline()

    private func echoes(_ mic: [TimedWord], _ system: [TimedWord], output: OutputTimeline = OutputTimeline()) -> [String] {
        zip(mic, EchoPolicy.echoes(mic: mic, system: system, output: output)).filter(\.1).map(\.0.text)
    }

    @Test func wordsTheMicHearsAMomentAfterTheSpeakersPlayThemAreEcho() {
        let system = said("Let's ship the beta on Friday, okay?", at: 1000)
        #expect(echoes(said("Let's ship the beta on Friday.", at: 1060), system) == ["Let's", "ship", "the", "beta", "on", "Friday."])
        #expect(EchoPolicy.isEcho(said("Let's ship the beta on Friday.", at: 1060), system: system, output: speakers))
    }

    @Test func shortRepliesAlwaysStayTheUsers() {
        let system = said("Is that okay?", at: 3000)
        #expect(echoes(said("Okay.", at: 3600), system).isEmpty)
        #expect(!EchoPolicy.isEcho(said("Is that okay", at: 3050), system: system, output: speakers), "under four words")
    }

    @Test func repeatingTheOtherSideABeatLaterIsNotEcho() {
        let system = said("Maria by Friday and Victor owns legal review", at: 1000)
        #expect(echoes(said("Maria by Friday got it and Victor owns legal review", at: 3800), system).isEmpty)
        #expect(echoes(said("Yes that is okay with me", at: 1000), said("Is that okay with you", at: 0)).isEmpty)
    }

    @Test func wordsMustRepeatInOrderNotJustOverlap() {
        let system = said("send the report to Tom by Friday", at: 1000)
        #expect(echoes(said("Friday by Tom to report the send", at: 1000), system).count < EchoPolicy.minimumWords)
    }

    @Test func oneMisheardWordDoesNotSplitTheEcho() {
        let system = said("the beta build is ready for review", at: 1000)
        #expect(echoes(said("the beta bill is ready for review", at: 1050), system).count == 7)
    }

    @Test func theUsersInterjectionOverTheEchoStays() {
        // Crosstalk: the user talks over the other side; only the run that repeats the speakers goes.
        let system = said("legal review is with Victor until the twelfth", at: 1000)
        let mic = said("sorry who owns that", at: 100) + said("is with Victor until the twelfth", at: 1640)
        #expect(echoes(mic, system) == ["is", "with", "Victor", "until", "the", "twelfth"])
        #expect(!EchoPolicy.isEcho(mic, system: system, output: speakers), "a segment that mixes both stays whole")
    }

    @Test func withHeadphonesNothingIsEcho() {
        let system = said("we ship on friday after review", at: 1000)
        #expect(echoes(said("we ship on friday after review", at: 1040), system, output: OutputTimeline([(0, .headphones)])).isEmpty)
    }

    @Test func theOutputTimelineRoundTripsThroughItsFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-output-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(OutputTimeline.read(dir: dir, baseMs: 0) == OutputTimeline())
        try OutputTimeline.append(.headphones, atFrame: 0, dir: dir)
        try OutputTimeline.append(.speakers, atFrame: 32_000, dir: dir)
        let timeline = OutputTimeline.read(dir: dir, baseMs: 60_000)
        #expect(timeline == OutputTimeline([(60_000, .headphones), (62_000, .speakers)]))
        #expect(timeline.output(atMs: 1000) == .speakers, "before anything was recorded")
        #expect(timeline.output(atMs: 61_000) == .headphones)
        #expect(timeline.output(atMs: 70_000) == .speakers)
    }
}

@Suite struct EchoFilterTests {
    private func mic(_ start: Double, _ end: Double, _ text: String) -> TimedText {
        TimedText(source: .mic, startMs: start, endMs: end, text: text)
    }

    private func system(_ start: Double, _ end: Double, _ text: String) -> TimedText {
        TimedText(source: .system, startMs: start, endMs: end, text: text)
    }

    @Test func dropsMicTextThatEchoesSystemAudioOnceSystemPassesIt() {
        var filter = EchoFilter()
        filter.add(mic(1_050, 2_800, "Let's ship the beta on Friday."), words: said("Let's ship the beta on Friday.", at: 1_050))
        filter.add(system(1_000, 2_800, "Let's ship the beta on Friday, okay?"), words: said("Let's ship the beta on Friday, okay?", at: 1_000))
        #expect(filter.release(systemMs: 2_900, micMs: 3_000, output: OutputTimeline())
            == [system(1_000, 2_800, "Let's ship the beta on Friday, okay?")], "mic waits for system to pass it")
        #expect(filter.release(systemMs: 6_000, micMs: 6_000, output: OutputTimeline()).isEmpty)
        #expect(filter.takeDropped() == [mic(1_050, 2_800, "Let's ship the beta on Friday.")])
        #expect(filter.takeDropped().isEmpty)
    }

    @Test func theUsersLineWaitsOnlyBrieflyForTheOtherSide() {
        var filter = EchoFilter()
        filter.add(mic(0, 2_000, "Morning everyone, shall we start?"), words: said("Morning everyone, shall we start?", at: 0))
        #expect(filter.release(systemMs: 0, micMs: 4_000, output: OutputTimeline()).isEmpty)
        #expect(filter.release(systemMs: 0, micMs: 5_000, output: OutputTimeline()) == [mic(0, 2_000, "Morning everyone, shall we start?")])
    }

    @Test func withHeadphonesTheUsersLineShowsAtOnce() {
        var filter = EchoFilter()
        filter.add(mic(0, 2_000, "Morning everyone"), words: said("Morning everyone", at: 0))
        #expect(filter.release(systemMs: 0, micMs: 2_000, output: OutputTimeline([(0, .headphones)])) == [mic(0, 2_000, "Morning everyone")])
    }

    @Test func releasesEveryMicSegmentWhenNoSystemAudioIsComing() {
        var filter = EchoFilter()
        filter.add(mic(0, 2_000, "hello"), words: said("hello", at: 0))
        #expect(filter.release(systemMs: 0, micMs: 2_000, output: OutputTimeline()).isEmpty)
        #expect(filter.release(systemMs: .infinity, micMs: 2_000, output: OutputTimeline()) == [mic(0, 2_000, "hello")])
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
