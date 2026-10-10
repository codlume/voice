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
        let probed = XCTestExpectation(description: "the permission probe ran")
        probed.assertForOverFulfill = false
        let events = OSAllocatedUnfairLock<[String]>(initialState: [])
        let onMain = OSAllocatedUnfairLock(initialState: false)
        let output = Output()
        let capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: URL(fileURLWithPath: "/nonexistent"), output: output),
            devices: AudioInputDevices(output: output)
        ) {
            onMain.withLock { $0 = $0 || Thread.isMainThread }
            Thread.sleep(forTimeInterval: 0.05)
            events.withLock { $0.append("probe done") }
            probed.fulfill()
            return .denied
        }

        capture.prepareIdleMic()
        let queuedAt = DispatchTime.now()
        let mainWaitMs = await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                events.withLock { $0.append("main block") }
                continuation.resume(returning: queuedAt.millisecondsToNow())
            }
        }
        #expect(await XCTWaiter.fulfillment(of: [probed], timeout: 2) == .completed)
        #expect(events.withLock { $0 } == ["main block", "probe done"], "main waited \(mainWaitMs) ms behind the idle warmup")
        #expect(!onMain.withLock { $0 })

        capture.start(id: "s1", language: .en, frontmostPid: nil, receivedAt: .now(), muteWhileDictating: false, microphone: nil)
        #expect(!capture.isActive, "a press never starts capture while the cache says not granted")
    }

    @Test @MainActor func fileModePressNeverAsksTCC() async throws {
        let probes = OSAllocatedUnfairLock(initialState: 0)
        let output = Output()
        let capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: URL(fileURLWithPath: "/nonexistent"), output: output),
            devices: AudioInputDevices(output: output)
        ) {
            probes.withLock { $0 += 1 }
            return .denied
        }
        capture.testAudioPath = try silentFixture()

        capture.start(id: "s1", language: .en, frontmostPid: nil, receivedAt: .now(), muteWhileDictating: false, microphone: nil)
        #expect(capture.isActive)
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
