import AVFoundation
import Foundation
import Testing
import VoiceHelperCore
import XCTest
import os
@testable import VoiceHelper

@Suite(.serialized)
struct CaptureIdleTests {
    @Test @MainActor func idleWarmupKeepsMainFreeWhileThePermissionProbeRuns() async {
        let probing = XCTestExpectation(description: "the permission probe started")
        probing.assertForOverFulfill = false
        let probed = XCTestExpectation(description: "the permission probe ran")
        probed.assertForOverFulfill = false
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
            probing.fulfill()
            if !Thread.isMainThread {
                #expect(releaseProbe.wait(timeout: .now() + 5) == .success)
            }
            events.withLock { $0.append("probe done") }
            probed.fulfill()
            return .denied
        }

        capture.prepareIdleMic()
        #expect(await XCTWaiter.fulfillment(of: [probing], timeout: 5) == .completed)
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                events.withLock { $0.append("main block") }
                releaseProbe.signal()
                continuation.resume()
            }
        }
        #expect(await XCTWaiter.fulfillment(of: [probed], timeout: 5) == .completed)
        #expect(events.withLock { $0 } == ["main block", "probe done"])
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
