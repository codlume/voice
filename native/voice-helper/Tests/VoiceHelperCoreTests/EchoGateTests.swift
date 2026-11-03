import Accelerate
import Foundation
import Testing
@testable import VoiceHelperCore

private let rate = 16_000

/// A voice-like signal from `start` to `end` seconds of a `seconds`-long track: a harmonic
/// series on a gliding pitch, in syllables or held steady, with a timbre fixed by `seed`.
/// Built with Accelerate because a debug build of the per-sample loop slowed CI's test run.
private func voice(_ seconds: Double, from start: Double = 0, to end: Double? = nil, pitch: Float, seed: Float, level: Float = 0.2, syllables: Bool = true) -> [Float] {
    let count = Int(seconds * Double(rate))
    let twoPi = 2 * Float.pi
    let t = vDSP.multiply(1 / Float(rate), vDSP.ramp(withInitialValue: Float(0), increment: 1, count: count))
    let glide = vDSP.add(1, vDSP.multiply(0.12, vForce.sin(vDSP.add(seed, vDSP.multiply(twoPi * 0.7, t)))))
    var phase = vDSP.multiply(twoPi * pitch / Float(rate), glide)
    for n in phase.indices.dropFirst() { phase[n] += phase[n - 1] }
    var tone = [Float](repeating: 0, count: count)
    for k in 1...14 {
        let harmonic = Float(k)
        let timbre: Float = 1 + 0.6 * sin(harmonic * seed)
        tone = vDSP.add(tone, vDSP.multiply(timbre / harmonic, vForce.sin(vDSP.multiply(harmonic, phase))))
    }
    let syllable = syllables
        ? vDSP.threshold(vForce.sin(vDSP.add(seed, vDSP.multiply(twoPi * 3.3, t))), to: 0, with: .zeroFill)
        : [Float](repeating: 0.7, count: count)
    var out = vDSP.multiply(level / 2, vDSP.multiply(syllable, tone))
    let first = min(count, max(0, Int((start * Double(rate)).rounded(.up))))
    let last = min(count, max(first, Int(((end ?? seconds) * Double(rate)).rounded(.up))))
    out.replaceSubrange(0..<first, with: repeatElement(0, count: first))
    out.replaceSubrange(last..<count, with: repeatElement(0, count: count - last))
    return out
}

/// What the mic hears of `played`: `lagMs` later, the direct path at `gain` (18 dB down on a
/// laptop), with a short room tail.
private func throughTheSpeakers(_ played: [Float], lagMs: Double, gain: Float = 0.12) -> [Float] {
    let lag = Int(lagMs * Double(rate) / 1000)
    let taps: [(delay: Int, gain: Float)] = [(0, 1), (48, 1 / 3), (160, -5 / 24), (900, 1 / 12)]
    var out = [Float](repeating: 0, count: played.count)
    for tap in taps {
        let shift = lag + tap.delay
        let from = max(0, shift)
        let source = max(0, -shift)
        let length = min(played.count - from, played.count - source)
        guard length > 0 else { continue }
        let echoed = vDSP.multiply(gain * tap.gain, played[source..<source + length])
        out.replaceSubrange(from..<from + length, with: vDSP.add(out[from..<from + length], echoed))
    }
    return out
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

private func meetingDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-gate-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private func record(mic: [Float], system: [Float], in dir: URL) throws -> (mic: URL, system: URL) {
    let urls = (mic: dir.appendingPathComponent("mic.pcm"), system: dir.appendingPathComponent("system.pcm"))
    for (url, samples) in [(urls.mic, mic), (urls.system, system)] {
        let writer = try PcmWriter(url: url)
        try writer.append(samples)
        try writer.close()
    }
    return urls
}

@Suite(.serialized) struct EchoGateTests {
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

    @Test func theEchoStaysMutedWhenItsLagMovesMidCall() throws {
        let dir = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let system = voice(28, pitch: 120, seed: 1)
        let moveAt = EchoGate.blockSamples
        let echo = zip(throughTheSpeakers(system, lagMs: 80), throughTheSpeakers(system, lagMs: 300)).enumerated()
            .map { $0.offset < moveAt ? $0.element.0 : $0.element.1 }
        let (micURL, systemURL) = try record(mic: add(echo, roomNoise(28)), system: system, in: dir)
        let gated = try EchoGate.read(mic: micURL, system: systemURL, offset: 0, count: system.count)
        let before = 1.0...13.0
        let after = Double(moveAt) / Double(rate) + 1...27.0
        #expect(decibels(energy(seconds(gated, before)), over: energy(seconds(echo, before))) < -20)
        #expect(decibels(energy(seconds(gated, after)), over: energy(seconds(echo, after))) < -20, "a block after the move, the gate has the new lag")
    }

    @Test func readsAWindowGatedWithTheAudioBeforeItAndAsRecordedWithoutASystemFile() throws {
        let dir = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let system = voice(12, pitch: 120, seed: 1)
        let echo = throughTheSpeakers(system, lagMs: 120)
        let (micURL, systemURL) = try record(mic: add(echo, roomNoise(12)), system: system, in: dir)
        let window = 10 * rate..<11 * rate
        let gated = try EchoGate.read(mic: micURL, system: systemURL, offset: window.lowerBound, count: window.count)
        #expect(gated.count == window.count)
        #expect(decibels(energy(gated[...]), over: energy(echo[window])) < -20)

        let missing = dir.appendingPathComponent("none.pcm")
        #expect(try EchoGate.read(mic: micURL, system: missing, offset: window.lowerBound, count: window.count)
            == PcmFile.read(at: micURL, offset: window.lowerBound, count: window.count))
    }

    @Test func aBlockWithNoSpeechIsLeftAsRecordedWhileTheNextOneIsGated() throws {
        let dir = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let system = voice(28, pitch: 120, seed: 1)
        let echo = [Float](repeating: 0, count: EchoGate.blockSamples) + throughTheSpeakers(system, lagMs: 120).dropFirst(EchoGate.blockSamples)
        let (micURL, systemURL) = try record(mic: add(echo, roomNoise(28)), system: system, in: dir)
        let gated = try EchoGate.read(mic: micURL, system: systemURL, offset: 0, count: system.count)
        #expect(gated[..<EchoGate.blockSamples] == (try PcmFile.read(at: micURL, offset: 0, count: EchoGate.blockSamples))[...],
                "the gate never runs on a quiet block")
        let second = Double(EchoGate.blockSamples) / Double(rate) + 1...27.0
        #expect(decibels(energy(seconds(gated, second)), over: energy(seconds(echo, second))) < -20)
    }

    @Test func readingPastTheEndOfTheMicFileReturnsWhatIsThere() throws {
        let dir = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let system = voice(3, pitch: 120, seed: 1)
        let (micURL, systemURL) = try record(mic: throughTheSpeakers(system, lagMs: 120), system: system, in: dir)
        #expect(try EchoGate.read(mic: micURL, system: systemURL, offset: 2 * rate, count: 2 * rate).count == rate)
        #expect(try EchoGate.read(mic: micURL, system: systemURL, offset: 5 * rate, count: rate).isEmpty)
        #expect(try EchoGate.read(mic: micURL, system: systemURL, offset: 0, count: 40 * rate).count == 3 * rate)
        #expect(try EchoGate.read(mic: micURL, system: systemURL, offset: 0, count: 0).isEmpty)
    }

    @Test func aSystemFileThatCannotBeReadIsAnErrorNotAnUngatedMic() throws {
        let dir = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let system = voice(3, pitch: 120, seed: 1)
        let (micURL, systemURL) = try record(mic: throughTheSpeakers(system, lagMs: 120), system: system, in: dir)
        _ = try EchoGate.read(mic: micURL, system: systemURL, offset: 0, count: 3 * rate)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: systemURL.path)
        #expect(throws: (any Error).self) { try EchoGate.read(mic: micURL, system: systemURL, offset: 0, count: 3 * rate) }
    }
}
