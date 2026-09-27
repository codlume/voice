import Testing
@testable import VoiceHelperCore

@Test func streamingRequiresAProcessableWindow() {
    var coverage = StreamingCoverage(chunkSamples: 176_000, minimumSamples: 208_000)
    let accepted = coverage.feed(207_999)
    #expect(accepted)
    coverage.completeWindow()
    coverage.completeWindow()
    #expect(!coverage.covers(207_999))
}

@Test(arguments: [(208_000, 2), (352_000, 2), (352_001, 3), (409_600, 3)])
func streamingRequiresEveryWindowIncludingTheFinalPartialWindow(samples: Int, expected: Int) {
    var coverage = StreamingCoverage(chunkSamples: 176_000, minimumSamples: 208_000)
    let accepted = coverage.feed(samples)
    #expect(accepted)
    for _ in 0..<expected {
        #expect(!coverage.covers(samples))
        coverage.completeWindow()
    }
    #expect(coverage.covers(samples))
    #expect(!coverage.covers(samples + 1))
    coverage.completeWindow()
    #expect(!coverage.covers(samples))
}

@Test func streamingBacklogIsBoundedAndSuccessfulWindowsMakeRoom() {
    var coverage = StreamingCoverage(chunkSamples: 176_000, minimumSamples: 208_000)
    let initial = coverage.feed(416_000)
    let overflow = coverage.feed(1)
    #expect(initial)
    #expect(!overflow)
    coverage.completeWindow()
    let resumed = coverage.feed(176_000)
    let overflowAgain = coverage.feed(1)
    #expect(resumed)
    #expect(!overflowAgain)
}

@Test func streamingCoverageUsesTheAdaptersWindowSizes() {
    var coverage = StreamingCoverage(chunkSamples: 4, minimumSamples: 6)
    let initial = coverage.feed(12)
    let overflow = coverage.feed(1)
    #expect(initial)
    #expect(!overflow)
    coverage.completeWindow()
    coverage.completeWindow()
    #expect(!coverage.covers(12))
    coverage.completeWindow()
    #expect(coverage.covers(12))
    let resumed = coverage.feed(4)
    #expect(resumed)
    #expect(!coverage.covers(16))
    coverage.completeWindow()
    #expect(coverage.covers(16))
}

@Test func captureReleaseDrainsQueuedTailInOrderAndCannotReopen() {
    let input = CaptureInput()
    #expect(input.enqueue([1, 2]))
    #expect(input.drain() == [[1, 2]])
    #expect(input.enqueue([3]))
    #expect(input.enqueue([4, 5]))
    #expect(input.drain(closing: true) == [[3], [4, 5]])
    #expect(!input.enqueue([6]))
    #expect(input.drain().isEmpty)
    #expect(!input.enqueue([7]))
    #expect(input.drain(closing: true).isEmpty)
}

@Test func cancelledCaptureCannotFeedTheNextSession() {
    let cancelled = CaptureInput()
    #expect(cancelled.enqueue([1]))
    _ = cancelled.drain(closing: true)
    let next = CaptureInput()
    #expect(next.enqueue([2]))
    #expect(!cancelled.enqueue([3]))
    #expect(cancelled.drain().isEmpty)
    #expect(next.drain(closing: true) == [[2]])
}
