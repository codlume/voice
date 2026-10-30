import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

@Suite(.serialized)
struct CaptureRelayTests {
    @Test @MainActor func countsStartFromThePressAndReportsBothHopsThroughMain() async throws {
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

        let pressedAt = DispatchTime.now().uptimeMs
        try await Task.sleep(for: .milliseconds(30))
        capture.start(id: "s1", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: .now(), hotkeyUptimeMs: pressedAt,
                      outputVolumeScale: nil, microphone: nil)
        let started = try #require(sessionEvents(try await lines.wait(for: "capture.started")).last)
        let startMs = try #require(started["startMs"] as? Double)
        let pressRelayMs = try #require(started["relayMs"] as? Double)
        #expect(pressRelayMs >= 30)
        #expect(pressRelayMs < 1000)
        #expect(startMs >= pressRelayMs)

        let releasedAt = DispatchTime.now().uptimeMs
        try await Task.sleep(for: .milliseconds(20))
        capture.stop(id: "s1", receivedAt: .now(), hotkeyUptimeMs: releasedAt)
        let transcript = try #require(sessionEvents(try await lines.wait(for: "transcript")).last)
        let releaseRelayMs = try #require(transcript["relayMs"] as? Double)
        #expect(releaseRelayMs >= 20)
        #expect(releaseRelayMs < 1000)
    }

    /// A command without a hotkey echo, and one echoing a time after the command arrived.
    @Test(arguments: [Double?.none, DispatchTime.now().uptimeMs + 60_000])
    @MainActor func reportsNoRelayWithoutAPressThatStartedTheSession(hotkeyUptimeMs: Double?) async throws {
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
