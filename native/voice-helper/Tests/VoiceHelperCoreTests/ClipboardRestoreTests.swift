import Testing
@testable import VoiceHelperCore

@Test func singlePasteRestoresTheUserClipboard() {
    var restore = ClipboardRestore<String>()
    let saved = restore.contentsToSave(changeCount: 1) { "user" }
    restore.wrote(2, saved: saved)
    #expect(restore.restore(write: 2, changeCount: 2) == "user")
}

@Test func aCopyDuringThePasteIsNotOverwritten() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    #expect(restore.restore(write: 2, changeCount: 3) == nil)
}

@Test func aSecondPasteDuringAPendingRestoreKeepsTheUserClipboard() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    let second = restore.contentsToSave(changeCount: 2) { "first transcript" }
    #expect(second == "user")
    restore.wrote(3, saved: second)
    #expect(restore.restore(write: 2, changeCount: 3) == nil)
    #expect(restore.restore(write: 3, changeCount: 3) == "user")
}

@Test func aCopyBetweenTwoPastesIsWhatTheSecondRestores() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    let second = restore.contentsToSave(changeCount: 3) { "copied meanwhile" }
    #expect(second == "copied meanwhile")
    restore.wrote(4, saved: second)
    #expect(restore.restore(write: 2, changeCount: 4) == nil)
    #expect(restore.restore(write: 4, changeCount: 4) == "copied meanwhile")
}

@Test func aFinishedRestoreDoesNotCarryOver() {
    var restore = ClipboardRestore<String>()
    restore.wrote(2, saved: restore.contentsToSave(changeCount: 1) { "user" })
    _ = restore.restore(write: 2, changeCount: 2)
    #expect(restore.contentsToSave(changeCount: 3) { "restored user" } == "restored user")
}
