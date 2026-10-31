import Foundation
import Testing
@testable import VoiceHelperCore

private func said(_ text: String, at startMs: Double, wordMs: Double = 300) -> [TimedWord] {
    text.split(separator: " ").enumerated().map { index, word in
        let start = startMs + Double(index) * wordMs
        return TimedWord(text: String(word), startMs: start, endMs: start + wordMs - 50)
    }
}

@Suite struct FinalTranscriptTests {
    @Test func tokensJoinIntoWordsAtTheirLeadingSpace() {
        let words = FinalTranscript.words(
            tokens: [(" Zaż", 0, 100), ("ółć", 100, 200), (",", 200, 220), (" Ada", 400, 500), (" 42", 600, 700), (".", 700, 720)],
            offsetMs: 1000)
        #expect(words == [
            TimedWord(text: "Zażółć,", startMs: 1000, endMs: 1200),
            TimedWord(text: "Ada", startMs: 1400, endMs: 1500),
            TimedWord(text: "42.", startMs: 1600, endMs: 1700),
        ])
    }

    @Test func aBareSpaceTokenStartsTheNextWord() {
        let words = FinalTranscript.words(tokens: [(" fixed", 0, 200), (" ", 200, 240), ("4", 240, 300), ("2", 300, 360), (" bugs", 400, 600)],
                                          offsetMs: 0)
        #expect(words.map(\.text) == ["fixed", "42", "bugs"])
    }

    @Test func lateOrLongTokensDoNotBridgeTheSilenceAfterASentence() {
        // As Parakeet decodes a TTS meeting: the period comes 4 s after its word, a second one
        // later still, and a word token the model gave no duration ends at the next token.
        let tokens = [(" Friday", 0.0, 300.0), (".", 4000, 4080), (".", 5360, 5440), (" Per", 5440, 5700), ("fect", 5700, 9000),
                      (" Yes", 10_000, 10_300)]
        let words = FinalTranscript.words(tokens: tokens, offsetMs: 0)
        #expect(words.map(\.text) == ["Friday.", "Perfect", "Yes"])
        let segments = FinalTranscript.segments(mic: words, system: [], turns: nil)
        #expect(segments.map(\.text) == ["Friday.", "Perfect", "Yes"])
    }

    @Test func diarizedSystemVoicesNumberInTheOrderTheyFirstSpeak() {
        let system = said("Morning all", at: 1000) + said("Hi Ada", at: 2000) + said("Shall we start", at: 5000)
        // The diarizer's own names say nothing about order.
        let turns = [
            SpeakerTurn(speaker: "S7", startMs: 900, endMs: 1700),
            SpeakerTurn(speaker: "S2", startMs: 1900, endMs: 2700),
            SpeakerTurn(speaker: "S7", startMs: 4900, endMs: 6000),
        ]
        let segments = FinalTranscript.segments(mic: [], system: system, turns: turns)
        #expect(segments.map(\.text) == ["Morning all", "Hi Ada", "Shall we start"])
        #expect(segments.map(\.speaker) == [0, 1, 0])
        #expect(segments.allSatisfy { $0.source == .system })
    }

    @Test func aSpeakerChangeSplitsASegmentWithoutAPause() {
        let system = said("we ship friday", at: 0) + said("no monday", at: 900)
        let turns = [SpeakerTurn(speaker: "A", startMs: 0, endMs: 880), SpeakerTurn(speaker: "B", startMs: 880, endMs: 1600)]
        let segments = FinalTranscript.segments(mic: [], system: system, turns: turns)
        #expect(segments.map(\.text) == ["we ship friday", "no monday"])
        #expect(segments.map(\.speaker) == [0, 1])
    }

    @Test func aWordNoTurnCoversKeepsTheSpeakerBeforeIt() {
        // "two" is near the turn, "three" is too far from any and keeps the speaker before it.
        let system = said("one two three", at: 0, wordMs: 1200)
        let turns = [SpeakerTurn(speaker: "A", startMs: 0, endMs: 1000), SpeakerTurn(speaker: "B", startMs: 9000, endMs: 10_000)]
        let segments = FinalTranscript.segments(mic: [], system: system, turns: turns)
        #expect(segments.map(\.text) == ["one two three"])
        #expect(segments.map(\.speaker) == [0])
    }

    @Test func withoutDiarizationSystemAudioHasNoSpeaker() {
        let segments = FinalTranscript.segments(mic: said("hello there", at: 0), system: said("hi", at: 2000), turns: nil)
        #expect(segments.map(\.source) == [.mic, .system])
        #expect(segments.map(\.speaker) == [nil, nil])
    }

    @Test func micWordsThatEchoTheOtherSideAreDropped() {
        let system = said("we ship on friday after review", at: 1000)
        let mic = said("we ship on friday after review", at: 1100) + said("sounds good to me", at: 6000)
        let segments = FinalTranscript.segments(mic: mic, system: system, turns: [])
        #expect(segments.map(\.text) == ["we ship on friday after review", "sounds good to me"])
        #expect(segments.map(\.source) == [.system, .mic])
    }

    @Test func theUsersWordsStayWhenTheEchoFollowsThemWithoutAPause() {
        let system = said("the beta build is ready", at: 3000)
        let mic = said("morning everyone", at: 0) + said("yes the plan", at: 600) + said("the beta build is ready", at: 1500)
        let segments = FinalTranscript.segments(mic: mic, system: system, turns: nil)
        #expect(segments.filter { $0.source == .mic }.map(\.text) == ["morning everyone yes the plan"])
    }

    @Test func pausesAndLongRunsEndSegments() {
        let words = said("first part", at: 0) + said("after a pause", at: 2000)
        #expect(FinalTranscript.segments(mic: words, system: [], turns: nil).map(\.text) == ["first part", "after a pause"])
        // 40 s of words with no pause: the run ends at the first sentence end past 30 s.
        let long = (0..<100).map { TimedWord(text: $0 == 79 ? "end." : "word", startMs: Double($0) * 400, endMs: Double($0) * 400 + 350) }
        let split = FinalTranscript.segments(mic: long, system: [], turns: nil)
        #expect(split.count == 2)
        #expect(split[0].text.hasSuffix("end."))
    }
}

@Suite struct FinalChunkerTests {
    private func tone(seconds: Double) -> [Float] {
        (0..<Int(seconds * 16_000)).map { 0.3 * sin(Float($0) * 2 * .pi * 440 / 16_000) }
    }

    private func silence(seconds: Double) -> [Float] {
        [Float](repeating: 0, count: Int(seconds * 16_000))
    }

    @Test func aShortRestIsOneWindow() {
        let samples = tone(seconds: 50)
        #expect(MeetingChunker.finalCut(samples) == samples.count)
    }

    @Test func aFullWindowEndsInItsLastPause() {
        let samples = tone(seconds: 80) + silence(seconds: 1) + tone(seconds: 39) + silence(seconds: 1)
        let cut = MeetingChunker.finalCut(Array(samples.prefix(MeetingChunker.finalWindowSamples)))
        #expect((80 * 16_000..<81 * 16_000).contains(cut))
    }
}
