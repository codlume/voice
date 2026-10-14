import Testing
@testable import VoiceHelperCore

private let rate = 16_000.0
private let quiet: Float = 0.00001
private let speech: Float = 0.05

private func span(_ chunks: [(seconds: Double, rms: Float)]) -> Double? {
    var span = SpeechSpan()
    for chunk in chunks {
        for _ in 0..<Int(chunk.seconds * 10) { span.add(frames: 1600, rms: chunk.rms) }
    }
    return span.milliseconds(sampleRate: rate)
}

@Test func trimsQuietEdgesAndKeepsInnerPauses() {
    let ms = span([(1, quiet), (1.5, speech), (2, quiet), (0.5, speech), (1, quiet)])
    #expect(ms == 4400.0)
}

@Test func speechAtTheEdgesClampsThePaddingToTheRecording() {
    #expect(span([(2, speech)]) == 2000)
    #expect(span([(0.1, quiet), (1, speech)]) == 1100)
}

@Test func silenceHasNoSpanAndSteadyNoiseKeepsTheWholeRecording() {
    #expect(span([(3, quiet)]) == nil)
    #expect(span([(3, 0.0005)]) == nil)
    #expect(span([(3, 0.01)]) == 3000)
    #expect(SpeechSpan().milliseconds(sampleRate: rate) == nil)
}

@Test func roomNoiseFarBelowThePeakIsTrimmed() {
    #expect(span([(1, 0.005), (1, 0.2), (1, 0.005)]) == 1400)
}

@Test func softSpeechWellBelowThePeakIsStillSpeech() {
    #expect(span([(1, quiet), (1, 0.003), (1, 0.08), (1, quiet)]) == 2400.0)
}

@Test func unevenChunksAreWeightedByTheirFrames() {
    var span = SpeechSpan()
    for _ in 0..<60 { span.add(frames: 80, rms: quiet) }
    span.add(frames: 1600, rms: speech)
    span.add(frames: 4800, rms: speech)
    span.add(frames: 8000, rms: quiet)
    #expect(span.milliseconds(sampleRate: rate) == 800.0)
}
