import FluidAudio
import Foundation
import VoiceHelperCore

struct TranscribeError: Error {
    let reason: TranscriptFailure
    let message: String
}

@MainActor
final class Transcriber {
    enum AsrLoad {
        case missing
        case downloading(Task<AsrManager, Error>)
        case loading(Task<AsrManager, Error>)
        case ready(AsrManager)
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
        let task = Task.detached(priority: .userInitiated) { () throws -> AsrManager in
            let models = needsDownload
                ? try await AsrModels.downloadAndLoad(to: directory, version: .v3)
                : try await AsrModels.load(from: directory, version: .v3)
            let manager = AsrManager()
            try await manager.loadModels(models)
            // The first transcription in a process pays a one-off 30-40 ms; take it here.
            var state = TdtDecoderState.make()
            _ = try await manager.transcribe([Float](repeating: 0, count: 16000), decoderState: &state)
            return manager
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

    func transcribe(_ samples: [Float], language: DictationLanguage) async throws -> (text: String, asrMs: Double) {
        let manager: AsrManager
        switch load {
        case .ready(let ready):
            manager = ready
        case .loading(let task), .downloading(let task):
            do {
                manager = try await task.value
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
        let started = DispatchTime.now()
        do {
            let result = try await manager.transcribe(padded, decoderState: &state, language: language.asrLanguage)
            return (result.text, started.millisecondsToNow())
        } catch {
            throw TranscribeError(reason: .unknown, message: "\(error)")
        }
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
