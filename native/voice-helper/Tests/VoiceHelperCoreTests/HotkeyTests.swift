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
private let escapeCancel = HotkeyDecision(emit: .hotkey(.cancel), consume: true)
private func emits(_ action: HotkeyAction) -> HotkeyDecision { HotkeyDecision(emit: .hotkey(action), consume: false) }
private let shiftDown = KeyEvent(kind: .flagsChanged, keycode: 56, flags: fnMask | 0x2_0000)

@Test func pressAndReleaseEmitDownThenUp() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
    #expect(hotkey.handle(fnUp, activity: .capturing) == emits(.up))
}

@Test func repeatedDownWhileHeldEmitsNothing() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    #expect(hotkey.handle(fnDown(), activity: .capturing) == .none)
    #expect(hotkey.handle(fnUp, activity: .capturing) == emits(.up))
}

@Test func staleHoldAtInstallIsIgnoredUntilReleased() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: fnMask)
    #expect(hotkey.handle(fnDown(), activity: .idle) == .none)
    #expect(hotkey.handle(fnUp, activity: .idle) == .none)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
    #expect(hotkey.handle(fnUp, activity: .capturing) == emits(.up))
}

@Test func otherKeyWhileHeldIsAChordAndReleaseIsSilent() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    #expect(hotkey.handle(deleteDown, activity: .capturing) == emits(.chord))
    #expect(hotkey.handle(fnUp, activity: .idle) == .none)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
}

@Test func modifiersWhileHeldDoNotCancel() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    #expect(hotkey.handle(shiftDown, activity: .capturing) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .keyDown, keycode: 55, flags: fnMask), activity: .capturing) == .none)
    #expect(hotkey.handle(fnUp, activity: .capturing) == emits(.up))
}

@Test func escapeWhileCapturingCancelsAndIsConsumed() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    #expect(hotkey.handle(escapeDown, activity: .capturing) == escapeCancel)
    #expect(hotkey.handle(escapeUp, activity: .capturing) == .none)
    #expect(hotkey.handle(fnUp, activity: .idle) == .none)
}

@Test func escapeWhileCapturingAfterReleasePassesCancelWithoutBreakingHoldState() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    _ = hotkey.handle(fnUp, activity: .capturing)
    #expect(hotkey.handle(escapeDown, activity: .capturing) == escapeCancel)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
}

@Test func escapeWhenIdlePassesThrough() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(escapeDown, activity: .idle) == .none)
    #expect(hotkey.handle(escapeUp, activity: .idle) == .none)
}

@Test func leftOptionDoesNotTriggerRightOptionHotkey() {
    var hotkey = Hotkeys(key: .rightOption, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 58, flags: leftOptionBits), activity: .idle) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 58, flags: 0), activity: .idle) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: rightOptionBits), activity: .idle) == emits(.down))
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: 0), activity: .capturing) == emits(.up))
}

@Test func rightCommandUsesDeviceBit() {
    var hotkey = Hotkeys(key: .rightCommand, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 54, flags: rightCommandBits), activity: .idle) == emits(.down))
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 54, flags: 0x10_0000), activity: .capturing) == emits(.up))
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 55, flags: 0x10_0000 | 0x8), activity: .idle) == .none)
}

@Test func reconcileEmitsUpForAHoldWhoseKeyIsNoLongerDown() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.reconcile(flags: 0) == .up)
    #expect(!hotkey.awaitingRelease)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
}

@Test func reconcileKeepsAHoldWhoseKeyIsStillDown() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    #expect(hotkey.reconcile(flags: fnMask) == nil)
    #expect(hotkey.handle(fnUp, activity: .capturing) == emits(.up))
}

@Test func reconcileNeverStartsAHoldFromAPressItDidNotSee() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.reconcile(flags: fnMask) == nil)
    #expect(!hotkey.awaitingRelease)
    #expect(hotkey.handle(fnUp, activity: .idle) == .none)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
}

@Test func reconcileUnsticksACancelledHoldWithoutEmitting() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    _ = hotkey.handle(deleteDown, activity: .capturing)
    #expect(hotkey.reconcile(flags: 0) == nil)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
}

@Test func reconcileTreatsAnyOptionBitAsRightOptionStillDown() {
    var hotkey = Hotkeys(key: .rightOption, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: rightOptionBits), activity: .idle)
    #expect(hotkey.reconcile(flags: 0x8_0000) == nil)
    #expect(hotkey.reconcile(flags: 0) == .up)
}

@Test func hotkeyEventsAreNeverConsumed() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), activity: .idle).consume == false)
    #expect(hotkey.handle(fnUp, activity: .capturing).consume == false)
}

@Test func toggleKeyCleanTapEmitsOneToggleOnRelease() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    #expect(hotkey.handle(rightOptionDown, activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionUp, activity: .idle) == emits(.toggle))
    #expect(hotkey.handle(rightOptionDown, activity: .capturing) == .none)
    #expect(hotkey.handle(rightOptionUp, activity: .capturing) == emits(.toggle))
}

@Test func toggleKeyChordEmitsNothingBeforeOrAfterRelease() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    #expect(hotkey.handle(rightOptionDown, activity: .idle) == .none)
    #expect(hotkey.handle(letterA, activity: .idle) == .none)
    #expect(hotkey.handle(letterAUp, activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionUp, activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionDown, activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionUp, activity: .idle) == emits(.toggle))
}

@Test func toggleKeyChordDuringCaptureEmitsNothing() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, activity: .idle)
    _ = hotkey.handle(rightOptionUp, activity: .idle)
    #expect(hotkey.handle(rightOptionDown, activity: .capturing) == .none)
    #expect(hotkey.handle(letterA, activity: .capturing) == .none)
    #expect(hotkey.handle(rightOptionUp, activity: .capturing) == .none)
}

@Test func holdKeyStillWorksBesideAToggleKey() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
    #expect(hotkey.handle(deleteDown, activity: .capturing) == emits(.chord))
    #expect(hotkey.handle(fnUp, activity: .idle) == .none)
    #expect(hotkey.handle(fnDown(), activity: .idle) == emits(.down))
    #expect(hotkey.handle(fnUp, activity: .capturing) == emits(.up))
}

@Test func escapeWithBothKeysHeldCancelsOnceAndSilencesBothReleases() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    _ = hotkey.handle(rightOptionDown, activity: .capturing)
    #expect(hotkey.handle(escapeDown, activity: .capturing) == escapeCancel)
    #expect(hotkey.handle(fnUp, activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionUp, activity: .idle) == .none)
}

@Test func escapeDuringAToggleSessionCancelsOnce() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, activity: .idle)
    _ = hotkey.handle(rightOptionUp, activity: .capturing)
    #expect(hotkey.handle(escapeDown, activity: .capturing) == escapeCancel)
    #expect(hotkey.handle(escapeUp, activity: .capturing) == .none)
}

@Test func escapeWhileAKeyIsHeldButIdlePassesThroughWithoutCancelling() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    #expect(hotkey.handle(escapeDown, activity: .idle) == .none)
    #expect(hotkey.handle(fnUp, activity: .capturing) == emits(.up))
}

@Test func reconcileNeverEmitsForTheToggleKey() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, activity: .idle)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.reconcile(flags: 0) == nil)
    #expect(!hotkey.awaitingRelease)
    #expect(hotkey.handle(rightOptionUp, activity: .idle) == .none)
}

@Test func reconcileReleasesTheHoldKeyButNotTheToggleKey() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    _ = hotkey.handle(rightOptionDown, activity: .capturing)
    #expect(hotkey.reconcile(flags: 0) == .up)
}

@Test func staleToggleKeyAtInstallIsIgnoredUntilReleased() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, initialFlags: rightOptionBits)
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.handle(rightOptionUp, activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionDown, activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionUp, activity: .idle) == emits(.toggle))
}

// Transform shortcuts. Keycode 18 is the "1" position; 123 is Left Arrow, which sets the fn and
// numeric-pad bits on its own.
private let polish = TransformShortcut(id: "polish", keycode: 18, modifiers: [.option])
private let optionShiftOne = TransformShortcut(id: "shout", keycode: 18, modifiers: [.option, .shift])
private let optionLeft = TransformShortcut(id: "left", keycode: 123, modifiers: [.option])
private let optionBit: UInt64 = 0x8_0000
private let shiftBit: UInt64 = 0x2_0000
private let capsLockBit: UInt64 = 0x1_0000
private let arrowBits: UInt64 = fnMask | 0x20_0000
private let consumed = HotkeyDecision(emit: .nothing, consume: true)
private func fires(_ id: String) -> HotkeyDecision { HotkeyDecision(emit: .transform(id), consume: true) }
private func press(_ keycode: Int64, flags: UInt64, isRepeat: Bool = false) -> KeyEvent {
    KeyEvent(kind: .keyDown, keycode: keycode, flags: flags, isRepeat: isRepeat)
}
private func release(_ keycode: Int64, flags: UInt64) -> KeyEvent {
    KeyEvent(kind: .keyUp, keycode: keycode, flags: flags)
}

@Test func shortcutPressFiresAndBothPressAndReleaseAreConsumed() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [polish], initialFlags: 0)
    #expect(hotkey.handle(press(18, flags: leftOptionBits), activity: .idle) == fires("polish"))
    #expect(hotkey.handle(release(18, flags: leftOptionBits), activity: .transforming) == consumed)
    #expect(hotkey.handle(release(18, flags: leftOptionBits), activity: .transforming) == .none)
}

@Test func repeatsOfASwallowedKeyAreConsumedSilently() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [polish], initialFlags: 0)
    _ = hotkey.handle(press(18, flags: leftOptionBits), activity: .idle)
    #expect(hotkey.handle(press(18, flags: leftOptionBits, isRepeat: true), activity: .transforming) == consumed)
    #expect(hotkey.handle(press(18, flags: 0, isRepeat: true), activity: .transforming) == consumed)
    #expect(hotkey.handle(release(18, flags: 0), activity: .transforming) == consumed)
}

@Test func matchNeedsTheExactModifierSet() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [polish, optionShiftOne], initialFlags: 0)
    #expect(hotkey.handle(press(18, flags: optionBit | shiftBit), activity: .idle) == fires("shout"))
    #expect(hotkey.handle(release(18, flags: optionBit | shiftBit), activity: .idle) == consumed)
    #expect(hotkey.handle(press(18, flags: optionBit | capsLockBit), activity: .idle) == fires("polish"))
    #expect(hotkey.handle(release(18, flags: optionBit), activity: .idle) == consumed)
    #expect(hotkey.handle(press(18, flags: 0), activity: .idle) == .none)
    #expect(hotkey.handle(release(18, flags: 0), activity: .idle) == .none)
}

@Test func leftOptionFiresWhileRightOptionStaysADictationChord() {
    var hotkey = Hotkeys(key: .rightOption, toggleKey: nil, transforms: [polish], initialFlags: 0)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 58, flags: leftOptionBits), activity: .idle) == .none)
    #expect(hotkey.handle(press(18, flags: leftOptionBits), activity: .idle) == fires("polish"))
    #expect(hotkey.handle(release(18, flags: leftOptionBits), activity: .idle) == consumed)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 58, flags: 0), activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionDown, activity: .idle) == emits(.down))
    // Still idle: capture.started has not come back yet, so the hold state alone must refuse.
    #expect(hotkey.handle(press(18, flags: rightOptionBits), activity: .idle) == emits(.chord))
    #expect(hotkey.handle(release(18, flags: rightOptionBits), activity: .capturing) == .none)
}

@Test func anArrowShortcutMatchesThroughTheFnBitUnlessFnIsHeld() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [optionLeft], initialFlags: 0)
    #expect(hotkey.handle(press(123, flags: optionBit | arrowBits), activity: .idle) == fires("left"))
    #expect(hotkey.handle(release(123, flags: optionBit | arrowBits), activity: .idle) == consumed)
    _ = hotkey.handle(fnDown(), activity: .idle)
    #expect(hotkey.handle(press(123, flags: optionBit | arrowBits), activity: .capturing) == emits(.chord))
    #expect(hotkey.handle(release(123, flags: optionBit | arrowBits), activity: .capturing) == .none)
}

@Test func toggleKeyDownAlsoBlocksShortcuts() {
    var hotkey = Hotkeys(key: .fn, toggleKey: .rightOption, transforms: [polish], initialFlags: 0)
    _ = hotkey.handle(rightOptionDown, activity: .idle)
    #expect(hotkey.handle(press(18, flags: rightOptionBits), activity: .idle) == .none)
    #expect(hotkey.handle(rightOptionUp, activity: .idle) == .none)
}

@Test func setTransformsDuringAHoldEmitsNothingAndKeepsTheHold() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [], initialFlags: 0)
    _ = hotkey.handle(fnDown(), activity: .idle)
    hotkey.setTransforms([polish])
    #expect(hotkey.awaitingRelease)
    #expect(hotkey.handle(fnUp, activity: .capturing) == emits(.up))
    #expect(hotkey.handle(press(18, flags: leftOptionBits), activity: .idle) == fires("polish"))
}

@Test func setTransformsKeepsASwallowedKeyUntilItsRelease() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [polish], initialFlags: 0)
    _ = hotkey.handle(press(18, flags: leftOptionBits), activity: .idle)
    hotkey.setTransforms([])
    #expect(hotkey.handle(release(18, flags: leftOptionBits), activity: .transforming) == consumed)
    #expect(hotkey.handle(press(18, flags: leftOptionBits), activity: .idle) == .none)
}

@Test func escapeCancelsWhileTransformingAndPassesThroughWhenIdle() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [polish], initialFlags: 0)
    #expect(hotkey.handle(escapeDown, activity: .idle) == .none)
    #expect(hotkey.handle(escapeDown, activity: .transforming) == escapeCancel)
    #expect(hotkey.handle(escapeDown, activity: .capturing) == escapeCancel)
}

@Test func shortcutsPassThroughWhileCapturingAndFireWhileTransforming() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [polish], initialFlags: 0)
    #expect(hotkey.handle(press(18, flags: leftOptionBits), activity: .capturing) == .none)
    #expect(hotkey.handle(release(18, flags: leftOptionBits), activity: .capturing) == .none)
    #expect(hotkey.handle(press(18, flags: leftOptionBits), activity: .transforming) == fires("polish"))
    #expect(hotkey.handle(release(18, flags: leftOptionBits), activity: .transforming) == consumed)
}

@Test func matchIsByKeycodeNotByTheCharacterTheLayoutTypes() {
    // Keycode 6 types "z" on US and "y" on German; the shortcut names the position.
    let zed = TransformShortcut(id: "zed", keycode: 6, modifiers: [.option])
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [zed], initialFlags: 0)
    #expect(hotkey.handle(press(6, flags: leftOptionBits), activity: .idle) == fires("zed"))
    #expect(hotkey.handle(release(6, flags: leftOptionBits), activity: .idle) == consumed)
    #expect(hotkey.handle(press(16, flags: leftOptionBits), activity: .idle) == .none)
}

@Test func reconcileForgetsSwallowedKeys() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, transforms: [polish], initialFlags: 0)
    _ = hotkey.handle(press(18, flags: leftOptionBits), activity: .idle)
    #expect(hotkey.reconcile(flags: 0) == nil)
    #expect(hotkey.handle(release(18, flags: leftOptionBits), activity: .idle) == .none)
}

// The meeting shortcut. Keycode 46 is the "M" position.
private let optionM = KeyCombo(keycode: 46, modifiers: [.option])
private let meetingFires = HotkeyDecision(emit: .meeting, consume: true)

@Test func meetingShortcutFiresOncePerPressAndSwallowsTheKey() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, meeting: optionM, initialFlags: 0)
    #expect(hotkey.handle(press(46, flags: leftOptionBits), activity: .idle) == meetingFires)
    #expect(hotkey.handle(press(46, flags: leftOptionBits, isRepeat: true), activity: .idle) == consumed)
    #expect(hotkey.handle(release(46, flags: leftOptionBits), activity: .idle) == consumed)
    #expect(hotkey.handle(press(46, flags: 0), activity: .idle) == .none)
    #expect(hotkey.handle(press(46, flags: optionBit | shiftBit), activity: .idle) == .none)
}

@Test func meetingShortcutNeverFiresFromARepeatAlone() {
    // A key already down when the tap starts or the shortcut changes arrives only as repeats.
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, meeting: optionM, initialFlags: 0)
    #expect(hotkey.handle(press(46, flags: leftOptionBits, isRepeat: true), activity: .idle) == consumed)
    #expect(hotkey.handle(release(46, flags: leftOptionBits), activity: .idle) == .none)
}

@Test func meetingShortcutFiresBesideAToggledDictationButNotDuringAHold() {
    var hotkey = Hotkeys(key: .rightOption, toggleKey: nil, meeting: optionM, initialFlags: 0)
    #expect(hotkey.handle(press(46, flags: leftOptionBits), activity: .capturing) == meetingFires)
    #expect(hotkey.handle(release(46, flags: leftOptionBits), activity: .capturing) == consumed)
    #expect(hotkey.handle(rightOptionDown, activity: .idle) == emits(.down))
    #expect(hotkey.handle(press(46, flags: rightOptionBits), activity: .capturing) == emits(.chord))
}

@Test func meetingShortcutOffOrChangedStopsMatching() {
    var hotkey = Hotkeys(key: .fn, toggleKey: nil, meeting: optionM, initialFlags: 0)
    hotkey.setMeeting(nil)
    #expect(hotkey.handle(press(46, flags: leftOptionBits), activity: .idle) == .none)
    hotkey.setMeeting(KeyCombo(keycode: 46, modifiers: [.control, .option]))
    #expect(hotkey.handle(press(46, flags: leftOptionBits), activity: .idle) == .none)
    #expect(hotkey.handle(press(46, flags: optionBit | 0x4_0000), activity: .idle) == meetingFires)
}
