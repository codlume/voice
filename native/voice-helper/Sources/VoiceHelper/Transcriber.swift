import AVFoundation
import FluidAudio
import Foundation
import VoiceHelperCore
import os

struct TranscribeError: Error {
    let reason: TranscriptFailure
    let message: String
}

@MainActor
final class Transcriber {
    struct PreparedAsr {
        let manager: AsrManager
        let models: AsrModels
    }

    enum AsrLoad {
        case missing
        case downloading(Task<PreparedAsr, Error>)
        case loading(Task<PreparedAsr, Error>)
        case ready(PreparedAsr)
        case failed(String)
    }

    private let directory: URL
    private let output: Output
    private var load: AsrLoad = .missing

    init(modelsDir: URL, output: Output) {
        directory = modelsDir.appendingPathComponent("parakeet-tdt-0.6b-v3")
        self.output = output
    }

    func prepare(download: Bool) {
        switch load {
        case .ready:
            output.emit(.asrStatus(state: .ready, message: nil))
            return
        case .downloading:
            output.emit(.asrStatus(state: .downloading, message: nil))
            return
        case .loading:
            output.emit(.asrStatus(state: .loading, message: nil))
            return
        case .missing, .failed:
            break
        }
        let needsDownload = !AsrModels.modelsExist(at: directory, version: .v3)
        if needsDownload && !download {
            load = .missing
            output.emit(.asrStatus(state: .missing, message: nil))
            return
        }
        let directory = directory
        let task = Task.detached(priority: .userInitiated) { () throws -> PreparedAsr in
            let models = needsDownload
                ? try await AsrModels.downloadAndLoad(to: directory, version: .v3)
                : try await AsrModels.load(from: directory, version: .v3)
            let manager = AsrManager()
            try await manager.loadModels(models)
            // The first transcription in a process pays a one-off 30-40 ms; take it here.
            var state = TdtDecoderState.make()
            _ = try await manager.transcribe([Float](repeating: 0, count: 16000), decoderState: &state)
            return PreparedAsr(manager: manager, models: models)
        }
        load = needsDownload ? .downloading(task) : .loading(task)
        output.emit(.asrStatus(state: needsDownload ? .downloading : .loading, message: nil))
        Task { @MainActor in
            do {
                let manager = try await task.value
                load = .ready(manager)
                output.emit(.asrStatus(state: .ready, message: nil))
            } catch {
                let message = "\(error)"
                load = .failed(message)
                output.emit(.asrStatus(state: .failed, message: message))
            }
        }
    }

    func beginStreaming(language: DictationLanguage) -> StreamingTranscription? {
        guard case .ready(let ready) = load else { return nil }
        return StreamingTranscription(models: ready.models, language: language.asrLanguage)
    }

    func transcribe(
        _ samples: [Float], language: DictationLanguage, stream: StreamingTranscription? = nil
    ) async throws -> (text: String, asrMs: Double) {
        let started = DispatchTime.now()
        if let stream {
            if let text = try await stream.finish(sampleCount: samples.count) {
                output.log(.info, "streaming ASR finalized \(samples.count) samples")
                return (text, started.millisecondsToNow())
            }
            output.log(.error, "streaming ASR incomplete; retrying complete capture")
        }
        let manager: AsrManager
        switch load {
        case .ready(let ready):
            manager = ready.manager
        case .loading(let task), .downloading(let task):
            do {
                manager = try await task.value.manager
            } catch {
                throw TranscribeError(reason: .asrUnavailable, message: "speech model failed to load: \(error)")
            }
        case .missing:
            throw TranscribeError(reason: .asrUnavailable, message: "speech model is not loaded")
        case .failed(let message):
            throw TranscribeError(reason: .asrUnavailable, message: "speech model failed to load: \(message)")
        }
        // Parakeet refuses clips under 0.3 s; a short utterance should still yield a transcript.
        let minimum = ASRConstants.minimumRequiredSamples(forSampleRate: 16000)
        let padded = samples.count < minimum ? samples + [Float](repeating: 0, count: minimum - samples.count) : samples
        var state = TdtDecoderState.make()
        do {
            try Task.checkCancellation()
            let result = try await manager.transcribe(padded, decoderState: &state, language: language.asrLanguage)
            return (result.text, started.millisecondsToNow())
        } catch {
            throw TranscribeError(reason: .unknown, message: "\(error)")
        }
    }
}

final class StreamingTranscription {
    private static let configuration = SlidingWindowAsrConfig.default
    private static let sampleRate = 16_000.0
    static let minimumSamples = Int(configuration.chunkSeconds * sampleRate)
        + Int(configuration.rightContextSeconds * sampleRate)

    private let input: AsyncStream<[Float]>.Continuation
    private let worker: Task<String?, Never>
    private let coverage: OSAllocatedUnfairLock<StreamingCoverage>

    init(models: AsrModels, language: Language?) {
        let (chunks, input) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .bufferingOldest(32))
        self.input = input
        let config = Self.configuration.applying(language: language)
        let coverage = OSAllocatedUnfairLock(initialState: StreamingCoverage(
            chunkSamples: Int(config.chunkSeconds * Self.sampleRate), minimumSamples: Self.minimumSamples))
        self.coverage = coverage
        let manager = SlidingWindowAsrManager(config: config)
        worker = Task.detached(priority: .userInitiated) {
            await withTaskCancellationHandler {
                let updates = await manager.transcriptionUpdates
                let collector = Task {
                    for await _ in updates { coverage.withLock { $0.completeWindow() } }
                }
                do {
                    try Task.checkCancellation()
                    try await manager.loadModels(models)
                    try Task.checkCancellation()
                    try await manager.startStreaming()
                    try Task.checkCancellation()
                    let format = AVAudioFormat(
                        commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate, channels: 1, interleaved: false)!
                    for await chunk in chunks {
                        try Task.checkCancellation()
                        guard !chunk.isEmpty else { continue }
                        guard coverage.withLock({ $0.feed(chunk.count) }) else {
                            throw TranscribeError(reason: .unknown, message: "streaming ASR fell behind capture")
                        }
                        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(chunk.count)),
                            let channel = buffer.floatChannelData?[0]
                        else { throw ASRError.notInitialized }
                        buffer.frameLength = AVAudioFrameCount(chunk.count)
                        chunk.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: chunk.count) }
                        await manager.streamAudio(buffer)
                    }
                    try Task.checkCancellation()
                    let text = try await manager.finish()
                    // finish() leaves updates open. Closing them lets the collector drain all successes.
                    await manager.cancel()
                    await collector.value
                    try Task.checkCancellation()
                    return text
                } catch {
                    await manager.cancel()
                    await collector.value
                    input.finish()
                    return nil
                }
            } onCancel: {
                input.finish()
                Task { await manager.cancel() }
            }
        }
    }

    func enqueue(_ samples: [Float]) {
        input.yield(samples)
    }

    func finish(sampleCount: Int) async throws -> String? {
        input.finish()
        let result = await worker.value
        guard !worker.isCancelled else { throw CancellationError() }
        guard coverage.withLock({ $0.covers(sampleCount) }) else { return nil }
        return result
    }

    func cancel() {
        worker.cancel()
        input.finish()
    }
}

private extension DictationLanguage {
    var asrLanguage: Language? {
        switch self {
        case .auto: nil
        case .en: .english
        case .bg: .bulgarian
        case .hr: .croatian
        case .cs: .czech
        case .da: .danish
        case .nl: .dutch
        case .et: .estonian
        case .fi: .finnish
        case .fr: .french
        case .de: .german
        case .el: .greek
        case .hu: .hungarian
        case .it: .italian
        case .lv: .latvian
        case .lt: .lithuanian
        case .mt: .maltese
        case .pl: .polish
        case .pt: .portuguese
        case .ro: .romanian
        case .ru: .russian
        case .sk: .slovak
        case .sl: .slovenian
        case .es: .spanish
        case .sv: .swedish
        case .uk: .ukrainian
        }
    }
}

extension DispatchTime {
    func millisecondsToNow() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - uptimeNanoseconds) / 1e6
    }
}
