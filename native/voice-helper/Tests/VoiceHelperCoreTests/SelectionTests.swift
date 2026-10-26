import Foundation
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

/// Chromium's `org.chromium.web-custom-data` layout (base/pickle.cc, custom_data_helper.cc): a
/// uint32 payload size, a uint32 entry count, then each key and value as a uint32 UTF-16 code
/// unit count followed by the little-endian code units, padded to four bytes.
private func chromiumWebCustomData(_ entries: [(String, String)]) -> Data {
    var payload = Data()
    func append(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { payload.append(contentsOf: $0) } }
    func append(_ string: String) {
        let units = Array(string.utf16)
        append(UInt32(units.count))
        for unit in units { payload.append(contentsOf: [UInt8(unit & 0xFF), UInt8(unit >> 8)]) }
        payload.append(contentsOf: [UInt8](repeating: 0, count: (4 - units.count * 2 % 4) % 4))
    }
    append(UInt32(entries.count))
    for (key, value) in entries {
        append(key)
        append(value)
    }
    var pickle = Data()
    withUnsafeBytes(of: UInt32(payload.count).littleEndian) { pickle.append(contentsOf: $0) }
    return pickle + payload
}

@Test func monacoMarksALineCopiedWithNothingSelectedInItsClipboardMetadata() {
    let emptySelection = #"{"version":1,"id":"a1","isFromEmptySelection":true,"isBlock":false,"multicursorText":null,"mode":"swift"}"#
    let selection = #"{"version":1,"id":"a2","isFromEmptySelection":false,"isBlock":false,"multicursorText":null,"mode":"swift"}"#
    #expect(isMonacoEmptySelectionCopy(webCustomData: chromiumWebCustomData([("vscode-editor-data", emptySelection)])))
    #expect(!isMonacoEmptySelectionCopy(webCustomData: chromiumWebCustomData([("vscode-editor-data", selection)])))
    #expect(!isMonacoEmptySelectionCopy(webCustomData: chromiumWebCustomData([("text/x-synthetic", "isFromEmptySelection")])))
    #expect(!isMonacoEmptySelectionCopy(webCustomData: Data("\"isFromEmptySelection\":true".utf8)))
}

@Test func secureInputAndSecureFieldsRefuseBeforeAnyRead() {
    #expect(planRead(secureInput: true, answer: .noAnswer) == .fail(.secureInput))
    #expect(planRead(secureInput: true, answer: .text(synthetic, range: range)) == .fail(.secureInput))
    #expect(planRead(secureInput: false, answer: .secureField) == .fail(.secureInput))
}

private func verdict(_ origin: SelectionOrigin, ax: AXSelectionAnswer, stamp: [UInt32]) -> WriteVerdict {
    writeVerdict(origin: origin, readAX: { ax }, readStamp: { PressStamp(counts: stamp) })
}

@Test func accessibilityOriginProceedsOnlyWhenTextAndRangeStillMatch() {
    let origin = SelectionOrigin.accessibility(text: synthetic, range: range)
    #expect(verdict(origin, ax: .text(synthetic, range: range), stamp: []) == .proceed)
    #expect(verdict(origin, ax: .text(synthetic, range: AXTextRange(location: 5, length: 9)), stamp: []) == .refuseSelectionChanged)
    #expect(verdict(origin, ax: .text("Synthetic", range: range), stamp: []) == .refuseSelectionChanged)
    #expect(verdict(origin, ax: .emptyRange, stamp: []) == .refuseSelectionChanged)
    #expect(verdict(origin, ax: .noAnswer, stamp: []) == .refuseSelectionChanged)
}

@Test func copyOriginProceedsOnlyWhileNoPressHappenedSinceTheRead() {
    let origin = SelectionOrigin.copy(pressStamp: PressStamp(counts: [10, 2, 0, 0]))
    #expect(verdict(origin, ax: .noAnswer, stamp: [10, 2, 0, 0]) == .proceed)
    #expect(verdict(origin, ax: .noAnswer, stamp: [11, 2, 0, 0]) == .refuseSelectionChanged)
    #expect(verdict(origin, ax: .noAnswer, stamp: [10, 3, 0, 0]) == .refuseSelectionChanged)
    #expect(verdict(origin, ax: .text(synthetic, range: range), stamp: [10, 2, 0, 0]) == .proceed)
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

/// A single write after the deadline is as likely the user's own Cmd+C as the helper's late
/// one, so the clipboard the user had before the read must not come back over it.
@Test func aCopySeenAfterTheDeadlineIsNeverRestored() {
    let wait = CopyWait(startChangeCount: 7)
    #expect(!wait.lateRestoreNeeded(changeCount: 7))
    #expect(!wait.lateRestoreNeeded(changeCount: 8))
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
