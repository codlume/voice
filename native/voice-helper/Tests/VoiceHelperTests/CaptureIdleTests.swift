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
        let probe = OSAllocatedUnfairLock(initialState: (calls: 0, onMain: false))
        let output = Output()
        let capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: URL(fileURLWithPath: "/nonexistent"), output: output),
            devices: AudioInputDevices(output: output)
        ) {
            probe.withLock {
                $0.calls += 1
                $0.onMain = $0.onMain || Thread.isMainThread
            }
            Thread.sleep(forTimeInterval: 0.05)
            probed.fulfill()
            return .denied
        }

        capture.prepareIdleMic()
        let queuedAt = DispatchTime.now()
        let mainWaitMs = await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume(returning: queuedAt.millisecondsToNow()) }
        }
        #expect(await XCTWaiter.fulfillment(of: [probed], timeout: 2) == .completed)
        #expect(mainWaitMs < 20, "main was blocked \(mainWaitMs) ms behind the idle warmup")
        #expect(probe.withLock { $0.calls } == 1)
        #expect(!probe.withLock { $0.onMain })

        capture.start(id: "s1", language: .en, frontmostPid: nil, receivedAt: .now(), muteWhileDictating: false, microphone: nil)
        #expect(!capture.isActive, "a press never starts capture while microphone access is denied")
    }
}
