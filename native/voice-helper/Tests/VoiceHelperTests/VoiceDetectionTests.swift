import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

@MainActor
struct VoiceDetectionTests {
    let lines = EmittedLines()
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-detector-\(UUID().uuidString)")

    private func logs() -> [String] {
        lines.snapshot().filter { $0["type"] as? String == "log" }.compactMap { $0["message"] as? String }
    }

    private func logged(_ prefix: String) async throws -> String {
        let deadline = ContinuousClock.now + .seconds(20)
        while true {
            if let message = logs().first(where: { $0.hasPrefix(prefix) }) { return message }
            guard ContinuousClock.now < deadline else { throw ProtocolError("no log starting \(prefix): \(logs())") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    @Test func aModelNobodyPreparedGivesNoDetectorAndTouchesNothing() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let detection = VoiceDetection(modelsDir: dir, output: Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor))
        #expect(await detection.detector() == nil)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
    }

    /// A file where the model's folder belongs is not Voice's to replace, so nothing is fetched.
    @Test func aModelThatCannotBeUsedGivesNoDetectorAndSaysWhy() async throws {
        defer { try? FileManager.default.removeItem(at: dir) }
        let folder = dir.appendingPathComponent(ModelManifest.voiceDetector.folderName)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let squatter = try #require(ModelManifest.voiceDetector.files.first?.path.split(separator: "/").first.map(String.init))
        try Data("x".utf8).write(to: folder.appendingPathComponent(squatter))
        let detection = VoiceDetection(modelsDir: dir, output: Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor))
        detection.prepare()
        let message = try await logged("voice detector unavailable")
        #expect(message.contains("The voice detector cannot be used while"), Comment(rawValue: message))
        #expect(await detection.detector() == nil)
        #expect(lines.snapshot().allSatisfy { $0["type"] as? String == "log" }, "the detector has no status of its own")

        detection.remove()
        #expect(!FileManager.default.fileExists(atPath: folder.path), "it goes when the speech model goes")
    }
}

/// With the real model, where the smoke scripts' models folder holds it (scripts/helper.mjs
/// `modelsDir`).
@MainActor
struct SileroDetectorTests {
    private static let models = URL(
        fileURLWithPath: ProcessInfo.processInfo.environment["VOICE_TEST_MODELS_DIR"]
            ?? NSHomeDirectory() + "/Library/Caches/Voice Development/test-models")
    private static let installed = ModelManifest.voiceDetector.files.allSatisfy {
        FileManager.default.fileExists(atPath: models.appendingPathComponent(ModelManifest.voiceDetector.folderName).appendingPathComponent($0.path).path)
    }

    /// Seeded noise that swells and fades, so the model's memory has something to carry.
    private func sound(seconds: Double, seed: UInt64) -> [Float] {
        var state = seed
        return (0..<Int(seconds * 16_000)).map { index in
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            let noise = Float(state >> 40) / Float(1 << 24) - 0.5
            return 0.2 * noise * (0.5 + 0.5 * sin(Float(index) * 2 * .pi / 16_000))
        }
    }

    private func detector() async throws -> any VoiceDetector {
        let detection = VoiceDetection(modelsDir: Self.models, output: Output(fd: FileHandle.nullDevice.fileDescriptor))
        detection.prepare()
        return try #require(await detection.detector())
    }

    // The passes rely on this: a partial hears audio ahead of its window and a failed decode
    // hears a window twice, and neither may change what the detector says afterwards.
    @Test(.enabled(if: installed, "needs the voice detector, which the smoke scripts download"))
    func hearingLeavesTheDetectorItWasAskedOfAsItWas() async throws {
        let new = try await detector()
        let first = sound(seconds: 3.3, seed: 1)
        let second = sound(seconds: 2.1, seed: 2)
        let afterFirst = try #require(await new.hear(first))
        #expect(afterFirst.probabilities.count == 13, "one score per 256 ms chunk, the short last one included")

        let ahead = try #require(await afterFirst.next.hear(second))
        let again = try #require(await afterFirst.next.hear(second))
        #expect(ahead.probabilities == again.probabilities)

        let cold = try #require(await new.hear(second))
        #expect(cold.probabilities != ahead.probabilities, "what it heard before changes what it says, so the comparison above can see a change")
        let firstAgain = try #require(await new.hear(first))
        #expect(firstAgain.probabilities == afterFirst.probabilities)
    }
}
