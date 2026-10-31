import AVFoundation
import FluidAudio
import Foundation
import VoiceHelperCore
import os

struct TranscribeError: Error {
    let reason: TranscriptFailure
    let message: String
}

/// What capture needs from the speech model, so tests can stand in a fake.
@MainActor
protocol Transcribing: AnyObject {
    var sessionState: AsrSessionState { get }
    func beginStreaming(language: DictationLanguage) -> StreamingTranscription?
    func decodeAhead(_ samples: [Float], language: DictationLanguage) -> PauseDecode?
    func transcribe(
        _ samples: [Float], language: DictationLanguage, stream: StreamingTranscription?, pauseDecode: PauseDecode?
    ) async throws -> (text: String, asrMs: Double)
}

/// A decode of the capture so far, started at a pause. The model is an actor that runs each
/// decode to completion, so a second decode started while one runs would queue behind it, and
/// so would the release decode: `finished` tells capture whether another may start. `stale` is
/// set by capture once speech follows the decoded samples. Both flags live on the main thread
/// with Capture.
final class PauseDecode {
    private(set) var task: Task<String, Error>!
    private(set) var finished = false
    var stale = false

    init(_ decode: @escaping @Sendable () async throws -> String) {
        task = Task.detached(priority: .userInitiated) { [self] in
            defer { DispatchQueue.main.async { self.finished = true } }
            return try await decode()
        }
    }

    func cancel() {
        task.cancel()
    }
}

@MainActor
final class Transcriber: Transcribing {
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
    private var lastDecodeFinishedAt: DispatchTime?
    private var meetingManager: Task<AsrManager, Error>?
    private static let warmSeconds = 300.0

    /// A model that has not decoded for a while may pay a reload on its next decode, and the
    /// session metrics alone cannot tell that from a slow decode.
    var sessionState: AsrSessionState {
        switch load {
        case .ready:
            let idle = lastDecodeFinishedAt.map { $0.millisecondsToNow() / 1000 } ?? .infinity
            return idle < Self.warmSeconds ? .warm : .cold
        case .loading: return .loading
        case .downloading: return .downloading
        case .missing: return .missing
        case .failed: return .failed
        }
    }

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
                lastDecodeFinishedAt = .now()
                output.emit(.asrStatus(state: .ready, message: nil))
            } catch {
                let message = "\(error)"
                load = .failed(message)
                output.emit(.asrStatus(state: .failed, message: message))
            }
        }
    }

    func remove() {
        switch load {
        case .downloading:
            output.log(.info, "asr.remove ignored while the speech model downloads")
            output.emit(.asrStatus(state: .downloading, message: nil))
            return
        case .loading:
            output.log(.info, "asr.remove ignored while the speech model loads")
            output.emit(.asrStatus(state: .loading, message: nil))
            return
        case .missing, .ready, .failed:
            break
        }
        load = .missing
        meetingManager = nil
        do {
            try FileManager.default.removeItem(at: directory)
        } catch let error as CocoaError where error.code == .fileNoSuchFile {
        } catch {
            let message = error.localizedDescription
            load = .failed(message)
            output.emit(.asrStatus(state: .failed, message: message))
            return
        }
        output.emit(.asrStatus(state: .missing, message: nil))
    }

    func beginStreaming(language: DictationLanguage) -> StreamingTranscription? {
        guard case .ready(let ready) = load else { return nil }
        return StreamingTranscription(models: ready.models, language: language.asrLanguage)
    }

    /// Decodes the capture so far during a pause. If the user releases without speaking again,
    /// the result is the transcript a release 0.3 s after the last word would have produced; the
    /// extra trailing silence the model did not see carries no words, though it can shift a
    /// punctuation choice the same way the release delay already does.
    func decodeAhead(_ samples: [Float], language: DictationLanguage) -> PauseDecode? {
        guard case .ready(let ready) = load else { return nil }
        let manager = ready.manager
        let asrLanguage = language.asrLanguage
        return PauseDecode { try await Self.decode(samples, with: manager, language: asrLanguage) }
    }

    /// `pauseDecode` is a `decodeAhead` that nothing but silence followed.
    func transcribe(
        _ samples: [Float], language: DictationLanguage, stream: StreamingTranscription?, pauseDecode: PauseDecode?
    ) async throws -> (text: String, asrMs: Double) {
        let started = DispatchTime.now()
        defer { lastDecodeFinishedAt = .now() }
        if let stream {
            if let text = try await stream.finish(sampleCount: samples.count) {
                output.log(.info, "streaming ASR finalized \(samples.count) samples")
                return (text, started.millisecondsToNow())
            }
            output.log(.error, "streaming ASR incomplete; retrying complete capture")
        }
        if let pauseDecode {
            do {
                let text = try await pauseDecode.task.value
                output.log(.info, "ASR reused the decode from the last pause")
                return (text, started.millisecondsToNow())
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                output.log(.error, "ASR decode from the last pause failed; retrying complete capture")
            }
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
        do {
            let text = try await Self.decode(samples, with: manager, language: language.asrLanguage)
            return (text, started.millisecondsToNow())
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw TranscribeError(reason: .unknown, message: "\(error)")
        }
    }

    /// Decodes a meeting window into words, with times in ms into `samples`, on its own manager at
    /// utility priority, so a dictation decode never queues behind meeting audio on the model
    /// actor. Waits for a model that is loading.
    func decodeMeeting(_ samples: [Float], language: DictationLanguage) async throws -> [TimedWord] {
        let manager = try await meetingAsr()
        let asrLanguage = language.asrLanguage
        return try await Task.detached(priority: .utility) {
            let minimum = ASRConstants.minimumRequiredSamples(forSampleRate: 16000)
            let padded = samples.count < minimum ? samples + [Float](repeating: 0, count: minimum - samples.count) : samples
            var state = TdtDecoderState.make()
            try Task.checkCancellation()
            let tokens = try await manager.transcribe(padded, decoderState: &state, language: asrLanguage).tokenTimings ?? []
            return FinalTranscript.words(tokens: tokens.map { ($0.token, $0.startTime * 1000, $0.endTime * 1000) }, offsetMs: 0)
        }.value
    }

    private func meetingAsr() async throws -> AsrManager {
        let pending: Task<AsrManager, Error>
        if let meetingManager {
            pending = meetingManager
        } else {
            let prepared: Task<PreparedAsr, Error>
            switch load {
            case .ready(let ready): prepared = Task { ready }
            case .loading(let task), .downloading(let task): prepared = task
            case .missing: throw TranscribeError(reason: .asrUnavailable, message: "speech model is not downloaded")
            case .failed(let message): throw TranscribeError(reason: .asrUnavailable, message: "speech model failed to load: \(message)")
            }
            pending = Task.detached(priority: .utility) {
                let manager = AsrManager()
                try await manager.loadModels(try await prepared.value.models)
                return manager
            }
            meetingManager = pending
        }
        do {
            return try await pending.value
        } catch {
            if meetingManager == pending { meetingManager = nil }
            throw TranscribeError(reason: .asrUnavailable, message: "speech model failed to load: \(error)")
        }
    }

    nonisolated static func decode(_ samples: [Float], with manager: AsrManager, language: Language?) async throws -> String {
        // Parakeet refuses clips under 0.3 s; a short utterance should still yield a transcript.
        let minimum = ASRConstants.minimumRequiredSamples(forSampleRate: 16000)
        let padded = samples.count < minimum ? samples + [Float](repeating: 0, count: minimum - samples.count) : samples
        var state = TdtDecoderState.make()
        try Task.checkCancellation()
        return try await manager.transcribe(padded, decoderState: &state, language: language).text
    }
}

final class StreamingTranscription {
    private static let configuration = SlidingWindowAsrConfig.default
    static let minimumSamples = Int(configuration.chunkSeconds * asrSampleRate)
        + Int(configuration.rightContextSeconds * asrSampleRate)

    private let input: AsyncStream<[Float]>.Continuation
    private let worker: Task<String?, Never>
    private let coverage: OSAllocatedUnfairLock<StreamingCoverage>

    init(models: AsrModels, language: Language?) {
        let (chunks, input) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .bufferingOldest(32))
        self.input = input
        let config = Self.configuration.applying(language: language)
        let coverage = OSAllocatedUnfairLock(initialState: StreamingCoverage(
            chunkSamples: Int(config.chunkSeconds * asrSampleRate), minimumSamples: Self.minimumSamples))
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
                    guard let targetFormat else { throw ASRError.notInitialized }
                    for await chunk in chunks {
                        try Task.checkCancellation()
                        guard !chunk.isEmpty else { continue }
                        guard coverage.withLock({ $0.feed(chunk.count) }) else {
                            throw TranscribeError(reason: .unknown, message: "streaming ASR fell behind capture")
                        }
                        guard let buffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AVAudioFrameCount(chunk.count)),
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
        milliseconds(from: self, to: .now())
    }

    var uptimeMs: Double { Double(uptimeNanoseconds) / 1e6 }
}

func milliseconds(from start: DispatchTime, to end: DispatchTime) -> Double {
    (Double(end.uptimeNanoseconds) - Double(start.uptimeNanoseconds)) / 1e6
}
