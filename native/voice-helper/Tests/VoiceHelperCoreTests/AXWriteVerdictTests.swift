import Testing
@testable import VoiceHelperCore

private let helloWorld = AXTextState(value: "hello world", selection: AXTextRange(location: 6, length: 5))

@Test func aChangedValueIsInserted() {
    let after = AXTextState(value: "hello there", selection: AXTextRange(location: 11, length: 0))
    #expect(AXWriteVerdict(before: helloWorld, after: after) == .inserted)
}

@Test func dictatingTheSelectedTextCollapsesTheSelectionAndIsInserted() {
    let after = AXTextState(value: "hello world", selection: AXTextRange(location: 11, length: 0))
    #expect(AXWriteVerdict(before: helloWorld, after: after) == .inserted)
}

@Test func anObservableElementThatDidNotMoveIsUnchanged() {
    #expect(AXWriteVerdict(before: helloWorld, after: helloWorld) == .unchanged)
}

@Test func anUnreadableSelectionCannotProveANoOpSoTheWriteCounts() {
    let before = AXTextState(value: "hello world", selection: nil)
    #expect(AXWriteVerdict(before: before, after: before) == .inserted)
}

@Test func aValueThatBecomesUnreadableAfterTheWriteCounts() {
    let after = AXTextState(value: nil, selection: AXTextRange(location: 6, length: 5))
    #expect(AXWriteVerdict(before: helloWorld, after: after) == .inserted)
}
