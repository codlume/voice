import Foundation
import Testing
@testable import VoiceHelperCore

private let rate = 16_000

/// A voice-like signal from `start` to `end` seconds of a `seconds`-long track: a harmonic
/// series on a gliding pitch, in syllables or held steady, with a timbre fixed by `seed`.
private func voice(_ seconds: Double, from start: Double = 0, to end: Double? = nil, pitch: Float, seed: Float, level: Float = 0.2, syllables: Bool = true) -> [Float] {
    var phase: Float = 0
    let twoPi = 2 * Float.pi
    let stop = end ?? seconds
    return (0..<Int(seconds * Double(rate))).map { (n: Int) -> Float in
        let t = Float(n) / Float(rate)
        let glide: Float = 1 + 0.12 * sin(twoPi * 0.7 * t + seed)
        phase += twoPi * pitch * glide / Float(rate)
        guard Double(t) >= start, Double(t) < stop else { return 0 }
        let syllable: Float = syllables ? max(0, sin(twoPi * 3.3 * t + seed)) : 0.7
        var tone: Float = 0
        for k in 1...14 {
            let harmonic = Float(k)
            let timbre: Float = 1 + 0.6 * sin(harmonic * seed)
            tone += sin(harmonic * phase) * timbre / harmonic
        }
        return level * syllable * tone / 2
    }
}

/// What the mic hears of `played`: `lagMs` later, the direct path at `gain` (18 dB down on a
/// laptop), with a short room tail.
private func throughTheSpeakers(_ played: [Float], lagMs: Double, gain: Float = 0.12) -> [Float] {
    let lag = Int(lagMs * Double(rate) / 1000)
    let taps: [(delay: Int, gain: Float)] = [(0, 1), (48, 1 / 3), (160, -5 / 24), (900, 1 / 12)]
    return played.indices.map { n in
        taps.reduce(0) { sum, tap in
            let i = n - lag - tap.delay
            return i >= 0 && i < played.count ? sum + gain * tap.gain * played[i] : sum
        }
    }
}

/// The room's hiss, about -60 dBFS.
private func roomNoise(_ seconds: Double) -> [Float] {
    var state: UInt32 = 7
    return (0..<Int(seconds * Double(rate))).map { _ in
        state = state &* 1_664_525 &+ 1_013_904_223
        return (Float(state) / Float(UInt32.max) - 0.5) * 0.002
    }
}

private func add(_ tracks: [Float]...) -> [Float] {
    tracks.dropFirst().reduce(tracks[0]) { zip($0, $1).map(+) }
}

private func seconds(_ samples: [Float], _ range: ClosedRange<Double>) -> ArraySlice<Float> {
    samples[Int(range.lowerBound * Double(rate))..<Int(range.upperBound * Double(rate))]
}

private func energy(_ samples: ArraySlice<Float>) -> Float {
    samples.reduce(0) { $0 + $1 * $1 }
}

/// How much of `part` survives in `mixed`, in dB: its projection onto `part`.
private func kept(_ part: ArraySlice<Float>, in mixed: ArraySlice<Float>) -> Float {
    10 * log10(max(zip(part, mixed).reduce(0) { $0 + $1.0 * $1.1 } / energy(part), 1e-9))
}

private func decibels(_ a: Float, over b: Float) -> Float {
    10 * log10(a / b)
}

@Suite struct EchoGateTests {
    @Test(arguments: [-100.0, 0, 120, 300, 550])
    func theOtherSideHeardThroughTheSpeakersIsMuted(lagMs: Double) {
        let system = voice(8, pitch: 120, seed: 1)
        let echo = throughTheSpeakers(system, lagMs: lagMs)
        let gated = EchoGate.gate(mic: add(echo, roomNoise(8)), system: system)
        #expect(decibels(energy(gated[...]), over: energy(echo[...])) < -20)
        #expect(gated.filter { $0 == 0 }.count > gated.count * 9 / 10, "silence, not residue for the model to make words of")
    }

    @Test(arguments: [Float(0.1), 0.3, 1, 3])
    func theOtherSideIsMutedHoweverLoudItComesBack(gain: Float) {
        let system = voice(8, pitch: 120, seed: 1)
        let echo = throughTheSpeakers(system, lagMs: 120, gain: gain)
        let gated = EchoGate.gate(mic: add(echo, roomNoise(8)), system: system)
        #expect(decibels(energy(gated[...]), over: energy(echo[...])) < -20)
    }

    @Test func theUsersVoiceOverTheOtherSideStaysAndOnlyTheirEchoGoes() {
        let system = voice(10, pitch: 120, seed: 1)
        let echo = throughTheSpeakers(system, lagMs: 120)
        // 6 dB above the echo, as on a laptop.
        let user = voice(10, from: 3, to: 7, pitch: 210, seed: 4, level: 0.07)
        let gated = EchoGate.gate(mic: add(user, echo, roomNoise(10)), system: system)
        let talkingOver = 3.0...7.0
        #expect(kept(seconds(user, talkingOver), in: seconds(gated, talkingOver)) > -1.5, "the user's voice comes through")
        #expect(kept(seconds(echo, talkingOver), in: seconds(gated, talkingOver)) < -6, "the echo under it is cut")
        #expect(decibels(energy(seconds(gated, 0.5...2.9)), over: energy(seconds(echo, 0.5...2.9))) < -20, "the echo alone is muted")
    }

    @Test func theUsersVoiceWhileNothingPlaysIsLeftAsRecorded() {
        let system = voice(8, to: 3, pitch: 120, seed: 1)
        let mic = add(throughTheSpeakers(system, lagMs: 120), voice(8, from: 4, pitch: 210, seed: 4, level: 0.07), roomNoise(8))
        let gated = EchoGate.gate(mic: mic, system: system)
        #expect(zip(seconds(mic, 4.0...8.0), seconds(gated, 4.0...8.0)).allSatisfy { abs($0 - $1) < 1e-5 })
    }

    @Test func onHeadphonesTheUsersVoiceStaysWhileTheOtherSideTalks() {
        let system = voice(8, pitch: 120, seed: 1)
        let user = voice(8, from: 2, to: 6, pitch: 210, seed: 4, level: 0.07)
        let gated = EchoGate.gate(mic: add(user, roomNoise(8)), system: system)
        #expect(kept(seconds(user, 2.0...6.0), in: seconds(gated, 2.0...6.0)) > -0.5)
    }

    @Test func aUserWhoTalksThroughEverythingTheOtherSideSaysKeepsTheirVoice() {
        let system = voice(6, pitch: 120, seed: 1)
        let user = voice(6, pitch: 210, seed: 4, level: 0.07, syllables: false)
        let gated = EchoGate.gate(mic: add(user, throughTheSpeakers(system, lagMs: 0), roomNoise(6)), system: system)
        #expect(kept(seconds(user, 1.0...5.0), in: seconds(gated, 1.0...5.0)) > -2)
    }

    @Test func echoRightAfterADictationIsStillMuted() {
        let system = voice(10, pitch: 120, seed: 1)
        let echo = throughTheSpeakers(system, lagMs: 120)
        // The meeting mic records digital silence while the user dictates elsewhere.
        let mic = add(echo, roomNoise(10)).enumerated().map { $0.offset < 6 * rate ? 0 : $0.element }
        let gated = EchoGate.gate(mic: mic, system: system)
        #expect(decibels(energy(seconds(gated, 6.5...10.0)), over: energy(seconds(echo, 6.5...10.0))) < -20)
    }

    @Test func withoutSystemAudioTheMicIsLeftAsRecorded() {
        let mic = add(voice(4, pitch: 210, seed: 4), roomNoise(4))
        #expect(EchoGate.gate(mic: mic, system: []) == mic)
        #expect(EchoGate.gate(mic: mic, system: [Float](repeating: 0, count: mic.count)) == mic)
    }

    @Test func readsAWindowGatedWithTheAudioBeforeItAndAsRecordedWithoutASystemFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-gate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let micURL = dir.appendingPathComponent("mic.pcm")
        let systemURL = dir.appendingPathComponent("system.pcm")
        let system = voice(12, pitch: 120, seed: 1)
        let echo = throughTheSpeakers(system, lagMs: 120)
        for (url, samples) in [(micURL, add(echo, roomNoise(12))), (systemURL, system)] {
            let writer = try PcmWriter(url: url)
            try writer.append(samples)
            try writer.close()
        }
        let window = 10 * rate..<11 * rate
        let gated = try EchoGate.read(mic: micURL, system: systemURL, offset: window.lowerBound, count: window.count)
        #expect(gated.count == window.count)
        #expect(decibels(energy(gated[...]), over: energy(echo[window])) < -20)

        let missing = dir.appendingPathComponent("none.pcm")
        #expect(try EchoGate.read(mic: micURL, system: missing, offset: window.lowerBound, count: window.count)
            == PcmFile.read(at: micURL, offset: window.lowerBound, count: window.count))
    }
}
