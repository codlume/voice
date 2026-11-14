import Foundation
import Testing
import VoiceHelperCore
import os
@testable import VoiceHelper

private final class FakeMic: MeetingMic {
    private(set) var running = false

    func start(sink: @escaping ([Float]) -> Void) throws(CaptureError) { running = true }
    func finish() {}
    func dispose() { running = false }
}

private final class FakeTap: MeetingTap {
    private var sink: (([Float]) -> Void)?
    private(set) var formatChanged: () -> Void = {}
    private(set) var running = false
    let msSinceAudio = 0.0

    func start(sink: @escaping ([Float]) -> Void, onFormatChange: @escaping () -> Void) throws(CaptureError) {
        self.sink = sink
        formatChanged = onFormatChange
        running = true
    }

    /// Hands over the audio it still holds, as `SystemAudioSource` does.
    func stop() {
        guard running else { return }
        running = false
        let deliver = sink
        sink = nil
        deliver?([Float](repeating: 0.1, count: 1600))
    }
}

private final class FakeWriter: MeetingAudioWriter {
    private(set) var frames = 0
    var diskIsFull = false

    func append(_ samples: [Float]) throws {
        if diskIsFull { throw CocoaError(.fileWriteOutOfSpace) }
        frames += samples.count
    }

    func pad(to target: Int) throws {
        if target > frames { try append([Float](repeating: 0, count: target - frames)) }
    }

    func close() throws {}
}

/// A live leg on fakes: no microphone, no process tap, no TCC, no files.
@MainActor
private final class Leg {
    let mic = FakeMic()
    private(set) var taps: [FakeTap] = []
    private(set) var writers: [String: FakeWriter] = [:]
    private(set) var failures: [String] = []
    private(set) var losses: [AudioLoss] = []
    private let lines = EmittedLines()
    private let devices: AudioInputDevices
    private(set) var capture: MeetingCapture!

    init(micAllowed: @escaping @Sendable () -> Bool = { true }, systemAllowed: @escaping @Sendable () -> Bool = { true }) {
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        devices = AudioInputDevices(output: output)
        let hardware = MeetingHardware(
            micAllowed: micAllowed, systemAllowed: systemAllowed,
            openMic: { [mic] _, _, _ in mic },
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
