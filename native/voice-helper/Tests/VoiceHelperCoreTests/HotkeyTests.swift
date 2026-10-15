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
private let escapeCancel = HotkeyDecision(signals: [HotkeySignal(.cancel, nil)], consume: true)
private func hold(_ action: HotkeyAction) -> HotkeySignal { HotkeySignal(action, .hold) }
private func toggle(_ action: HotkeyAction) -> HotkeySignal { HotkeySignal(action, .toggle) }
private let shiftDown = KeyEvent(kind: .flagsChanged, keycode: 56, flags: fnMask | 0x2_0000)

@Test func pressAndReleaseEmitDownThenUp() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), captureActive: false) == HotkeyDecision(signals: [hold(.down)], consume: false))
    #expect(hotkey.handle(fnUp, captureActive: true) == HotkeyDecision(signals: [hold(.up)], consume: false))
}

@Test func repeatedDownWhileHeldEmitsNothing() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(fnDown(), captureActive: true) == .none)
    #expect(hotkey.handle(fnUp, captureActive: true).signals == [hold(.up)])
}

@Test func staleHoldAtInstallIsIgnoredUntilReleased() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: fnMask)
    #expect(hotkey.handle(fnDown(), captureActive: false) == .none)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false).signals == [hold(.down)])
    #expect(hotkey.handle(fnUp, captureActive: true).signals == [hold(.up)])
}

@Test func otherKeyWhileHeldCancelsAndReleaseIsSilent() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(deleteDown, captureActive: true) == HotkeyDecision(signals: [hold(.cancel)], consume: false))
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false).signals == [hold(.down)])
}

@Test func modifiersWhileHeldDoNotCancel() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(shiftDown, captureActive: true) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .keyDown, keycode: 55, flags: fnMask), captureActive: true) == .none)
    #expect(hotkey.handle(fnUp, captureActive: true).signals == [hold(.up)])
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
    #expect(hotkey.handle(fnDown(), captureActive: false).signals == [hold(.down)])
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
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: rightOptionBits), captureActive: false).signals == [hold(.down)])
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: 0), captureActive: true).signals == [hold(.up)])
}

@Test func rightCommandUsesDeviceBit() {
    var hotkey = Hotkeys(key: .rightCommand, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 54, flags: rightCommandBits), captureActive: false).signals == [hold(.down)])
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 54, flags: 0x10_0000), captureActive: true).signals == [hold(.up)])
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 55, flags: 0x10_0000 | 0x8), captureActive: false) == .none)
}

@Test func reconcileEmitsUpForAHoldWhoseKeyIsNoLongerDown() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.reconcile(flags: 0) == [hold(.up)])
    #expect(!hotkey.awaitingRelease)
    #expect(hotkey.handle(fnDown(), captureActive: false).signals == [hold(.down)])
}

@Test func reconcileKeepsAHoldWhoseKeyIsStillDown() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.reconcile(flags: fnMask).isEmpty)
    #expect(hotkey.handle(fnUp, captureActive: true).signals == [hold(.up)])
}

@Test func reconcileNeverStartsAHoldFromAPressItDidNotSee() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.reconcile(flags: fnMask).isEmpty)
    #expect(!hotkey.awaitingRelease)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false).signals == [hold(.down)])
}

@Test func reconcileUnsticksACancelledHoldWithoutEmitting() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    _ = hotkey.handle(deleteDown, captureActive: true)
    #expect(hotkey.reconcile(flags: 0).isEmpty)
    #expect(hotkey.handle(fnDown(), captureActive: false).signals == [hold(.down)])
}

@Test func reconcileTreatsAnyOptionBitAsRightOptionStillDown() {
    var hotkey = Hotkeys(key: .rightOption, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: rightOptionBits), captureActive: false)
    #expect(hotkey.reconcile(flags: 0x8_0000).isEmpty)
    #expect(hotkey.reconcile(flags: 0) == [hold(.up)])
}

@Test func hotkeyEventsAreNeverConsumed() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), captureActive: false).consume == false)
    #expect(hotkey.handle(fnUp, captureActive: true).consume == false)
}

@Test func toggleKeyPressAndReleaseEmitDownThenUpTaggedToggle() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    #expect(hotkey.handle(rightOptionDown, captureActive: false) == HotkeyDecision(signals: [toggle(.down)], consume: false))
    #expect(hotkey.handle(rightOptionUp, captureActive: true) == HotkeyDecision(signals: [toggle(.up)], consume: false))
    #expect(hotkey.handle(fnDown(), captureActive: true).signals == [hold(.down)])
}

@Test func otherKeyWhileToggleKeyHeldCancelsTaggedToggle() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, captureActive: false)
    let letter = KeyEvent(kind: .keyDown, keycode: 14, flags: rightOptionBits)
    #expect(hotkey.handle(letter, captureActive: true) == HotkeyDecision(signals: [toggle(.cancel)], consume: false))
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == .none)
}

@Test func escapeWithBothKeysHeldCancelsOnceAndSilencesBothReleases() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    _ = hotkey.handle(rightOptionDown, captureActive: true)
    #expect(hotkey.handle(escapeDown, captureActive: true) == escapeCancel)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == .none)
}

@Test func escapeDuringAToggleSessionCancelsOnceWithNoMode() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, captureActive: false)
    _ = hotkey.handle(rightOptionUp, captureActive: true)
    #expect(hotkey.handle(escapeDown, captureActive: true) == escapeCancel)
}

@Test func escapeWhileAKeyIsHeldButIdlePassesThroughWithoutCancelling() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(escapeDown, captureActive: false) == .none)
    #expect(hotkey.handle(fnUp, captureActive: true).signals == [hold(.up)])
}

@Test func reconcileReleasesAMissedToggleKeyRelease() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, captureActive: false)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.reconcile(flags: 0) == [toggle(.up)])
    #expect(!hotkey.awaitingRelease)
}

@Test func staleToggleKeyAtInstallIsIgnoredUntilReleased() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: rightOptionBits)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.handle(rightOptionUp, captureActive: false) == .none)
    #expect(hotkey.handle(rightOptionDown, captureActive: false).signals == [toggle(.down)])
}
