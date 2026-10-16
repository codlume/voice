import AVFoundation
import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

@Suite(.serialized)
struct CaptureStopTests {
    @Test(arguments: [(audio: "silence", terminal: "transcript"), (audio: "tone with no model", terminal: "transcript.failed")])
    @MainActor func reportsTheDurationCapBeforeTheCaptureEnds(audio: String, terminal: String) async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("capture.caf")
        try writeAudio(to: file, seconds: 1, silent: audio == "silence")
        let devices = AudioInputDevices(output: output)
        defer { devices.shutdown() }
        let noModels = dir.appendingPathComponent("no-models")
        let capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: noModels, output: output), devices: devices,
            outputSilencer: OutputSilencer(output: output, stateDir: dir), maxSamples: 4800)
        capture.testAudioPath = file.path

        let target = InsertTarget(pid: nil, bundleId: nil)
        capture.start(id: "s1", language: .en, target: target, receivedAt: .now(), muteWhileDictating: false, microphone: nil)
        let events = sessionEvents(try await lines.wait(for: terminal))

        #expect(events.map { $0["type"] as? String } == ["capture.started", "capture.stopped", terminal])
        #expect(events[1]["id"] as? String == "s1")
        #expect(events[1]["reason"] as? String == "maxDuration")
        #expect(!capture.isActive)
        #expect(capture.takeLastTarget(id: "another-session") == nil)
        #expect(capture.takeLastTarget(id: "s1") == nil)
        #expect(capture.lastTarget == nil)

        capture.stop(id: "s1")
        try await Task.sleep(for: .milliseconds(300))
        #expect(sessionEvents(lines.snapshot()).count == events.count)
    }
}
