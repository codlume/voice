import Testing
@testable import VoiceHelperCore

@Test func singlePasteRestoresTheUserClipboard() {
    var restore = ClipboardRestore<String>()
    let saved = restore.contentsToSave(changeCount: 1) { "user" }
    restore.wrote(2, saved: saved)
    #expect(restore.restore(write: 2, changeCount: 2) == .restore("user"))
}

@Test func aCopyDuringThePasteIsNotOverwritten() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    #expect(restore.restore(write: 2, changeCount: 3) == .changed)
}

@Test func aSecondPasteDuringAPendingRestoreKeepsTheUserClipboard() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    let second = restore.contentsToSave(changeCount: 2) { "first transcript" }
    #expect(second == "user")
    restore.wrote(3, saved: second)
    #expect(restore.restore(write: 2, changeCount: 3) == .superseded)
    #expect(restore.restore(write: 3, changeCount: 3) == .restore("user"))
}

@Test func aCopyBetweenTwoPastesIsWhatTheSecondRestores() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    let second = restore.contentsToSave(changeCount: 3) { "copied meanwhile" }
    #expect(second == "copied meanwhile")
    restore.wrote(4, saved: second)
    #expect(restore.restore(write: 2, changeCount: 4) == .superseded)
    #expect(restore.restore(write: 4, changeCount: 4) == .restore("copied meanwhile"))
}

@Test func aKeptPasteLeavesNothingToRestoreOrFlush() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    restore.kept(3, contents: "kept transcript")
    #expect(!restore.hasPending)
    #expect(restore.restore(write: 2, changeCount: 3) == .superseded)
    #expect(restore.flush(changeCount: 3) == nil)
}

@Test func aPasteOverAKeptTranscriptRestoresItRatherThanClearingItAsConcealed() {
    var restore = ClipboardRestore<SavedClipboard<String>>()
    restore.kept(2, contents: .items(["kept transcript"]))
    let saved = restore.contentsToSave(changeCount: 2) { .concealed }
    #expect(saved == .items(["kept transcript"]))
    restore.wrote(3, saved: saved)
    #expect(restore.restore(write: 3, changeCount: 3) == .restore(.items(["kept transcript"])))
}

@Test func aKeptTranscriptReplacedByTheUserIsSavedAsTheUsersContents() {
    var restore = ClipboardRestore<String>()
    restore.kept(2, contents: "kept transcript")
    #expect(restore.contentsToSave(changeCount: 3) { "user copy" } == "user copy")
}

@Test func aFinishedRestoreDoesNotCarryOver() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    _ = restore.restore(write: 2, changeCount: 2)
    #expect(restore.contentsToSave(changeCount: 3) { "restored user" } == "restored user")
}

@Test func aPendingRestoreFlushedAtShutdownPutsTheUserClipboardBack() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    #expect(restore.flush(changeCount: 2) == "user")
    #expect(restore.restore(write: 2, changeCount: 2) == .superseded)
}

@Test func aSelectionReadSavesBeforeTheCopyAndRestoresRightAfterIt() {
    var restore = ClipboardRestore<String>()
    let saved = restore.contentsToSave(changeCount: 5) { "user" }
    restore.wrote(6, saved: saved)
    #expect(restore.hasPending)
    #expect(restore.restore(write: 6, changeCount: 6) == .restore("user"))
    #expect(!restore.hasPending)
}

@Test func aSelectionReadInsideAPendingPasteRestoreCarriesTheUserClipboardOver() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    let saved = restore.contentsToSave(changeCount: 2) { "transcript" }
    #expect(saved == "user")
    restore.wrote(3, saved: saved)
    #expect(restore.restore(write: 3, changeCount: 3) == .restore("user"))
    #expect(restore.restore(write: 2, changeCount: 3) == .superseded)
}

@Test func plainContentsAreSavedForTheRestore() {
    let saved = SavedClipboard(types: ["public.utf8-plain-text", "public.rtf"]) { ["user"] }
    #expect(saved == .items(["user"]))
}

@Test func anEmptyClipboardIsSavedAsNoItems() {
    #expect(SavedClipboard<String>(types: []) { [] } == .items([]))
}

@Test func aPasswordManagersConcealedWriteIsNeverReadAndNotRestored() {
    var reads = 0
    let saved = SavedClipboard<String>(types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"]) {
        reads += 1
        return ["hunter2"]
    }
    #expect(saved == .concealed)
    #expect(reads == 0)
}

@Test func aSecondPasteOverAConcealedClipboardStillClearsIt() {
    var restore = ClipboardRestore<SavedClipboard<String>>()
    let concealed = SavedClipboard(types: ["org.nspasteboard.ConcealedType"]) { ["hunter2"] }
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { concealed })
    let second = restore.contentsToSave(changeCount: 2) { .items(["first transcript"]) }
    #expect(second == .concealed)
    restore.wrote(3, saved: second)
    #expect(restore.restore(write: 3, changeCount: 3) == .restore(.concealed))
}

@Test func flushBacksOffWhenTheClipboardChangedOrNothingIsPending() {
    var restore = ClipboardRestore<String>()
    #expect(restore.flush(changeCount: 1) == nil)
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    #expect(restore.flush(changeCount: 3) == nil)
}
