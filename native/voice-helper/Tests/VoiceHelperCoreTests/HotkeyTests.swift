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
private let shiftDown = KeyEvent(kind: .flagsChanged, keycode: 56, flags: fnMask | 0x2_0000)

@Test func pressAndReleaseEmitDownThenUp() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), captureActive: false) == HotkeyDecision(action: .down, consume: false))
    #expect(hotkey.handle(fnUp, captureActive: true) == HotkeyDecision(action: .up, consume: false))
}

@Test func repeatedDownWhileHeldEmitsNothing() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(fnDown(), captureActive: true) == .none)
    #expect(hotkey.handle(fnUp, captureActive: true).action == .up)
}

@Test func staleHoldAtInstallIsIgnoredUntilReleased() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: fnMask)
    #expect(hotkey.handle(fnDown(), captureActive: false) == .none)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false).action == .down)
    #expect(hotkey.handle(fnUp, captureActive: true).action == .up)
}

@Test func otherKeyWhileHeldCancelsAndReleaseIsSilent() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(deleteDown, captureActive: true) == HotkeyDecision(action: .cancel, consume: false))
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
    #expect(hotkey.handle(fnDown(), captureActive: false).action == .down)
}

@Test func modifiersWhileHeldDoNotCancel() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(shiftDown, captureActive: true) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .keyDown, keycode: 55, flags: fnMask), captureActive: true) == .none)
    #expect(hotkey.handle(fnUp, captureActive: true).action == .up)
}

@Test func escapeWhileCapturingCancelsAndIsConsumed() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    #expect(hotkey.handle(escapeDown, captureActive: true) == HotkeyDecision(action: .cancel, consume: true))
    #expect(hotkey.handle(escapeUp, captureActive: true) == .none)
    #expect(hotkey.handle(fnUp, captureActive: false) == .none)
}

@Test func escapeWhileCapturingAfterReleasePassesCancelWithoutBreakingHoldState() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: 0)
    _ = hotkey.handle(fnDown(), captureActive: false)
    _ = hotkey.handle(fnUp, captureActive: true)
    #expect(hotkey.handle(escapeDown, captureActive: true) == HotkeyDecision(action: .cancel, consume: true))
    #expect(hotkey.handle(fnDown(), captureActive: false).action == .down)
}

@Test func escapeWhenIdlePassesThrough() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: 0)
    #expect(hotkey.handle(escapeDown, captureActive: false) == .none)
    #expect(hotkey.handle(escapeUp, captureActive: false) == .none)
}

@Test func leftOptionDoesNotTriggerRightOptionHotkey() {
    var hotkey = HotkeyInterpreter(key: .rightOption, initialFlags: 0)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 58, flags: leftOptionBits), captureActive: false) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 58, flags: 0), captureActive: false) == .none)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: rightOptionBits), captureActive: false).action == .down)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 61, flags: 0), captureActive: true).action == .up)
}

@Test func rightCommandUsesDeviceBit() {
    var hotkey = HotkeyInterpreter(key: .rightCommand, initialFlags: 0)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 54, flags: rightCommandBits), captureActive: false).action == .down)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 54, flags: 0x10_0000), captureActive: true).action == .up)
    #expect(hotkey.handle(KeyEvent(kind: .flagsChanged, keycode: 55, flags: 0x10_0000 | 0x8), captureActive: false) == .none)
}

@Test func hotkeyEventsAreNeverConsumed() {
    var hotkey = HotkeyInterpreter(key: .fn, initialFlags: 0)
    #expect(hotkey.handle(fnDown(), captureActive: false).consume == false)
    #expect(hotkey.handle(fnUp, captureActive: true).consume == false)
}
