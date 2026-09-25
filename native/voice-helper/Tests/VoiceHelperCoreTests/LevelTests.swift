import Foundation
import Testing
@testable import VoiceHelperCore

@Test func levelEndpointsAndSpeechPoint() {
    #expect(perceptualLevel(rms: 0) == 0)
    #expect(perceptualLevel(rms: 1) == 1)
    #expect(perceptualLevel(rms: 2) == 1)
    #expect(abs(perceptualLevel(rms: 0.03) - 0.4) < 0.02)
    #expect(abs(perceptualLevel(rms: 0.18) - 0.7) < 0.02)
    #expect(perceptualLevel(rms: 1e-9) == 0)
    #expect(perceptualLevel(rms: .nan) == 0)
}

@Test func rmsOfFullScaleSine() {
    let samples = (0..<16000).map { Float(sin(2 * Double.pi * 440 * Double($0) / 16000)) }
    #expect(abs(rms(samples) - 0.7071) < 0.001)
    #expect(rms([Float]()) == 0)
    #expect(rms([Float](repeating: 0, count: 100)) == 0)
}
