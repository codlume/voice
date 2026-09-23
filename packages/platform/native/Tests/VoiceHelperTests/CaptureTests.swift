import Testing
import Foundation
@testable import VoiceHelperProtocol

@Test func captureRequiresExplicitIdentityAndRejectsExtraFields() {
    #expect(CaptureRequest(["type": "capture.start", "session": "one", "attempt": "one", "device": NSNull()]) != nil)
    #expect(CaptureRequest(["type": "capture.start", "session": "one", "device": NSNull()]) == nil)
    #expect(CaptureRequest(["type": "capture.start", "session": "one", "attempt": "one", "device": NSNull(), "extra": true]) == nil)
}

private func wave(rate: UInt32 = 16000, channels: UInt16 = 1, bits: UInt16 = 16, extra: Bool = false, samples: [Int16] = [1, -2, 300]) -> Data {
    func le<T: FixedWidthInteger>(_ value: T) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
    let pcm = samples.reduce(into: Data()) { $0 += le($1) }
    var body = Data("WAVE".utf8)
    body += Data("fmt ".utf8) + le(UInt32(16)) + le(UInt16(1)) + le(channels) + le(rate)
    body += le(rate * UInt32(channels) * UInt32(bits / 8)) + le(channels * bits / 8) + le(bits)
    // An odd-sized chunk before data is padded, as RIFF requires.
    if extra { body += Data("LIST".utf8) + le(UInt32(3)) + Data([1, 2, 3, 0]) }
    body += Data("data".utf8) + le(UInt32(pcm.count)) + pcm
    return Data("RIFF".utf8) + le(UInt32(body.count)) + body
}

@Test func fixtureWaveAcceptsOnly16kMonoPcm16() {
    let expected = Data([1, 0, 0xFE, 0xFF, 0x2C, 0x01])
    #expect(FixtureWave.pcm(wave()) == expected)
    #expect(FixtureWave.pcm(wave(extra: true)) == expected)
    #expect(FixtureWave.pcm(wave(rate: 48000)) == nil)
    #expect(FixtureWave.pcm(wave(channels: 2)) == nil)
    #expect(FixtureWave.pcm(wave(bits: 8)) == nil)
    #expect(FixtureWave.pcm(wave(samples: [])) == nil)
    #expect(FixtureWave.pcm(Data("not a wave".utf8)) == nil)
    #expect(FixtureWave.pcm(wave().prefix(30)) == nil)
}
