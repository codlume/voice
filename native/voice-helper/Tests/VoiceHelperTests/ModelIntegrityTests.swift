import FluidAudio
import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

struct ModelIntegrityTests {
    @Test func theManifestCoversWhatFluidAudioLoads() {
        let parakeet = ModelManifest.parakeetV3
        let parakeetTop = Set(parakeet.files.map { $0.path.split(separator: "/").first.map(String.init)! })
        for required in ModelNames.ASR.requiredModelsV3() {
            #expect(parakeetTop.contains(required), Comment(rawValue: required))
            #expect(parakeet.files.contains { $0.path == "\(required)/coremldata.bin" }, Comment(rawValue: "\(required) has its bundle root"))
        }
        #expect(parakeet.files.contains { $0.path == ModelNames.ASR.vocabularyFile })
        #expect(parakeet.folderName == Repo.parakeetV3.folderName)
        #expect(parakeet.repository == Repo.parakeetV3.rawValue)
        #expect(Repo.parakeetV3.revision == "main", "FluidAudio pins Parakeet to main, which is why Voice must never write a commit marker there")
        #expect(parakeet.marker == nil)

        let diarizer = ModelManifest.diarizer
        let diarizerTop = Set(diarizer.files.map { $0.path.split(separator: "/").first.map(String.init)! })
        for required in ModelNames.OfflineDiarizer.requiredModels {
            #expect(diarizerTop.contains(required), Comment(rawValue: required))
        }
        #expect(diarizer.files.contains { $0.path == ModelNames.OfflineDiarizer.pldaParameters })
        #expect(diarizer.folderName == Repo.diarizer.folderName)
        #expect(diarizer.repository == Repo.diarizer.rawValue)
        #expect(diarizer.revision == Repo.diarizer.revision, "the marker Voice writes must be the revision FluidAudio's loader checks")
        #expect(diarizer.marker == ".fluidaudio-revision")
    }

    @Test @MainActor func anEmptyModelsDirIsMissing() async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-asr-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let transcriber = Transcriber(modelsDir: dir, output: output)
        transcriber.prepare(download: false)
        let status = try #require(try await lines.wait(for: "asr.status").last { $0["type"] as? String == "asr.status" })
        #expect(status["state"] as? String == "missing")
        #expect(transcriber.sessionState == .missing)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
    }

    @Test @MainActor func aDamagedCacheFailsWithTheMessageWithoutDownloading() async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-asr-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let folder = dir.appendingPathComponent(ModelManifest.parakeetV3.folderName)
        for file in ModelManifest.parakeetV3.files {
            let url = folder.appendingPathComponent(file.path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("x".utf8).write(to: url)
        }
        let transcriber = Transcriber(modelsDir: dir, output: output)
        transcriber.prepare(download: false)
        let events = try await lines.wait(for: "asr.status", timeout: .seconds(20)).filter { $0["type"] as? String == "asr.status" }
        let final = try await waitForTerminal(lines, timeout: .seconds(20))
        #expect(events.first?["state"] as? String == "loading", "files that stat as present start as a load, never a download")
        #expect(final["state"] as? String == "failed")
        #expect(final["message"] as? String == "The speech model is damaged: 21 files are missing or altered. Retry downloads only those files.")
        #expect(transcriber.sessionState == .failed)
        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent(ModelCache.stampName).path))
    }

    @Test @MainActor func aDictationThatWaitsOnAFailedLoadGetsTheMessage() async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-asr-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeSparse(ModelManifest.parakeetV3, in: dir)
        let transcriber = Transcriber(modelsDir: dir, output: output)
        transcriber.prepare(download: false)
        do {
            _ = try await transcriber.transcribe([0], language: .en, stream: nil, pauseDecode: nil)
            Issue.record("expected the load to fail")
        } catch let error as TranscribeError {
            #expect(error.message.contains("The speech model is damaged"), Comment(rawValue: error.message))
            #expect(!error.message.contains("ModelCacheError"))
        }
    }

    @Test @MainActor func theClassesThatLoadModelsLockFluidAudioOffline() {
        let output = Output(fd: FileHandle.nullDevice.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-asr-\(UUID().uuidString)")
        defer { ModelHub.offlineMode = true }
        ModelHub.offlineMode = false
        _ = Transcriber(modelsDir: dir, output: output)
        #expect(ModelHub.offlineMode)
        ModelHub.offlineMode = false
        _ = SpeakerDiarizer(modelsDir: dir, output: output)
        #expect(ModelHub.offlineMode)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15)) @MainActor
    func aDamagedDiarizerCacheFailsTheFinalPassAndThenOffersRetry() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-diarizer-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeSparse(ModelManifest.diarizer, in: dir)
        let diarizer = SpeakerDiarizer(modelsDir: dir, output: Output(fd: FileHandle.nullDevice.fileDescriptor))
        #expect(diarizer.state == .ready, "ready is a stat check until a run hashes the files")
        do {
            _ = try await diarizer.turns(in: dir.appendingPathComponent("system.pcm"))
            Issue.record("expected the final pass to stop")
        } catch let error as MeetingFinalizeError {
            #expect(error.reason == .speakerModels)
            #expect(error.message.contains("damaged"), Comment(rawValue: error.message))
        }
        #expect(diarizer.state == .failed)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15)) @MainActor
    func aBlockedDiarizerCacheSaysWhyInsteadOfNotDownloaded() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-diarizer-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeSparse(ModelManifest.diarizer, in: dir)
        try Data("{}".utf8).write(to: dir.appendingPathComponent("plda-parameters.json"))
        let diarizer = SpeakerDiarizer(modelsDir: dir, output: Output(fd: FileHandle.nullDevice.fileDescriptor))
        do {
            _ = try await diarizer.turns(in: dir.appendingPathComponent("system.pcm"))
            Issue.record("expected the final pass to stop")
        } catch let error as MeetingFinalizeError {
            #expect(error.reason == .speakerModels)
            #expect(error.message.contains("plda-parameters.json"), Comment(rawValue: error.message))
        }
    }

    @Test @MainActor func aMeetingDecodeThatWaitsOnAFailedLoadGetsTheMessage() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-asr-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeSparse(ModelManifest.parakeetV3, in: dir)
        let transcriber = Transcriber(modelsDir: dir, output: Output(fd: FileHandle.nullDevice.fileDescriptor))
        transcriber.prepare(download: false)
        do {
            _ = try await transcriber.decodeMeeting([0], language: .en)
            Issue.record("expected the load to fail")
        } catch let error as TranscribeError {
            #expect(error.message.contains("The speech model is damaged"), Comment(rawValue: error.message))
            #expect(!error.message.contains("ModelCacheError"), Comment(rawValue: error.message))
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15)) @MainActor
    func aDiarizerDownloadGoesThroughTheCache() async throws {
        let lines = EmittedLines()
        let output = Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-diarizer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data("{}".utf8).write(to: dir.appendingPathComponent("plda-parameters.json"))
        let diarizer = SpeakerDiarizer(modelsDir: dir, output: output)
        diarizer.download()
        let deadline = ContinuousClock.now + .seconds(20)
        while diarizer.state == .downloading, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        #expect(diarizer.state == .failed)
        var message = ""
        while message.isEmpty, ContinuousClock.now < deadline {
            message = lines.snapshot().last { $0["type"] as? String == "meeting.models.status" }?["message"] as? String ?? ""
            if message.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
        }
        #expect(message.hasPrefix("The speaker detection model cannot be used while plda-parameters.json"), Comment(rawValue: message))
    }

    /// Every file at its manifest size, all zeros: passes a stat check, fails every hash.
    private func writeSparse(_ release: ModelRelease, in dir: URL) throws {
        let folder = dir.appendingPathComponent(release.folderName)
        for file in release.files {
            let url = folder.appendingPathComponent(file.path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: url.path, contents: nil)
            #expect(truncate(url.path, file.size) == 0)
        }
    }

    private func waitForTerminal(_ lines: EmittedLines, timeout: Duration) async throws -> [String: Any] {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            let statuses = lines.snapshot().filter { $0["type"] as? String == "asr.status" }
            if let last = statuses.last, ["ready", "failed", "missing"].contains(last["state"] as? String ?? "") { return last }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw ProtocolError("no terminal asr.status within \(timeout)")
    }
}
