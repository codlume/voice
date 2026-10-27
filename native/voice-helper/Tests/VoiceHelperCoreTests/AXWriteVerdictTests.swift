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
