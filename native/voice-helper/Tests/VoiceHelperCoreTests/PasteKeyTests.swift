import Carbon.HIToolbox
import Foundation
import Testing
@testable import VoiceHelperCore

@MainActor
private func layoutData(id: String) throws -> Data {
    let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
    let sources = TISCreateInputSourceList(filter, true).takeRetainedValue() as! [TISInputSource]
    let source = try #require(sources.first, "installed layout \(id)")
    let raw = try #require(TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData))
    return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
}

@MainActor
@Test func ansiUsTypesVAtKeycode9() throws {
    #expect(PasteKey.keycode(typing: "v", in: try layoutData(id: "com.apple.keylayout.US")) == 9)
}

@MainActor
@Test func dvorakTypesVAtTheAnsiPeriodKey() throws {
    #expect(PasteKey.keycode(typing: "v", in: try layoutData(id: "com.apple.keylayout.Dvorak")) == 47)
}

@MainActor
@Test func dvorakQwertyCommandPastesAtTheAnsiVKey() throws {
    #expect(PasteKey.keycode(typing: "v", in: try layoutData(id: "com.apple.keylayout.DVORAK-QWERTYCMD")) == 9)
}

@MainActor
@Test func russianPastesAtTheAnsiVKey() throws {
    #expect(PasteKey.keycode(typing: "v", in: try layoutData(id: "com.apple.keylayout.Russian")) == 9)
}
