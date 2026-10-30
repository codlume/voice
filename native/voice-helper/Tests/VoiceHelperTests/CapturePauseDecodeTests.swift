import Foundation
import Testing
import VoiceHelperCore
import os
@testable import VoiceHelper

/// Answers each pause decode with its ordinal, held open while `hold` is set, and the release
/// decode with "full decode" when no pause decode was handed to it.
@MainActor
private final class FakeTranscriber: Transcribing {
    var hold = false
    private(set) var decodes: [PauseDecode] = []
    private(set) var releases: [(samples: Int, reused: Bool)] = []
    private let gates = OSAllocatedUnfairLock<[CheckedContinuation<Void, Never>]>(initialState: [])

    func beginStreaming(language: DictationLanguage) -> StreamingTranscription? { nil }

    func decodeAhead(_ samples: [Float], language: DictationLanguage) -> PauseDecode? {
        let ordinal = decodes.count + 1
        let hold = hold
        let gates = gates
        let decode = PauseDecode {
            if hold {
                await withCheckedContinuation { continuation in gates.withLock { $0.append(continuation) } }
            }
            return "from pause \(ordinal)"
        }
        decodes.append(decode)
        return decode
    }

    func transcribe(
        _ samples: [Float], language: DictationLanguage, stream: StreamingTranscription?, pauseDecode: PauseDecode?
    ) async throws -> (text: String, asrMs: Double) {
        releases.append((samples.count, pauseDecode != nil))
        if let pauseDecode { return (try await pauseDecode.task.value, 0) }
        return ("full decode", 0)
    }

    func releaseHeldDecodes() {
        let held = gates.withLock { gates -> [CheckedContinuation<Void, Never>] in
            defer { gates.removeAll() }
            return gates
        }
        for gate in held { gate.resume() }
    }
}

@MainActor
private struct Harness {
    let lines = EmittedLines()
    let transcriber = FakeTranscriber()
    let capture: Capture
    let dir: URL
    let devices: AudioInputDevices

    init(segments: [(seconds: Double, silent: Bool)]) throws {
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("capture.caf")
        try writeAudio(to: file, segments: segments)
        devices = AudioInputDevices(output: output)
        capture = Capture(output: output, transcriber: transcriber, devices: devices,
                          outputLowering: OutputLowering(output: output, stateDir: dir), source: .fixture(file.path))
    }

    func start() {
        capture.start(id: "s1", language: .en, target: InsertTarget(pid: nil, bundleId: nil), receivedAt: .now(), outputVolumeScale: nil, microphone: nil)
    }

    func waitForAudioToEnd() async throws {
        try await waitUntil { lines.snapshot().contains { $0["message"] as? String == "test.audioFile ended" } }
    }

    func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition() {
            guard ContinuousClock.now < deadline else { throw ProtocolError("condition not met within 10 s") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    func transcriptText() async throws -> String {
        let transcript = try #require(sessionEvents(try await lines.wait(for: "transcript")).last)
        return try #require(transcript["text"] as? String)
    }

    func tearDown() {
        transcriber.releaseHeldDecodes()
        devices.shutdown()
        try? FileManager.default.removeItem(at: dir)
    }
}

@Suite(.serialized)
struct CapturePauseDecodeTests {
    @Test @MainActor func releaseAfterSilenceReusesThePauseDecode() async throws {
        let h = try Harness(segments: [(1, false), (0.5, true)])
        defer { h.tearDown() }
        h.start()
        try await h.waitForAudioToEnd()
        h.capture.stop(id: "s1", receivedAt: .now())
        #expect(try await h.transcriptText() == "from pause 1")
        #expect(h.transcriber.decodes.count == 1)
        #expect(h.transcriber.releases.map(\.reused) == [true])
    }

    @Test @MainActor func speechAfterThePauseDiscardsTheDecode() async throws {
        let h = try Harness(segments: [(1, false), (0.4, true), (0.3, false), (0.2, true)])
        defer { h.tearDown() }
        h.start()
        try await h.waitForAudioToEnd()
        h.capture.stop(id: "s1", receivedAt: .now())
        #expect(try await h.transcriptText() == "full decode")
        #expect(h.transcriber.decodes.count == 1)
        #expect(h.transcriber.decodes.first?.task.isCancelled == true)
        #expect(h.transcriber.releases.map(\.reused) == [false])
    }

    @Test @MainActor func aLaterPauseReplacesAFinishedDecode() async throws {
        let h = try Harness(segments: [(1, false), (0.4, true), (0.3, false), (0.4, true)])
        defer { h.tearDown() }
        h.start()
        try await h.waitForAudioToEnd()
        h.capture.stop(id: "s1", receivedAt: .now())
        #expect(try await h.transcriptText() == "from pause 2")
        #expect(h.transcriber.decodes.count == 2)
    }

    @Test @MainActor func noSecondDecodeStartsWhileOneRuns() async throws {
        let h = try Harness(segments: [(1, false), (0.4, true), (0.3, false), (0.5, true)])
        defer { h.tearDown() }
        h.transcriber.hold = true
        h.start()
        try await h.waitForAudioToEnd()
        #expect(h.transcriber.decodes.count == 1)
        #expect(h.transcriber.decodes.first?.finished == false)
        h.capture.stop(id: "s1", receivedAt: .now())
        #expect(try await h.transcriptText() == "full decode")
        #expect(h.transcriber.decodes.count == 1)
        #expect(h.transcriber.decodes.first?.task.isCancelled == true)
        #expect(h.transcriber.releases.map(\.reused) == [false])
    }

    @Test @MainActor func cancelCancelsThePendingDecode() async throws {
        let h = try Harness(segments: [(1, false), (0.5, true)])
        defer { h.tearDown() }
        h.transcriber.hold = true
        h.start()
        try await h.waitUntil { h.transcriber.decodes.count == 1 }
        h.capture.cancel(id: "s1")
        #expect(sessionEvents(try await h.lines.wait(for: "capture.cancelled")).last?["id"] as? String == "s1")
        #expect(h.transcriber.decodes.first?.task.isCancelled == true)
        #expect(h.transcriber.releases.isEmpty)
    }
}
