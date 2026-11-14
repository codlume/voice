import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

@Suite(.serialized)
struct CaptureHotkeyUptimeTests {
    /// Main echoes the helper's own clock, which is never negative. A command that carries
    /// anything else is a session without a press, not a reason to stop the helper.
    @Test(arguments: [-1e300, -1])
    @MainActor func aHotkeyUptimeNoPressCouldProduceStartsASessionWithoutARelay(hotkeyUptimeMs: Double) async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("capture.caf")
        try writeAudio(to: file, seconds: 1, silent: true)
        let devices = AudioInputDevices(output: output)
        defer { devices.shutdown() }
        let capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: dir.appendingPathComponent("no-models"), output: output),
            devices: devices, outputLowering: OutputLowering(output: output, stateDir: dir), source: .fixture(file.path))

        let receivedAt = DispatchTime.now()
        capture.start(id: "s1", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: receivedAt,
                      hotkeyUptimeMs: hotkeyUptimeMs, outputVolumeScale: nil, microphone: nil)
        let started = try #require(sessionEvents(try await lines.wait(for: "capture.started")).last)
        #expect(started["relayMs"] is NSNull)
        #expect(try #require(started["startMs"] as? Double) <= milliseconds(from: receivedAt, to: .now()))

        capture.stop(id: "s1", receivedAt: .now(), hotkeyUptimeMs: hotkeyUptimeMs)
        let transcript = try #require(sessionEvents(try await lines.wait(for: "transcript")).last)
        #expect(transcript["relayMs"] is NSNull)
    }
}
