import CoreML
import FluidAudio
import Foundation
import VoiceHelperCore

@MainActor
final class VoiceDetection {
    private enum Load {
        case absent
        case loading(Task<VadManager?, Error>)
        case fetching
        case ready(VadManager)
        case failed
    }

    private let cache: ModelCache
    private let fetcher: ModelFetcher
    private let output: Output
    private var load = Load.absent
    private var saidHearFailed = false

    init(modelsDir: URL, output: Output) {
        // FluidAudio's own loader fetches the detector from an unpinned `main`. It must never
        // run: bytes reach a load only through `cache`.
        ModelHub.offlineMode = true
        cache = ModelCache(release: ModelManifest.voiceDetector, modelsDirectory: modelsDir)
        fetcher = ModelFetcher(configuration: ModelHub.session.configuration)
        self.output = output
    }

    func prepare() {
        switch load {
        case .loading, .fetching, .ready: return
        case .absent, .failed: break
        }
        let cache = cache
        let fetcher = fetcher
        let check = Task.detached(priority: .utility) { () throws -> VadManager? in
            do {
                try await cache.prepare(download: false, fetcher: fetcher)
            } catch let error as ModelCacheError {
                switch error.kind {
                case .notInstalled, .damaged: return nil
                case .invalidManifest, .blocked, .downloadFailed, .writeFailed: throw error
                }
            }
            return try await Self.loadModel(from: cache.folder)
        }
        load = .loading(check)
        Task { @MainActor in
            do {
                let manager: VadManager
                if let checked = try await check.value {
                    manager = checked
                } else {
                    load = .fetching
                    manager = try await Task.detached(priority: .utility) {
                        try await cache.prepare(download: true, fetcher: fetcher)
                        return try await Self.loadModel(from: cache.folder)
                    }.value
                }
                load = .ready(manager)
                output.log(.info, "voice detector ready")
            } catch {
                load = .failed
                output.log(.error, "voice detector unavailable: \((error as? ModelCacheError)?.errorDescription ?? "\(error)")")
            }
        }
    }

    nonisolated private static func loadModel(from folder: URL) async throws -> VadManager {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuAndNeuralEngine
        let model = try MLModel(contentsOf: folder.appendingPathComponent(ModelNames.VAD.sileroVadFile), configuration: configuration)
        let manager = VadManager(vadModel: model)
        // The first prediction in a process pays a one-off cost; take it here.
        _ = try await manager.process([Float](repeating: 0, count: VoiceActivity.chunkSamples))
        return manager
    }

    func remove() {
        switch load {
        case .loading, .fetching: return output.log(.info, "voice detector kept: it is still being prepared")
        case .absent, .ready, .failed: break
        }
        load = .absent
        do {
            try FileManager.default.removeItem(at: cache.folder)
        } catch let error as CocoaError where error.code == .fileNoSuchFile {
        } catch {
            output.log(.error, "voice detector not removed: \(error.localizedDescription)")
        }
    }

    func detector() async -> (any VoiceDetector)? {
        let manager: VadManager
        switch load {
        case .ready(let ready):
            manager = ready
        case .loading(let check):
            guard let loaded = try? await check.value else { return nil }
            manager = loaded
        case .absent, .fetching, .failed:
            return nil
        }
        return SileroDetector(manager: manager) { [weak self] error in
            Task { @MainActor in self?.hearFailed(error) }
        }
    }

    private func hearFailed(_ error: Error) {
        guard !saidHearFailed else { return }
        saidHearFailed = true
        output.log(.error, "voice detector failed on meeting audio: \(error)")
    }
}

private struct SileroDetector: VoiceDetector {
    let manager: VadManager
    var state = VadStreamState.initial()
    let failed: @Sendable (Error) -> Void

    func hear(_ samples: [Float]) async -> (probabilities: [Float], next: any VoiceDetector)? {
        var next = self
        var probabilities: [Float] = []
        do {
            for start in stride(from: 0, to: samples.count, by: VoiceActivity.chunkSamples) {
                let chunk = Array(samples[start..<min(start + VoiceActivity.chunkSamples, samples.count)])
                let result = try await manager.processStreamingChunk(chunk, state: next.state)
                next.state = result.state
                probabilities.append(result.probability)
            }
        } catch {
            failed(error)
            return nil
        }
        return (probabilities, next)
    }
}
