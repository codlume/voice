import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

private let fileSamples = 16_000

@MainActor
private final class SilentCapture {
    let lines = EmittedLines()
    let output: Output
    let dir: URL
    let devices: AudioInputDevices
    let capture: Capture
    let insertion: Insertion

    init() throws {
        output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("capture.caf")
        try writeAudio(to: file, seconds: Double(fileSamples) / asrSampleRate, silent: true)
        devices = AudioInputDevices(output: output)
        capture = Capture(
            output: output, transcriber: Transcriber(modelsDir: dir.appendingPathComponent("no-models"), output: output),
            devices: devices, outputLowering: OutputLowering(output: output, stateDir: dir), maxSamples: fileSamples / 4,
            source: .fixture(file.path))
        insertion = Insertion(output: output, forcePaste: false, pasteboard: Pasteboard(output: output))
    }

    func start(_ target: InsertTarget) {
        capture.start(id: "s1", language: .en, target: target, receivedAt: .now(), outputVolumeScale: nil, microphone: nil)
    }

    func transcript() async throws -> [String: Any] {
        let events = try await lines.wait(for: "transcript")
        return try #require(events.first { $0["type"] as? String == "transcript" })
    }

    func close() {
        devices.shutdown()
        try? FileManager.default.removeItem(at: dir)
    }
}

@Suite(.serialized)
struct TranscriptTargetTests {
    @Test(arguments: [
        (seed: .read("mail.google.com"), host: "mail.google.com"),
        (seed: .read(nil), host: nil),
        (seed: .pending, host: nil),
    ] as [(seed: HostRead, host: String?)])
    @MainActor func reportsTheHostTheSessionStartedWith(seed: HostRead, host: String?) async throws {
        let harness = try SilentCapture()
        defer { harness.close() }
        let target = harness.insertion.recordTarget(pid: nil, bundleId: "com.google.Chrome", host: seed, log: nil)

        harness.start(target)
        let reported = try #require(try await harness.transcript()["target"] as? [String: Any])

        #expect(reported["bundleId"] as? String == "com.google.Chrome")
        #expect(reported["host"] as? String == host)
        #expect(reported["host"] != nil, "the host key is on the wire as null, not missing")
    }

    @Test(arguments: [nil, "capture.started"])
    @MainActor func cancellingASessionEndsItsHostRead(after event: String?) async throws {
        let harness = try SilentCapture()
        defer { harness.close() }
        let target = InsertTarget(pid: nil, bundleId: "com.google.Chrome")

        harness.start(target)
        if let event { _ = try await harness.lines.wait(for: event) }
        harness.capture.cancel(id: "s1")

        #expect(target.host.withLock { $0 } == .read(nil))
    }

    @Test @MainActor func shuttingDownEndsTheSessionsHostRead() async throws {
        let harness = try SilentCapture()
        defer { harness.close() }
        let target = InsertTarget(pid: nil, bundleId: "com.google.Chrome")

        harness.start(target)
        _ = try await harness.lines.wait(for: "capture.started")
        harness.capture.shutdown()

        #expect(target.host.withLock { $0 } == .read(nil))
    }
}
