import Foundation
import Testing
import VoiceHelperCore
import XCTest
@testable import VoiceHelper

@Suite(.serialized)
struct CaptureSourceTests {
    @Test func testModeNeverResolvesToTheMicrophone() {
        #expect(CaptureSource.resolve(environment: [:]) == .microphone)
        #expect(CaptureSource.resolve(environment: ["VOICE_HELPER_TEST_AUDIO": "/fixture.wav"]) == .microphone)
        #expect(CaptureSource.resolve(environment: ["VOICE_HELPER_TEST": "1"]) == .disabled)
        #expect(CaptureSource.resolve(environment: ["VOICE_HELPER_TEST": "1", "VOICE_HELPER_TEST_AUDIO": ""]) == .disabled)
        #expect(CaptureSource.resolve(environment: ["VOICE_HELPER_TEST": "1", "VOICE_HELPER_TEST_AUDIO": "/missing.wav"]) == .fixture("/missing.wav"))
    }

    @Test(arguments: [CaptureSource.disabled, .fixture("/nonexistent/voice-test.wav")])
    @MainActor func unavailableTestAudioNeverProbesMicrophone(source: CaptureSource) async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let devices = AudioInputDevices(output: output)
        defer { devices.shutdown() }
        let probe = XCTestExpectation(description: "test capture must not query microphone permission")
        probe.isInverted = true
        let capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: URL(fileURLWithPath: "/nonexistent"), output: output),
            devices: devices,
            outputSilencer: OutputSilencer(output: output, stateDir: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
            source: source
        ) {
            probe.fulfill()
            return .denied
        }
        defer { capture.shutdown() }

        capture.prepareIdleMic()
        capture.configure(microphone: nil)
        #expect(!capture.start(id: "s1", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: .now(), outputVolumeScale: nil, microphone: nil))
        capture.startTest(id: "m1", microphone: nil)
        let events = try await lines.wait(for: "microphone.test.failed")
        #expect(events.contains { $0["type"] as? String == "capture.failed" })
        #expect(!events.contains { ["capture.started", "microphone.test.started"].contains($0["type"] as? String ?? "") })
        #expect(!capture.isActive)

        capture.testAudioPath = nil
        #expect(capture.source == .disabled)
        capture.prepareIdleMic()
        #expect(!capture.start(id: "s2", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: .now(), outputVolumeScale: nil, microphone: nil))
        capture.startTest(id: "m2", microphone: nil)
        #expect(await XCTWaiter.fulfillment(of: [probe], timeout: 0.1) == .completed)
    }

    @Test @MainActor func sourceCannotChangeWhileCaptureOrMicrophoneTestIsActive() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = dir.appendingPathComponent("silence.caf")
        try writeAudio(to: fixture, seconds: 1, silent: true)
        let output = Output()
        let devices = AudioInputDevices(output: output)
        defer { devices.shutdown() }
        let capture = Capture(output: output, transcriber: Transcriber(modelsDir: dir, output: output), devices: devices,
                              outputSilencer: OutputSilencer(output: output, stateDir: dir), source: .fixture(fixture.path)) {
            Issue.record("fixture capture must not query microphone permission")
            return .denied
        }
        defer { capture.shutdown() }
        #expect(capture.start(id: "s1", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: .now(), outputVolumeScale: nil, microphone: nil))
        capture.testAudioPath = nil
        #expect(capture.source == .fixture(fixture.path))
        capture.cancel(id: "s1")
        capture.startTest(id: "m1", microphone: nil)
        capture.testAudioPath = "/missing.wav"
        #expect(capture.source == .fixture(fixture.path))
        capture.stopTest(id: "m1")
        capture.testAudioPath = nil
        #expect(capture.source == .disabled)
    }
}
