import Testing
@testable import VoiceHelperCore

private let rate = 16_000.0
private let quiet: Float = 0.00001
private let speech: Float = 0.05

private final class Feed {
    var detector: PauseDetector
    private var fed = 0
    init(pauseSeconds: Double = 0.3) { detector = PauseDetector(sampleRate: rate, pauseSeconds: pauseSeconds) }
    func add(_ chunks: [(seconds: Double, rms: Float)]) -> [Int] {
        var pauses: [Int] = []
        for part in chunks {
            for _ in 0..<Int(part.seconds * 10) {
                fed += 1
                if detector.add(frames: 1600, rms: part.rms) { pauses.append(fed) }
            }
        }
        return pauses
    }
}

@Test func speechFollowedByAPauseReportsItOnce() {
    let feed = Feed()
    #expect(feed.add([(0.5, quiet), (1.5, speech), (0.2, quiet)]) == [])
    #expect(feed.detector.speechSinceLastPause)
    #expect(feed.add([(0.1, quiet)]) == [23])
    #expect(!feed.detector.speechSinceLastPause)
    #expect(feed.add([(2, quiet)]) == [])
}

@Test func silenceAloneIsNotAPause() {
    let feed = Feed()
    #expect(feed.add([(5, quiet)]) == [])
    #expect(!feed.detector.speechSinceLastPause)
}

@Test func speechAfterAPauseMakesTheEarlierDecodeStaleUntilTheNextPause() {
    let feed = Feed()
    #expect(feed.add([(1, speech), (0.3, quiet), (0.3, speech)]) == [13])
    #expect(feed.detector.speechSinceLastPause)
    #expect(feed.add([(0.3, quiet)]) == [19])
    #expect(!feed.detector.speechSinceLastPause)
}

@Test func aPauseShorterThanTheThresholdDoesNotCount() {
    let feed = Feed(pauseSeconds: 0.6)
    #expect(feed.add([(1, speech), (0.5, quiet), (1, speech), (0.5, quiet)]) == [])
    #expect(feed.detector.speechSinceLastPause)
}

@Test func roomNoiseFarBelowThePeakIsAPauseAndSoftSpeechIsNot() {
    let feed = Feed()
    #expect(feed.add([(1, 0.5), (0.3, 0.004)]) == [13])
    #expect(feed.add([(1, 0.5), (0.3, 0.006), (0.3, 0.004)]) == [29])
}

@Test func noiseAboveTheFloorBeforeAnySpeechCountsAsSpeechUntilSpeechRaisesThePeak() {
    let feed = Feed()
    #expect(feed.add([(0.5, 0.003), (0.3, quiet)]) == [8])
    #expect(feed.add([(1, 0.5), (0.3, 0.003)]) == [21])
}
