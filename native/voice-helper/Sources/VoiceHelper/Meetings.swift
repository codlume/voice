import Foundation
import VoiceHelperCore

/// Meeting commands: recording legs and the transcription that follows their files. At most one
/// leg per meeting records at a time; a meeting's transcription outlives its legs, so a resume
/// carries on from where the last leg's transcript ended.
@MainActor
final class Meetings {
    private let output: Output
    private let devices: AudioInputDevices
    private let source: MeetingAudioSource
    private let decode: MeetingTranscription.Decode
    private let isDictating: () -> Bool
    private let isCapturingDictation: () -> Bool
    private let finalPass: MeetingFinalPass
    private var legs: [String: MeetingCapture] = [:]
    private var jobs: [String: MeetingTranscription] = [:]
    private var finals: [String: Task<Void, Never>] = [:]
    // Final passes run one after another, so two meetings never hold two diarizers at once.
    private var lastFinal: Task<Void, Never>?

    init(output: Output, devices: AudioInputDevices, source: MeetingAudioSource, decode: @escaping MeetingTranscription.Decode,
         finalPass: MeetingFinalPass, isDictating: @escaping () -> Bool, isCapturingDictation: @escaping () -> Bool) {
        self.output = output
        self.devices = devices
        self.source = source
        self.decode = decode
        self.finalPass = finalPass
        self.isDictating = isDictating
        self.isCapturingDictation = isCapturingDictation
    }

    func start(id: String, dir: String, baseMs: Double, fromMs: MeetingCursor, language: DictationLanguage, microphone: Microphone?) {
        guard legs[id] == nil else { return output.log(.error, "meeting.start \(id) ignored: already recording") }
        let folder = URL(fileURLWithPath: dir)
        let job = job(id: id, dir: folder, baseMs: baseMs, fromMs: fromMs, language: language)
        let leg = MeetingCapture(dir: folder, microphone: microphone, source: source, output: output, devices: devices,
                                 isCapturingDictation: isCapturingDictation, onFailed: { [weak self, output] message in
            self?.legs[id] = nil
            job.drain()
            output.emit(.meetingFailed(id: id, message: message))
        }, onLost: { [weak self, output] loss in
            self?.legs[id] = nil
            job.drain()
            output.emit(.meetingLost(id: id, source: loss.source, reason: loss.reason))
        })
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let states = try leg.start()
            legs[id] = leg
            job.record(states.system == .active ? [.mic, .system] : [.mic])
            output.emit(.meetingStarted(id: id, atMs: baseMs + PcmFile.milliseconds(leg.startFrames), mic: states.mic, system: states.system))
        } catch {
            leg.stop()
            job.drain()
            output.emit(.meetingFailed(id: id, message: (error as? CaptureError)?.message ?? error.localizedDescription))
        }
    }

    func stop(id: String) {
        legs.removeValue(forKey: id)?.stop()
        guard let job = jobs[id] else { return output.emit(.meetingDrained(id: id, failure: nil)) }
        job.drain()
    }

    func cancel(id: String) {
        legs.removeValue(forKey: id)?.stop()
        jobs.removeValue(forKey: id)?.cancel()
        finals.removeValue(forKey: id)?.cancel()
    }

    func transcribe(id: String, dir: String, baseMs: Double, fromMs: MeetingCursor, language: DictationLanguage) {
        let job = job(id: id, dir: URL(fileURLWithPath: dir), baseMs: baseMs, fromMs: fromMs, language: language)
        if legs[id] == nil { job.drain() }
    }

    /// A second request while this meeting's pass runs starts no second pass.
    func finalize(id: String, dir: String, baseMs: Double, language: DictationLanguage) {
        guard finals[id] == nil else { return }
        let previous = lastFinal
        let pass = finalPass
        let task = Task(priority: .utility) { [weak self] in
            await previous?.value
            guard !Task.isCancelled else { return }
            await pass.run(id: id, dir: URL(fileURLWithPath: dir), baseMs: baseMs, language: language)
            self?.finals[id] = nil
        }
        finals[id] = task
        lastFinal = task
    }

    func shutdown() {
        legs.values.forEach { $0.stop() }
        legs = [:]
        jobs.values.forEach { $0.cancel() }
        jobs = [:]
        finals.values.forEach { $0.cancel() }
        finals = [:]
    }

    private func job(id: String, dir: URL, baseMs: Double, fromMs: MeetingCursor, language: DictationLanguage) -> MeetingTranscription {
        let job = jobs[id] ?? MeetingTranscription(id: id, output: output, decode: decode, isDictating: isDictating)
        jobs[id] = job
        job.update(dir: dir, baseMs: baseMs, fromMs: fromMs, language: language)
        return job
    }
}

/// Transcribes a meeting's `mic.pcm` and `system.pcm` from where its transcript ends to where the
/// audio ends, following the files while a leg records into them. Dictation comes first: no
/// window starts decoding while a dictation runs.
@MainActor
final class MeetingTranscription {
    /// The words in `samples`, with times in ms into them.
    typealias Decode = (_ samples: [Float], _ language: DictationLanguage) async throws -> [TimedWord]

    private let id: String
    private let output: Output
    private let decode: Decode
    private let isDictating: () -> Bool
    private let idle: Duration
    private let retry: Duration
    private var dir = URL(fileURLWithPath: "/")
    private var baseMs = 0.0
    private var language = DictationLanguage.auto
    private var cursor: [MeetingSource: Int] = [.mic: 0, .system: 0]
    // The sources the current leg records, none once it stopped.
    private var recording: Set<MeetingSource> = []
    private var loop: Task<Void, Never>?
    // Where each source's last partial check ended, and the sources showing a partial.
    private var partialEnd: [MeetingSource: Int] = [:]
    private var showing: Set<MeetingSource> = []

    init(id: String, output: Output, decode: @escaping Decode, isDictating: @escaping () -> Bool,
         idle: Duration = .milliseconds(300), retry: Duration = .seconds(5)) {
        self.id = id
        self.output = output
        self.decode = decode
        self.isDictating = isDictating
        self.idle = idle
        self.retry = retry
    }

    /// `baseMs` changes only when the files were deleted and a new leg started them over.
    func update(dir: URL, baseMs: Double, fromMs: MeetingCursor, language: DictationLanguage) {
        if baseMs != self.baseMs || dir.path != self.dir.path {
            cursor = [.mic: 0, .system: 0]
        }
        self.dir = dir
        self.baseMs = baseMs
        self.language = language
        for source in [MeetingSource.mic, .system] {
            cursor[source] = max(cursor[source] ?? 0, PcmFile.frames(milliseconds: fromMs[source] - baseMs))
        }
    }

    func record(_ sources: Set<MeetingSource>) {
        recording = sources
        run()
    }

    /// No more audio is coming for now: transcribe the rest, then report `meeting.drained`.
    func drain() {
        recording = []
        run()
    }

    func cancel() {
        loop?.cancel()
        loop = nil
    }

    private func run() {
        guard loop == nil else { return }
        loop = Task(priority: .utility) { [weak self] in
            await self?.work()
            self?.loop = nil
        }
    }

    private func work() async {
        while !Task.isCancelled {
            if isDictating() {
                try? await Task.sleep(for: idle)
                continue
            }
            do {
                guard let window = try await nextWindow() else {
                    if !recording.isEmpty {
                        if let partial = await nextPartial(), !isDictating() {
                            await showPartial(partial)
                        } else {
                            try? await Task.sleep(for: idle)
                        }
                        continue
                    }
                    for source in showing { clearPartial(source) }
                    output.emit(.meetingDrained(id: id, failure: nil))
                    return
                }
                // The echo gate suspends the read, so a dictation may have started since the check above.
                try Task.checkCancellation()
                if isDictating() { continue }
                try await transcribe(window)
            } catch is CancellationError {
                return
            } catch {
                let message = (error as? TranscribeError)?.message ?? "\(error)"
                guard !recording.isEmpty else {
                    output.emit(.meetingDrained(id: id, failure: message))
                    return
                }
                output.log(.error, "meeting transcription failed, retrying: \(message)")
                try? await Task.sleep(for: retry)
            }
        }
    }

    private struct Window {
        let source: MeetingSource
        let offset: Int
        let samples: [Float]
    }

    // The source further behind goes first, so the two transcripts advance together.
    private func nextWindow() async throws -> Window? {
        let sources = [MeetingSource.mic, .system].sorted { (cursor[$0] ?? 0) < (cursor[$1] ?? 0) }
        for source in sources {
            let offset = cursor[source] ?? 0
            let available = end(of: source) - offset
            guard available > 0,
                  let raw = try? PcmFile.read(at: source.file(in: dir), offset: offset, count: min(available, MeetingChunker.windowSamples))
            else { continue }
            let final = recording.isEmpty && available <= raw.count
            if let cut = MeetingChunker.cut(raw, final: final) {
                return Window(source: source, offset: offset, samples: try await source.heard(in: dir, offset: offset, count: cut))
            }
        }
        return nil
    }

    private func transcribe(_ window: Window) async throws {
        if let speech = MeetingChunker.speech(in: window.samples) {
            let startMs = meetingMs(window.offset)
            let words = try await decode(window.samples, language).map { $0.shifted(by: startMs) }
            try Task.checkCancellation()
            if !words.isEmpty {
                // The segment goes out before its partial clears, so the line never blinks out.
                output.emit(.meetingSegment(id: id, source: window.source, startMs: meetingMs(window.offset + speech.lowerBound),
                                            endMs: meetingMs(window.offset + speech.upperBound), text: Self.text(words)))
            }
        }
        cursor[window.source] = window.offset + window.samples.count
        clearPartial(window.source)
    }

    /// Audio after a source's cursor that no window takes yet because no pause has come, once at
    /// least `partialSamples` of it are new since the last partial. Where the echo gate fails, the
    /// partial is skipped rather than shown ungated.
    private func nextPartial() async -> Window? {
        for source in [MeetingSource.mic, .system] {
            let offset = cursor[source] ?? 0
            let end = end(of: source)
            guard end - max(offset, partialEnd[source] ?? 0) >= Self.partialSamples else { continue }
            let count = min(end - offset, MeetingChunker.windowSamples)
            partialEnd[source] = offset + count
            guard let samples = try? await source.heard(in: dir, offset: offset, count: count),
                  MeetingChunker.speech(in: samples) != nil
            else { continue }
            return Window(source: source, offset: offset, samples: samples)
        }
        return nil
    }

    /// Where `source` can be heard up to now. While a leg records system audio, the mic waits for
    /// the system file, which trails it by up to a pump's worth: the gate needs what played.
    private func end(of source: MeetingSource) -> Int {
        let frames = PcmFile.frames(at: source.file(in: dir))
        guard source == .mic, recording.contains(.system) else { return frames }
        return min(frames, PcmFile.frames(at: MeetingSource.system.file(in: dir)))
    }

    private static let partialSamples = PcmFile.sampleRate

    /// Text that may still change, for the live view only; it is never saved.
    private func showPartial(_ window: Window) async {
        guard let words = try? await decode(window.samples, language), !Task.isCancelled, !words.isEmpty else { return }
        let text = Self.text(words)
        showing.insert(window.source)
        output.emit(.meetingPartial(id: id, source: window.source, text: text))
    }

    private func clearPartial(_ source: MeetingSource) {
        guard showing.remove(source) != nil else { return }
        output.emit(.meetingPartial(id: id, source: source, text: ""))
    }

    private func meetingMs(_ frames: Int) -> Double {
        baseMs + PcmFile.milliseconds(frames)
    }

    private static func text(_ words: [TimedWord]) -> String {
        words.map(\.text).joined(separator: " ")
    }
}

/// The more accurate pass after Stop: both files transcribed again in long windows with word
/// times, then the system file diarized. The two run one after the other, so the diarizer never
/// shares memory with a decode. Dictation comes first: no window or diarization starts while a
/// dictation runs.
@MainActor
final class MeetingFinalPass {
    typealias DecodeWords = (_ samples: [Float], _ language: DictationLanguage) async throws -> [TimedWord]
    /// Speaker turns in ms from the start of the file, or nil on a Mac that cannot tell voices
    /// apart. Throws `MeetingFinalizeError` when it could have and did not.
    typealias Diarize = (_ url: URL) async throws -> [SpeakerTurn]?

    private let output: Output
    private let decode: DecodeWords
    private let diarize: Diarize
    private let isDictating: () -> Bool
    private let idle: Duration

    init(output: Output, decode: @escaping DecodeWords, diarize: @escaping Diarize, isDictating: @escaping () -> Bool,
         idle: Duration = .milliseconds(300)) {
        self.output = output
        self.decode = decode
        self.diarize = diarize
        self.isDictating = isDictating
        self.idle = idle
    }

    func run(id: String, dir: URL, baseMs: Double, language: DictationLanguage) async {
        do {
            let mic = try await words(of: .mic, in: dir, baseMs: baseMs, language: language)
            let system = try await words(of: .system, in: dir, baseMs: baseMs, language: language)
            var turns: [SpeakerTurn]?
            if !system.isEmpty {
                try await dictationDone()
                turns = try await diarize(MeetingSource.system.file(in: dir))?.map {
                    SpeakerTurn(speaker: $0.speaker, startMs: baseMs + $0.startMs, endMs: baseMs + $0.endMs)
                }
            }
            try Task.checkCancellation()
            let segments = FinalTranscript.segments(mic: mic, system: system, turns: turns)
            output.emit(.meetingFinalized(id: id, segments: segments))
        } catch is CancellationError {
            return
        } catch let error as MeetingFinalizeError {
            output.emit(.meetingFinalizeFailed(id: id, reason: error.reason, message: error.message))
        } catch {
            output.emit(.meetingFinalizeFailed(id: id, reason: .transcript, message: (error as? TranscribeError)?.message ?? "\(error)"))
        }
    }

    private func words(of source: MeetingSource, in dir: URL, baseMs: Double, language: DictationLanguage) async throws -> [TimedWord] {
        let url = source.file(in: dir)
        let total = PcmFile.frames(at: url)
        var offset = 0
        var words: [TimedWord] = []
        while offset < total {
            try await dictationDone()
            let samples = try PcmFile.read(at: url, offset: offset, count: MeetingChunker.finalWindowSamples)
            guard !samples.isEmpty else { break }
            let count = MeetingChunker.finalCut(samples)
            let window = try await source.heard(in: dir, offset: offset, count: count)
            for run in MeetingChunker.speechRuns(in: window) {
                // The gate and each decode suspend, so a dictation may have started since the last check.
                try await dictationDone()
                let startMs = baseMs + PcmFile.milliseconds(offset + run.lowerBound)
                words += try await decode(Array(window[run]), language).map { $0.shifted(by: startMs) }
            }
            offset += count
        }
        return words
    }

    private func dictationDone() async throws {
        while isDictating() {
            try await Task.sleep(for: idle)
        }
        try Task.checkCancellation()
    }
}
