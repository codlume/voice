import Foundation
import Testing
import VoiceHelperCore
import os
@testable import VoiceHelper

private final class FakeMic: MeetingMic {
    private var sink: ((AudioChunk) -> Void)?
    private(set) var running = false

    func start(sink: @escaping (AudioChunk) -> Void) throws(CaptureError) {
        self.sink = sink
        running = true
    }

    func deliver(_ samples: [Float], at time: DispatchTime) {
        sink?(AudioChunk(samples: samples, capturedAt: time))
    }

    func finish() {}
    func dispose() { running = false }
}

private final class FakeTap: MeetingTap {
    private var sink: ((AudioChunk) -> Void)?
    private var heldFrom = DispatchTime.now()
    private(set) var formatChanged: () -> Void = {}
    private(set) var running = false
    let msSinceAudio = 0.0

    func start(sink: @escaping (AudioChunk) -> Void, onFormatChange: @escaping () -> Void) throws(CaptureError) {
        self.sink = sink
        formatChanged = onFormatChange
        running = true
    }

    func deliver(_ samples: [Float], at time: DispatchTime) {
        sink?(AudioChunk(samples: samples, capturedAt: time))
        heldFrom = time + .nanoseconds(samples.count * 1_000_000_000 / PcmFile.sampleRate)
    }

    /// Hands over the audio it still holds, captured right after what it last delivered, as
    /// `SystemAudioSource` does.
    func stop() {
        guard running else { return }
        running = false
        let deliver = sink
        sink = nil
        deliver?(AudioChunk(samples: [Float](repeating: 0.1, count: 1600), capturedAt: heldFrom))
    }
}

private final class FakeWriter: MeetingAudioWriter {
    private(set) var samples: [Float] = []
    var diskIsFull = false

    var frames: Int { samples.count }
    var firstLoudFrame: Int? { samples.firstIndex { abs($0) > 0.25 } }

    func append(_ samples: [Float]) throws {
        if diskIsFull { throw CocoaError(.fileWriteOutOfSpace) }
        self.samples += samples
    }

    func pad(to target: Int) throws {
        if target > frames { try append([Float](repeating: 0, count: target - frames)) }
    }

    func close() throws {}
}

private extension [Float] {
    static var quiet: [Float] { [Float](repeating: 0, count: 1600) }
    static var marked: [Float] { [Float](repeating: 0.5, count: 1600) }
}

/// A live leg on fakes: no microphone, no process tap, no TCC, no files.
@MainActor
private final class Leg {
    let mic = FakeMic()
    private(set) var taps: [FakeTap] = []
    private(set) var writers: [String: FakeWriter] = [:]
    private(set) var failures: [String] = []
    private(set) var losses: [AudioLoss] = []
    private var micChanged: (MeetingMic) -> Void = { _ in }
    private let lines = EmittedLines()
    private let devices: AudioInputDevices
    private(set) var capture: MeetingCapture!

    init(micAllowed: @escaping @Sendable () -> Bool = { true }, systemAllowed: @escaping @Sendable () -> Bool = { true }) {
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        devices = AudioInputDevices(output: output)
        let hardware = MeetingHardware(
            micAllowed: micAllowed, systemAllowed: systemAllowed,
            openMic: { [unowned self] _, _, onChange in
                micChanged = onChange
                return mic
            },
            openTap: { [unowned self] in
                let tap = FakeTap()
                taps.append(tap)
                return tap
            },
            openWriter: { [unowned self] url in
                let writer = FakeWriter()
                writers[url.lastPathComponent] = writer
                return writer
            })
        capture = MeetingCapture(
            dir: FileManager.default.temporaryDirectory.appendingPathComponent("voice-leg-\(UUID().uuidString)"),
            microphone: nil, source: .live, output: output, devices: devices, isCapturingDictation: { false },
            onFailed: { [unowned self] in failures.append($0) }, onLost: { [unowned self] in losses.append($0) },
            hardware: hardware)
    }

    var runningTaps: Int { taps.filter(\.running).count }

    func changeMicDevice() { micChanged(mic) }

    func end() {
        capture.stop()
        devices.shutdown()
    }
}

@MainActor
@Suite struct MeetingLegTests {
    @Test func aLegThatFailsWhileItsTapRestartsRecordsNoMoreSystemAudio() throws {
        let leg = Leg()
        defer { leg.end() }
        #expect(try leg.capture.start().system == .active)

        // The disk fills, then the tap's sample rate changes: the old tap's tail cannot be saved.
        leg.writers["system.pcm"]?.diskIsFull = true
        leg.taps[0].formatChanged()

        #expect(leg.failures.count == 1)
        #expect(leg.taps.count == 1, "a leg that ended opens no new tap")
        #expect(leg.runningTaps == 0)
        #expect(!leg.mic.running)
    }

    @Test func aTapRecreatedFourTimesInARowEndsTheLeg() throws {
        let leg = Leg()
        defer { leg.end() }
        _ = try leg.capture.start()

        for _ in 1...3 { leg.taps.last?.formatChanged() }
        #expect(leg.losses.isEmpty)
        #expect(leg.taps.count == 4)
        #expect(leg.runningTaps == 1)

        leg.taps.last?.formatChanged()
        #expect(leg.losses == [AudioLoss(source: .system, reason: .device)])
        #expect(leg.runningTaps == 0)
        #expect(!leg.mic.running)
    }

    @Test func audioCapturedAtOneMomentLandsAtOneFrameInBothFiles() throws {
        let leg = Leg()
        _ = try leg.capture.start()
        let t0 = leg.capture.startedAt
        // The mic records from the start; the tap's first audio was captured a second later, as
        // when creating the tap stalls on main.
        for k in 0..<20 {
            let at = t0 + .milliseconds(100 * k)
            leg.mic.deliver(k == 15 ? .marked : .quiet, at: at)
            if k >= 10 { leg.taps[0].deliver(k == 15 ? .marked : .quiet, at: at) }
        }
        leg.end()

        let mark = PcmFile.frames(milliseconds: 1500)
        #expect(leg.writers["mic.pcm"]?.firstLoudFrame == mark)
        #expect(leg.writers["system.pcm"]?.firstLoudFrame == mark)
    }

    @Test func aRemoteVoiceAndItsEchoInTheMicStayAsFarApartAsTheyWereCaptured() throws {
        let leg = Leg()
        _ = try leg.capture.start()
        let t0 = leg.capture.startedAt
        // The user says nothing. The consent prompt holds the tap for 20 s, the other side speaks
        // a second later, and the mic hears the speakers 40 ms after the tap does.
        let heardLate = PcmFile.frames(milliseconds: 40)
        let echo = [Float](repeating: 0, count: heardLate) + [Float](repeating: 0.5, count: 1600 - heardLate)
        for k in 0..<220 {
            let at = t0 + .milliseconds(100 * k)
            leg.mic.deliver(k == 210 ? echo : .quiet, at: at)
            if k >= 200 { leg.taps[0].deliver(k == 210 ? .marked : .quiet, at: at) }
        }
        leg.end()

        let theirs = try #require(leg.writers["system.pcm"]?.firstLoudFrame)
        let echoed = try #require(leg.writers["mic.pcm"]?.firstLoudFrame)
        #expect(echoed - theirs == heardLate, "the echo gate looks for the echo -100 to +600 ms after what played")
    }

    @Test func aMicThatReopensAfterADeviceChangeLeavesSilenceForTheTimeItWasAway() throws {
        let leg = Leg()
        _ = try leg.capture.start()
        let t0 = leg.capture.startedAt
        for k in 0..<10 { leg.mic.deliver(.quiet, at: t0 + .milliseconds(100 * k)) }

        leg.changeMicDevice()
        leg.mic.deliver(.marked, at: t0 + .seconds(3))
        leg.end()

        #expect(leg.writers["mic.pcm"]?.firstLoudFrame == PcmFile.frames(milliseconds: 3000))
    }

    @Test func aRestartedTapLeavesSilenceForTheTimeItRecordedNothing() throws {
        let leg = Leg()
        _ = try leg.capture.start()
        let t0 = leg.capture.startedAt
        for k in 0..<10 { leg.taps[0].deliver(.quiet, at: t0 + .milliseconds(100 * k)) }

        leg.taps[0].formatChanged()
        leg.taps[1].deliver(.marked, at: t0 + .seconds(3))
        leg.end()

        #expect(leg.writers["system.pcm"]?.firstLoudFrame == PcmFile.frames(milliseconds: 3000))
    }

    @Test func audioAfterADropLandsWhereItWasCaptured() throws {
        let leg = Leg()
        _ = try leg.capture.start()
        let t0 = leg.capture.startedAt
        // Main stalls for 20 s. The mic's pipeline keeps the first 10 s of it and drops the rest,
        // so the next chunk starts 10 s after the last one ended.
        leg.mic.deliver([Float](repeating: 0, count: 10 * PcmFile.sampleRate), at: t0)
        leg.mic.deliver(.marked, at: t0 + .seconds(20))
        leg.end()

        #expect(leg.writers["mic.pcm"]?.firstLoudFrame == PcmFile.frames(milliseconds: 20_000))
    }

    @Test func aChunkStampedLongBeforeTheFilesEndIsKeptWhole() throws {
        let leg = Leg()
        _ = try leg.capture.start()
        let t0 = leg.capture.startedAt
        for k in 0..<10 { leg.mic.deliver(.quiet, at: t0 + .milliseconds(100 * k)) }

        // Half a second behind is no clock drift. The timestamp is wrong, and the audio is the user's.
        leg.mic.deliver(.marked, at: t0 + .milliseconds(500))
        leg.end()

        let mic = try #require(leg.writers["mic.pcm"])
        #expect(mic.firstLoudFrame == PcmFile.frames(milliseconds: 1000))
        #expect(mic.samples.filter { $0 > 0.25 }.count == 1600)
    }

    @Test func theWatchAsksTCCOffMainAndARevokedMicrophoneStillEndsTheLeg() async throws {
        let events = OSAllocatedUnfairLock<[String]>(initialState: [])
        let watching = OSAllocatedUnfairLock(initialState: false)
        let askedOnMain = OSAllocatedUnfairLock(initialState: false)
        let mainRan = DispatchSemaphore(value: 0)
        let leg = Leg(micAllowed: {
            // Starting a leg asks once; from then on only the watch does.
            guard watching.withLock({ $0 }) else { return true }
            let firstTick = events.withLock { ticks in
                defer { ticks.append("the watch asked") }
                return ticks.isEmpty
            }
            guard firstTick else { return false }
            DispatchQueue.main.async {
                events.withLock { $0.append("main ran other work") }
                mainRan.signal()
            }
            // TCC is slow to answer. Off main the answer waits for main's other work; on main it
            // cannot, so there it takes the 200 ms that work would have waited.
            if Thread.isMainThread {
                askedOnMain.withLock { $0 = true }
                Thread.sleep(forTimeInterval: 0.2)
            } else {
                _ = mainRan.wait(timeout: .now() + 60)
            }
            events.withLock { $0.append("TCC answered: revoked") }
            return false
        }, systemAllowed: {
            if watching.withLock({ $0 }), Thread.isMainThread { askedOnMain.withLock { $0 = true } }
            return true
        })
        defer { leg.end() }
        _ = try leg.capture.start()
        watching.withLock { $0 = true }

        // The watch ticks every two seconds at utility QoS, and other tests keep main busy; the
        // order of the events is what this test asserts, not how soon they come.
        let deadline = ContinuousClock.now + .seconds(120)
        while leg.losses.isEmpty, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }

        #expect(leg.losses == [AudioLoss(source: .mic, reason: .permission)])
        #expect(!askedOnMain.withLock { $0 })
        #expect(Array(events.withLock { $0 }.prefix(3)) == ["the watch asked", "main ran other work", "TCC answered: revoked"])
        #expect(leg.runningTaps == 0)
    }
}
