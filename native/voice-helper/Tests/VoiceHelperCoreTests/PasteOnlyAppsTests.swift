import Testing
@testable import VoiceHelperCore

private let chromium = "com.google.Chrome"
private let textEdit = "com.apple.TextEdit"

@Test func anAppWhoseWriteWasStillUnchangedLaterPastesFromThenOn() {
    var apps = PasteOnlyApps()
    apps.record(chromium, lateVerdict: .unchanged)
    #expect(apps.contains(chromium))
}

@Test func anAppWhoseWriteLandedLateKeepsTheAccessibilityWrite() {
    var apps = PasteOnlyApps()
    apps.record(textEdit, lateVerdict: .inserted)
    #expect(!apps.contains(textEdit))
}

@Test func oneAppIgnoringTheWriteDoesNotAffectAnother() {
    var apps = PasteOnlyApps()
    apps.record(chromium, lateVerdict: .unchanged)
    #expect(!apps.contains(textEdit))
}

@Test func aTargetWithoutABundleIdIsNeverRemembered() {
    var apps = PasteOnlyApps()
    apps.record(nil, lateVerdict: .unchanged)
    #expect(apps == PasteOnlyApps())
    #expect(!apps.contains(nil))
}
