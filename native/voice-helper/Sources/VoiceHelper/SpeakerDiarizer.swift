import FluidAudio
import Foundation
import VoiceHelperCore

/// Tells apart the voices in a meeting's system audio with FluidAudio's offline diarizer
/// (pyannote segmentation, WeSpeaker embeddings, VBx clustering). Its 21 MB of models download
/// into the models folder the first time a meeting needs them. They load for each run and are
/// released after it, so the ~350 MB an hour of audio takes is held only while it runs.
final class SpeakerDiarizer {
    private let directory: URL
    private let output: Output

    init(modelsDir: URL, output: Output) {
        directory = modelsDir
        self.output = output
    }

    /// Turns in ms from the start of the file, or nil when this Mac cannot tell the voices apart
    /// now: no models and no network, or macOS 14, whose BNNS bug can crash the offline diarizer
    /// (FluidAudio #878) and take dictation down with the helper.
    func turns(in url: URL) async -> [SpeakerTurn]? {
        guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15 else {
            output.log(.info, "meeting speakers left as one voice: diarization needs macOS 15")
            return nil
        }
        let directory = directory
        do {
            let result = try await Task.detached(priority: .utility) {
                let manager = OfflineDiarizerManager()
                try await manager.prepareModels(directory: directory)
                return try await manager.process(audioSource: PcmSampleSource(url: url), audioLoadingSeconds: 0)
            }.value
            return result.segments.map {
                SpeakerTurn(speaker: $0.speakerId, startMs: Double($0.startTimeSeconds) * 1000, endMs: Double($0.endTimeSeconds) * 1000)
            }
        } catch {
            output.log(.error, "meeting speakers left as one voice: \(error.localizedDescription)")
            return nil
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
