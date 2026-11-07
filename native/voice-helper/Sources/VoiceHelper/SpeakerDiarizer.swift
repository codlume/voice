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
    private let cache: ModelCache
    private let fetcher: ModelFetcher
    private let output: Output
    private var downloading: Task<Void, Never>?
    private var failure: String?

    init(modelsDir: URL, output: Output) {
        // FluidAudio must never list, purge or fetch: bytes reach a load only through `cache`.
        ModelHub.offlineMode = true
        directory = modelsDir
        cache = ModelCache(release: ModelManifest.diarizer, modelsDirectory: modelsDir)
        fetcher = ModelFetcher(configuration: ModelHub.session.configuration)
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
        if failure != nil { return .failed }
        return modelFilesPresent ? .ready : .missing
    }

    func reportStatus() {
        let state = state
        output.emit(.meetingModelsStatus(state: state, message: state == .failed ? failure : nil))
    }

    func download() {
        guard state == .missing || state == .failed else { return reportStatus() }
        failure = nil
        let directory = directory
        let cache = cache
        let fetcher = fetcher
        let output = output
        downloading = Task { [weak self] in
            let failure = await Task.detached(priority: .utility) { () -> String? in
                do {
                    try await cache.prepare(download: true, fetcher: fetcher) { files in
                        output.log(.info, "speaker detection download: \(files.count) of \(ModelManifest.diarizer.files.count) files, \(files.reduce(0) { $0 + $1.size }) bytes")
                    }
                    _ = try await OfflineDiarizerModels.load(from: directory)
                    return nil
                } catch {
                    return Self.message(for: error)
                }
            }.value
            guard let self else { return }
            downloading = nil
            self.failure = failure
            if let message = failure { output.log(.error, "speaker detection download failed: \(message)") }
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
        // A blocked cache has its files, so it goes on to `prepare`, which says what blocks it.
        guard downloading == nil, (try? cache.presence())?.missing.isEmpty == true else {
            throw MeetingFinalizeError(reason: .speakerModels, message: "speaker detection is not downloaded")
        }
        let directory = directory
        let cache = cache
        let fetcher = fetcher
        do {
            let result = try await Task.detached(priority: .utility) {
                try await cache.prepare(download: false, fetcher: fetcher)
                let manager = OfflineDiarizerManager()
                manager.initialize(models: try await OfflineDiarizerModels.load(from: directory))
                return try await manager.process(audioSource: PcmSampleSource(url: url), audioLoadingSeconds: 0)
            }.value
            if failure != nil {
                failure = nil
                reportStatus()
            }
            return result.segments.map {
                SpeakerTurn(speaker: $0.speakerId, startMs: Double($0.startTimeSeconds) * 1000, endMs: Double($0.endTimeSeconds) * 1000)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as ModelCacheError {
            let message = Self.message(for: error)
            failure = message
            output.log(.error, "meeting speaker detection failed: \(message)")
            reportStatus()
            throw MeetingFinalizeError(reason: .speakerModels, message: message)
        } catch {
            output.log(.error, "meeting speaker detection failed: \(error.localizedDescription)")
            throw MeetingFinalizeError(reason: .speakers, message: error.localizedDescription)
        }
    }

    private var modelFilesPresent: Bool {
        (try? cache.presence())?.isComplete == true
    }

    nonisolated private static func message(for error: Error) -> String {
        (error as? ModelCacheError)?.errorDescription ?? error.localizedDescription
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
