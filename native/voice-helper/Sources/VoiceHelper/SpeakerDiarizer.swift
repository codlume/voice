import FluidAudio
import Foundation
import VoiceHelperCore

/// Why a final pass stopped, with the reason main shows.
struct MeetingFinalizeError: Error {
    let reason: MeetingFinalizeFailure
    let message: String
}

/// Tells apart the voices in a meeting's system audio with FluidAudio's offline diarizer
/// (pyannote segmentation, WeSpeaker embeddings, VBx clustering). Its 21 MB of models download
/// into the models folder only on `meeting.models.download`, never during a final pass. They load
/// for each run and are released after it, so the memory a run takes is held only while it runs.
@MainActor
final class SpeakerDiarizer {
    private let directory: URL
    private let output: Output
    private var downloading: Task<Void, Never>?
    private var failure: String?

    init(modelsDir: URL, output: Output) {
        directory = modelsDir
        self.output = output
    }

    // macOS 14's BNNS bug can crash the offline diarizer (FluidAudio #878) and take dictation
    // down with the helper.
    private static var supported: Bool {
        ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15
    }

    var state: SpeakerModelsState {
        guard Self.supported else { return .unavailable }
        if downloading != nil { return .downloading }
        if modelsOnDisk { return .ready }
        return failure == nil ? .missing : .failed
    }

    func reportStatus() {
        let state = state
        output.emit(.meetingModelsStatus(state: state, message: state == .failed ? failure : nil))
    }

    func download() {
        guard state == .missing || state == .failed else { return reportStatus() }
        failure = nil
        let directory = directory
        downloading = Task { [weak self] in
            let failure = await Task.detached(priority: .utility) { () -> String? in
                do {
                    _ = try await OfflineDiarizerModels.load(from: directory)
                    return nil
                } catch {
                    return error.localizedDescription
                }
            }.value
            guard let self else { return }
            downloading = nil
            self.failure = failure ?? (modelsOnDisk ? nil : "the download ended without the models")
            if let message = self.failure { output.log(.error, "speaker detection download failed: \(message)") }
            reportStatus()
        }
        reportStatus()
    }

    /// Turns in ms from the start of the file, or nil on a Mac that cannot tell voices apart.
    func turns(in url: URL) async throws -> [SpeakerTurn]? {
        guard Self.supported else {
            output.log(.info, "meeting speakers left as one voice: diarization needs macOS 15")
            return nil
        }
        guard downloading == nil, modelsOnDisk else {
            throw MeetingFinalizeError(reason: .speakerModels, message: "speaker detection is not downloaded")
        }
        let directory = directory
        do {
            let result = try await Task.detached(priority: .utility) {
                let manager = OfflineDiarizerManager()
                manager.initialize(models: try await OfflineDiarizerModels.load(from: directory))
                return try await manager.process(audioSource: PcmSampleSource(url: url), audioLoadingSeconds: 0)
            }.value
            return result.segments.map {
                SpeakerTurn(speaker: $0.speakerId, startMs: Double($0.startTimeSeconds) * 1000, endMs: Double($0.endTimeSeconds) * 1000)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            output.log(.error, "meeting speaker detection failed: \(error.localizedDescription)")
            throw MeetingFinalizeError(reason: .speakers, message: error.localizedDescription)
        }
    }

    // What FluidAudio's loader accepts without fetching: every model file, from the revision
    // this FluidAudio pins.
    private var modelsOnDisk: Bool {
        let repo = directory.appendingPathComponent(Repo.diarizer.folderName)
        let marker = try? String(contentsOf: repo.appendingPathComponent(".fluidaudio-revision"), encoding: .utf8)
        return marker?.trimmingCharacters(in: .whitespacesAndNewlines) == Repo.diarizer.revision
            && ModelNames.OfflineDiarizer.requiredModels.allSatisfy {
                FileManager.default.fileExists(atPath: repo.appendingPathComponent($0).path)
            }
    }
}

/// A meeting's PCM file read on demand, so diarizing an hour does not hold it all in memory.
private struct PcmSampleSource: AudioSampleSource {
    let url: URL
    let sampleCount: Int

    init(url: URL) {
        self.url = url
        sampleCount = PcmFile.frames(at: url)
    }

    func copySamples(into destination: UnsafeMutablePointer<Float>, offset: Int, count: Int) throws {
        guard count > 0 else { return }
        let samples = try PcmFile.read(at: url, offset: max(0, offset), count: count)
        samples.withUnsafeBufferPointer { if let base = $0.baseAddress { destination.update(from: base, count: samples.count) } }
        if samples.count < count { (destination + samples.count).update(repeating: 0, count: count - samples.count) }
    }
}
