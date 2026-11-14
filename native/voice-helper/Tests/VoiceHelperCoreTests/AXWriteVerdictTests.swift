import ApplicationServices
import Testing
@testable import VoiceHelperCore

private let helloWorld = AXTextState(length: 11, selection: AXTextRange(location: 6, length: 5))
private let caretAtEnd = AXTextState(length: 11, selection: AXTextRange(location: 11, length: 0))

@Test func aChangedLengthIsInserted() {
    let after = AXTextState(length: 17, selection: AXTextRange(location: 17, length: 0))
    #expect(AXWriteVerdict(before: helloWorld, after: after) == .inserted)
}

@Test func replacingTheSelectionWithTextOfTheSameLengthCollapsesItAndIsInserted() {
    #expect(AXWriteVerdict(before: helloWorld, after: caretAtEnd) == .inserted)
}

@Test func anObservableElementThatDidNotMoveIsUnchanged() {
    #expect(AXWriteVerdict(before: helloWorld, after: helloWorld) == .unchanged)
}

@Test func aCaretThatDidNotMoveInATextOfTheSameLengthIsUnchanged() {
    #expect(AXWriteVerdict(before: caretAtEnd, after: caretAtEnd) == .unchanged)
}

@Test func anUnreadableSelectionCannotProveANoOpSoTheWriteCounts() {
    let before = AXTextState(length: 11, selection: nil)
    #expect(AXWriteVerdict(before: before, after: before) == .inserted)
}

@Test func anUnreadableLengthCannotProveANoOpSoTheWriteCounts() {
    let before = AXTextState(length: nil, selection: AXTextRange(location: 6, length: 5))
    #expect(AXWriteVerdict(before: before, after: before) == .inserted)
}

@Test func aLengthThatBecomesUnreadableAfterTheWriteCounts() {
    let after = AXTextState(length: nil, selection: AXTextRange(location: 6, length: 5))
    #expect(AXWriteVerdict(before: helloWorld, after: after) == .inserted)
}

private let messagingTimeout = 0.3
private let ranOutTheTimeout = AXWriteAnswer(.cannotComplete, waited: 0.3, timeout: messagingTimeout)
private let unreadable = AXTextState(length: nil, selection: nil)
private let afterTheWrite = AXTextState(length: 17, selection: AXTextRange(location: 17, length: 0))

private func neverRead() -> AXTextState {
    Issue.record("the element was read again")
    return unreadable
}

@Test func aWriteThatRanOutItsTimeoutIsUnansweredNotRefused() {
    #expect(ranOutTheTimeout == .timedOut)
}

@Test func aFailureThatCameBackAtOnceIsARefusal() {
    #expect(AXWriteAnswer(.cannotComplete, waited: 0.002, timeout: messagingTimeout) == .refused)
    for error in [AXError.attributeUnsupported, .illegalArgument, .failure, .invalidUIElement] {
        #expect(AXWriteAnswer(error, waited: 0.3, timeout: messagingTimeout) == .refused)
    }
    #expect(AXWriteAnswer(.success, waited: 0.3, timeout: messagingTimeout) == .succeeded)
}

@Test func anUnansweredWriteIsNeverPastedBecauseTheAppCanStillApplyIt() {
    #expect(AXWritePlan(answer: ranOutTheTimeout, before: helloWorld, after: { helloWorld }) == .unknown)
    #expect(AXWritePlan(answer: ranOutTheTimeout, before: helloWorld, after: { unreadable }) == .unknown)
    #expect(AXWritePlan(answer: ranOutTheTimeout, before: unreadable, after: neverRead) == .unknown)
}

@Test func anUnansweredWriteSeenToLandIsInserted() {
    #expect(AXWritePlan(answer: ranOutTheTimeout, before: helloWorld, after: { afterTheWrite }) == .inserted(.late))
}

@Test func aRefusedWriteIsPastedWithoutReadingTheElementAgain() {
    #expect(AXWritePlan(answer: .refused, before: helloWorld, after: neverRead) == .paste(.writeFailed))
}

@Test func anAcceptedWriteIsInsertedOrReadAgainLaterBeforeAnyPaste() {
    #expect(AXWritePlan(answer: .succeeded, before: helloWorld, after: { afterTheWrite }) == .inserted(.direct))
    #expect(AXWritePlan(answer: .succeeded, before: helloWorld, after: { helloWorld }) == .reread)
}
