import Testing
@testable import VoiceHelperCore

private let fnMask: UInt64 = 0x80_0000
private let rightOptionBits: UInt64 = 0x8_0000 | 0x40
private let leftOptionBits: UInt64 = 0x8_0000 | 0x20
private let rightCommandBits: UInt64 = 0x10_0000 | 0x10

private func fnDown() -> KeyEvent {
    KeyEvent(kind: .flagsChanged, keycode: 63, flags: fnMask)
}
private let fnUp = KeyEvent(kind: .flagsChanged, keycode: 63, flags: 0)
private let deleteDown = KeyEvent(kind: .keyDown, keycode: 51, flags: fnMask)
private let escapeDown = KeyEvent(kind: .keyDown, keycode: 53, flags: 0)
private let escapeUp = KeyEvent(kind: .keyUp, keycode: 53, flags: 0)
private let rightOptionDown = KeyEvent(kind: .flagsChanged, keycode: 61, flags: rightOptionBits)
private let rightOptionUp = KeyEvent(kind: .flagsChanged, keycode: 61, flags: 0)
private let letterA = KeyEvent(kind: .keyDown, keycode: 0, flags: rightOptionBits)
private let letterAUp = KeyEvent(kind: .keyUp, keycode: 0, flags: rightOptionBits)
private let escapeCancel = HotkeyDecision(action: .cancel, consume: true)
private func emits(_ action: HotkeyAction) -> HotkeyDecision { HotkeyDecision(action: action, consume: false) }
private let shiftDown = KeyEvent(kind: .flagsChanged, keycode: 56, flags: fnMask | 0x2_0000)

@Test func pressAndReleaseEmitDownThenUp() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
    #expect(hotkey.handle(fnUp, captureActive: true) == emits(.up))
}

@Test func repeatedDownWhileHeldEmitsNothing() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(fnDown(), captureActive: true) == .none)
    #expect(hotkey.handle(fnUp, captureActive: true) == emits(.up))
}

@Test func staleHoldAtInstallIsIgnoredUntilReleased() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: fnMask)
    #expect(hotkey.handle(fnDown(), captureActive: false) == .none)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
    #expect(hotkey.handle(fnUp, captureActive: true) == emits(.up))
}

@Test func otherKeyWhileHeldIsAChordAndReleaseIsSilent() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(deleteDown, captureActive: true) == emits(.chord))
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
}

@Test func modifiersWhileHeldDoNotCancel() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(shiftDown, captureActive: true) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .keyDown, keycode: 55, flags: fnMask), captureActive: true) == .none)
    #expect(hotkey.handle(fnUp, captureActive: true) == emits(.up))
}

@Test func escapeWhileCapturingCancelsAndIsConsumed() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(escapeDown, captureActive: true) == escapeCancel)
    #expect(hotkey.handle(escapeUp, captureActive: true) == .none)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
}

@Test func escapeWhileCapturingAfterReleasePassesCancelWithoutBreakingHoldState() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    _ = hotkey.handle(fnUp, captureActive: true)
    #expect(hotkey.handle(escapeDown, captureActive: true) == escapeCancel)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
}

@Test func escapeWhenIdlePassesThrough() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(escapeDown, captureActive: false) == .none)
    #expect(hotkey.handle(escapeUp, captureActive: false) == .none)
}

@Test func leftOptionDoesNotTriggerRightOptionHotkey() {
    var hotkey = Hotkeys(key: .rightOption, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 58, flags: leftOptionBits), captureActive: false) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 58, flags: 0), captureActive: false) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: rightOptionBits), captureActive: false) == emits(.down))
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: 0), captureActive: true) == emits(.up))
}

@Test func rightCommandUsesDeviceBit() {
    var hotkey = Hotkeys(key: .rightCommand, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 54, flags: rightCommandBits), captureActive: false) == emits(.down))
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 54, flags: 0x10_0000), captureActive: true) == emits(.up))
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 55, flags: 0x10_0000 | 0x8), captureActive: false) == .none)
}

@Test func reconcileEmitsUpForAHoldWhoseKeyIsNoLongerDown() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.reconcile(flags: 0) == .up)
    #expect(!hotkey.awaitingRelease)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
}

@Test func reconcileKeepsAHoldWhoseKeyIsStillDown() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.reconcile(flags: fnMask) == nil)
    #expect(hotkey.handle(fnUp, captureActive: true) == emits(.up))
}

@Test func reconcileNeverStartsAHoldFromAPressItDidNotSee() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.reconcile(flags: fnMask) == nil)
    #expect(!hotkey.awaitingRelease)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
}

@Test func reconcileUnsticksACancelledHoldWithoutEmitting() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    _ = hotkey.handle(deleteDown, captureActive: true)
    #expect(hotkey.reconcile(flags: 0) == nil)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
}

@Test func reconcileTreatsAnyOptionBitAsRightOptionStillDown() {
    var hotkey = Hotkeys(key: .rightOption, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: rightOptionBits), captureActive: false)
    #expect(hotkey.reconcile(flags: 0x8_0000) == nil)
    #expect(hotkey.reconcile(flags: 0) == .up)
}

@Test func hotkeyEventsAreNeverConsumed() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), captureActive: false).consume == false)
    #expect(hotkey.handle(fnUp, captureActive: true).consume == false)
}

@Test func toggleKeyCleanTapEmitsOneToggleOnRelease() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    #expect(hotkey.handle(rightOptionDown, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == emits(.toggle))
    #expect(hotkey.handle(rightOptionDown, captureActive: true) == .none)
    #expect(hotkey.handle(rightOptionUp, captureActive: true) == emits(.toggle))
}

@Test func toggleKeyChordEmitsNothingBeforeOrAfterRelease() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    #expect(hotkey.handle(rightOptionDown, captureActive: false) == .none)
    #expect(hotkey.handle(letterA, captureActive: false) == .none)
    #expect(hotkey.handle(letterAUp, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionDown, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == emits(.toggle))
}

@Test func toggleKeyChordDuringCaptureEmitsNothing() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, captureActive: false)
    _ = hotkey.handle(rightOptionUp, captureActive: false)
    #expect(hotkey.handle(rightOptionDown, captureActive: true) == .none)
    #expect(hotkey.handle(letterA, captureActive: true) == .none)
    #expect(hotkey.handle(rightOptionUp, captureActive: true) == .none)
}

@Test func holdKeyStillWorksBesideAToggleKey() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
    #expect(hotkey.handle(deleteDown, captureActive: true) == emits(.chord))
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false) == emits(.down))
    #expect(hotkey.handle(fnUp, captureActive: true) == emits(.up))
}

@Test func escapeWithBothKeysHeldCancelsOnceAndSilencesBothReleases() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    _ = hotkey.handle(rightOptionDown, captureActive: true)
    #expect(hotkey.handle(escapeDown, captureActive: true) == escapeCancel)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == .none)
}

@Test func escapeDuringAToggleSessionCancelsOnce() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, captureActive: false)
    _ = hotkey.handle(rightOptionUp, captureActive: true)
    #expect(hotkey.handle(escapeDown, captureActive: true) == escapeCancel)
    #expect(hotkey.handle(escapeUp, captureActive: true) == .none)
}

@Test func escapeWhileAKeyIsHeldButIdlePassesThroughWithoutCancelling() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(escapeDown, captureActive: false) == .none)
    #expect(hotkey.handle(fnUp, captureActive: true) == emits(.up))
}

@Test func reconcileNeverEmitsForTheToggleKey() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, captureActive: false)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.reconcile(flags: 0) == nil)
    #expect(!hotkey.awaitingRelease)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == .none)
}

@Test func reconcileReleasesTheHoldKeyButNotTheToggleKey() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    _ = hotkey.handle(rightOptionDown, captureActive: true)
    #expect(hotkey.reconcile(flags: 0) == .up)
}

@Test func staleToggleKeyAtInstallIsIgnoredUntilReleased() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: rightOptionBits)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionDown, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == emits(.toggle))
}
