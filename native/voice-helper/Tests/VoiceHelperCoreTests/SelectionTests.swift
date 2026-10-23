import Testing
@testable import VoiceHelperCore

private let range = AXTextRange(location: 4, length: 9)
private let synthetic = "Synthetic selection"
private let optionBit: UInt64 = 0x8_0000
private let commandBit: UInt64 = 0x10_0000
private let fnBit: UInt64 = 0x80_0000

@Test func axTextIsReadThroughAccessibilityAndKeepsTextAndRange() {
    #expect(planRead(secureInput: false, answer: .text(synthetic, range: range))
        == .selected(text: synthetic, origin: .accessibility(text: synthetic, range: range)))
    #expect(planRead(secureInput: false, answer: .text(synthetic, range: nil))
        == .selected(text: synthetic, origin: .accessibility(text: synthetic, range: nil)))
}

@Test func anExplicitEmptyRangeIsNoSelectionWithoutACopy() {
    #expect(planRead(secureInput: false, answer: .emptyRange) == .fail(.noSelection))
}

@Test func whitespaceOnlyTextIsNoSelection() {
    #expect(planRead(secureInput: false, answer: .text(" \n\t", range: range)) == .fail(.noSelection))
    #expect(planRead(secureInput: false, answer: .text("", range: nil)) == .fail(.noSelection))
}

@Test func onlySilenceFallsBackToCopy() {
    #expect(planRead(secureInput: false, answer: .noAnswer) == .copyFallback)
}

@Test func secureInputAndSecureFieldsRefuseBeforeAnyRead() {
    #expect(planRead(secureInput: true, answer: .noAnswer) == .fail(.secureInput))
    #expect(planRead(secureInput: true, answer: .text(synthetic, range: range)) == .fail(.secureInput))
    #expect(planRead(secureInput: false, answer: .secureField) == .fail(.secureInput))
}

@Test func accessibilityOriginProceedsOnlyWhenTextAndRangeStillMatch() {
    let origin = SelectionOrigin.accessibility(text: synthetic, range: range)
    #expect(writeVerdict(origin: origin, currentAX: .text(synthetic, range: range), currentStamp: []) == .proceed)
    #expect(writeVerdict(origin: origin, currentAX: .text(synthetic, range: AXTextRange(location: 5, length: 9)), currentStamp: [])
        == .refuseSelectionChanged)
    #expect(writeVerdict(origin: origin, currentAX: .text("Synthetic", range: range), currentStamp: []) == .refuseSelectionChanged)
    #expect(writeVerdict(origin: origin, currentAX: .emptyRange, currentStamp: []) == .refuseSelectionChanged)
    #expect(writeVerdict(origin: origin, currentAX: .noAnswer, currentStamp: []) == .refuseSelectionChanged)
    #expect(writeVerdict(origin: origin, currentAX: nil, currentStamp: []) == .refuseSelectionChanged)
}

@Test func copyOriginProceedsOnlyWhileNoPressHappenedSinceTheRead() {
    let origin = SelectionOrigin.copy(inputStamp: [10, 2, 0, 0])
    #expect(writeVerdict(origin: origin, currentAX: nil, currentStamp: [10, 2, 0, 0]) == .proceed)
    #expect(writeVerdict(origin: origin, currentAX: nil, currentStamp: [11, 2, 0, 0]) == .refuseSelectionChanged)
    #expect(writeVerdict(origin: origin, currentAX: nil, currentStamp: [10, 3, 0, 0]) == .refuseSelectionChanged)
    #expect(writeVerdict(origin: origin, currentAX: .text(synthetic, range: range), currentStamp: [10, 2, 0, 0]) == .proceed)
}

@Test func releaseWaitsForTheKeyAndEveryModifier() {
    #expect(ReleaseWait.step(flags: optionBit, keyDown: true, elapsed: 0) == .wait)
    #expect(ReleaseWait.step(flags: optionBit, keyDown: false, elapsed: 0.2) == .wait)
    #expect(ReleaseWait.step(flags: 0, keyDown: true, elapsed: 0.2) == .wait)
    #expect(ReleaseWait.step(flags: commandBit, keyDown: false, elapsed: 0.2) == .wait)
    #expect(ReleaseWait.step(flags: 0, keyDown: false, elapsed: 0.2) == .proceed)
}

@Test func releaseIgnoresTheFnAndCapsLockBitsAndGivesUpAtTheDeadline() {
    #expect(ReleaseWait.step(flags: fnBit | 0x1_0000, keyDown: false, elapsed: 0) == .proceed)
    #expect(ReleaseWait.step(flags: optionBit, keyDown: false, elapsed: ReleaseWait.deadline) == .giveUp)
    #expect(ReleaseWait.step(flags: 0, keyDown: false, elapsed: ReleaseWait.deadline) == .proceed)
}

@Test func copyWaitReportsTheFirstChangeAndTimesOutAtTheDeadline() {
    let wait = CopyWait(startChangeCount: 7)
    #expect(wait.step(changeCount: 7, elapsed: 0) == .wait)
    #expect(wait.step(changeCount: 7, elapsed: CopyWait.deadline - 0.01) == .wait)
    #expect(wait.step(changeCount: 8, elapsed: 0.02) == .changed)
    #expect(wait.step(changeCount: 7, elapsed: CopyWait.deadline) == .timedOut)
}

@Test func aLateCopyIsRestoredOnlyWhenItIsTheOnlyWrite() {
    let wait = CopyWait(startChangeCount: 7)
    #expect(!wait.lateRestoreNeeded(changeCount: 7))
    #expect(wait.lateRestoreNeeded(changeCount: 8))
    #expect(!wait.lateRestoreNeeded(changeCount: 9))
}

@Test func shelfHandsItsEntryOutOnceAndOnlyToItsRun() {
    var shelf = SelectionShelf<String>()
    shelf.put(id: "a", "first")
    #expect(shelf.take(id: "b") == nil)
    #expect(shelf.take(id: "a") == "first")
    #expect(shelf.take(id: "a") == nil)
}

@Test func aNewReadReplacesTheShelfAndEndDropsOnlyItsOwnRun() {
    var shelf = SelectionShelf<String>()
    shelf.put(id: "a", "first")
    shelf.put(id: "b", "second")
    #expect(shelf.take(id: "a") == nil)
    shelf.clear(id: "a")
    #expect(shelf.take(id: "b") == "second")
    shelf.put(id: "c", "third")
    shelf.clear(id: "c")
    #expect(shelf.take(id: "c") == nil)
}

@Test func clearWithoutAnIdDropsWhateverRunIsShelved() {
    var shelf = SelectionShelf<String>()
    shelf.put(id: "a", "first")
    shelf.clear()
    #expect(shelf.take(id: "a") == nil)
}
