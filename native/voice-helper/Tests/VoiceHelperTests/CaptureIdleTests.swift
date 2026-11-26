import AVFoundation
import Foundation
import Testing
import VoiceHelperCore
import os
@testable import VoiceHelper

@Suite(.serialized)
struct CaptureIdleTests {
    @Test @MainActor func idleWarmupKeepsMainFreeWhileThePermissionProbeRuns() async throws {
        let (probeRuns, probeRan) = AsyncStream<Void>.makeStream()
        let releaseProbe = DispatchSemaphore(value: 0)
        defer { releaseProbe.signal() }
        let events = OSAllocatedUnfairLock<[String]>(initialState: [])
        let onMain = OSAllocatedUnfairLock(initialState: false)
        let output = Output()
        let capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: URL(fileURLWithPath: "/nonexistent"), output: output),
            devices: AudioInputDevices(output: output),
            outputLowering: OutputLowering(output: output, stateDir: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
            source: .microphone
        ) {
            onMain.withLock { $0 = $0 || Thread.isMainThread }
            // Bounded so a warmup that holds main until the probe returns fails the order below instead of deadlocking.
            if !Thread.isMainThread { _ = releaseProbe.wait(timeout: .now() + 5) }
            events.withLock { $0.append("probe done") }
            probeRan.yield()
            return .denied
        }

        // Main releases the probe before it suspends, so no other test can hold main while the probe waits.
        capture.prepareIdleMic()
        events.withLock { $0.append("warmup returned") }
        releaseProbe.signal()
        // The bound only stops a probe that never runs from hanging the run; a loaded run takes under 2 s.
        let probeRanInTime = await withTaskGroup(of: Bool.self) { group in
            group.addTask { for await _ in probeRuns { return true }; return false }
            group.addTask { try? await Task.sleep(for: .seconds(30)); return false }
            defer { group.cancelAll() }
            return await group.next() ?? false
        }
        try #require(probeRanInTime, "the permission probe never ran within 30 s")
        #expect(events.withLock { $0 } == ["warmup returned", "probe done"])
        #expect(!onMain.withLock { $0 })

        #expect(!capture.start(id: "s1", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: .now(), outputVolumeScale: nil, microphone: nil))
        #expect(!capture.isActive, "a press never starts capture while the cache says not granted")
    }

    @Test @MainActor func fileModePressNeverAsksTCC() async throws {
        let probes = OSAllocatedUnfairLock(initialState: 0)
        let output = Output()
        let capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: URL(fileURLWithPath: "/nonexistent"), output: output),
            devices: AudioInputDevices(output: output),
            outputLowering: OutputLowering(output: output, stateDir: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
            source: .fixture(try silentFixture())
        ) {
            probes.withLock { $0 += 1 }
            return .denied
        }

        #expect(capture.start(id: "s1", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: .now(), outputVolumeScale: nil, microphone: nil))
        #expect(capture.isActive)
        #expect(!capture.start(id: "s2", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: .now(), outputVolumeScale: nil, microphone: nil),
                "a press during another session starts nothing")
        capture.cancel(id: "s1")
        capture.configure(microphone: nil)
        try await Task.sleep(for: .milliseconds(100))
        #expect(probes.withLock { $0 } == 0)
    }

    private func silentFixture() throws -> String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("capture-idle-\(UUID().uuidString).wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
        buffer.frameLength = 4800
        try file.write(from: buffer)
        return url.path
    }
}
