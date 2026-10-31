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
    private let finalPass: MeetingFinalPass
    private var legs: [String: MeetingCapture] = [:]
    private var jobs: [String: MeetingTranscription] = [:]
    private var finals: [String: Task<Void, Never>] = [:]
    // Final passes run one after another, so two meetings never hold two diarizers at once.
    private var lastFinal: Task<Void, Never>?

    init(output: Output, devices: AudioInputDevices, source: MeetingAudioSource, decode: @escaping MeetingTranscription.Decode,
         finalPass: MeetingFinalPass, isDictating: @escaping () -> Bool) {
        self.output = output
        self.devices = devices
        self.source = source
        self.decode = decode
        self.finalPass = finalPass
        self.isDictating = isDictating
    }

    func start(id: String, dir: String, baseMs: Double, fromMs: MeetingCursor, language: DictationLanguage, microphone: Microphone?) {
        guard legs[id] == nil else { return output.log(.error, "meeting.start \(id) ignored: already recording") }
        let folder = URL(fileURLWithPath: dir)
        let job = job(id: id, dir: folder, baseMs: baseMs, fromMs: fromMs, language: language)
        let leg = MeetingCapture(dir: folder, microphone: microphone, source: source, output: output, devices: devices,
                                 isDictating: isDictating) { [weak self, output] message in
            self?.legs[id] = nil
            job.drain()
            output.emit(.meetingFailed(id: id, message: message))
        }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let states = try leg.start()
            legs[id] = leg
            job.record(systemActive: states.system == .active)
            output.emit(.meetingStarted(id: id, mic: states.mic, system: states.system))
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
        let task = Task { [weak self] in
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
    typealias Decode = (_ samples: [Float], _ language: DictationLanguage) async throws -> String

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
    private var filter = EchoFilter()
    private var recording = false
    private var systemActive = false
    private var loop: Task<Void, Never>?

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
            filter = EchoFilter()
        }
        self.dir = dir
        self.baseMs = baseMs
        self.language = language
        for source in [MeetingSource.mic, .system] {
            cursor[source] = max(cursor[source] ?? 0, PcmFile.frames(milliseconds: fromMs[source] - baseMs))
        }
    }

    func record(systemActive: Bool) {
        recording = true
        self.systemActive = systemActive
        run()
    }

    /// No more audio is coming for now: transcribe the rest, then report `meeting.drained`.
    func drain() {
        recording = false
        run()
    }

    func cancel() {
        loop?.cancel()
        loop = nil
    }

    private func run() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
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
            guard let window = nextWindow() else {
                if recording {
                    try? await Task.sleep(for: idle)
                    continue
                }
                publish(systemDone: true)
                output.emit(.meetingDrained(id: id, failure: nil))
                return
            }
            do {
                try await transcribe(window)
            } catch is CancellationError {
                return
            } catch {
                let message = (error as? TranscribeError)?.message ?? "\(error)"
                guard recording else {
                    publish()
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

    // The source further behind goes first, so the two transcripts advance together and the echo
    // filter can release mic segments early.
    private func nextWindow() -> Window? {
        let sources = [MeetingSource.mic, .system].sorted { (cursor[$0] ?? 0) < (cursor[$1] ?? 0) }
        for source in sources {
            let url = file(source)
            let offset = cursor[source] ?? 0
            let available = PcmFile.frames(at: url) - offset
            guard available > 0, let samples = try? PcmFile.read(at: url, offset: offset, count: MeetingChunker.windowSamples)
            else { continue }
            let final = !recording && available <= samples.count
            if let cut = MeetingChunker.cut(samples, final: final) {
                return Window(source: source, offset: offset, samples: Array(samples.prefix(cut)))
            }
        }
        return nil
    }

    private func transcribe(_ window: Window) async throws {
        if let speech = MeetingChunker.speech(in: window.samples) {
            let text = try await decode(window.samples, language).trimmingCharacters(in: .whitespacesAndNewlines)
            try Task.checkCancellation()
            if !text.isEmpty {
                filter.add(TimedText(source: window.source, startMs: meetingMs(window.offset + speech.lowerBound),
                                     endMs: meetingMs(window.offset + speech.upperBound), text: text))
            }
        }
        cursor[window.source] = window.offset + window.samples.count
        publish()
    }

    /// `systemDone` once no system audio is left to transcribe, which releases every mic segment.
    private func publish(systemDone: Bool = false) {
        let systemMissing = !FileManager.default.fileExists(atPath: file(.system).path) || (recording && !systemActive)
        filter.systemReached(systemDone || systemMissing ? .infinity : meetingMs(cursor[.system] ?? 0))
        let released = filter.release()
        // Counts only: transcript text never goes to the log.
        for echo in filter.takeDropped() {
            output.log(.info, "meeting echo dropped a \(EchoFilter.words(echo.text).count)-word mic segment")
        }
        for segment in released {
            output.emit(.meetingSegment(id: id, source: segment.source, startMs: segment.startMs, endMs: segment.endMs, text: segment.text))
        }
    }

    private func meetingMs(_ frames: Int) -> Double {
        baseMs + PcmFile.milliseconds(frames)
    }

    private func file(_ source: MeetingSource) -> URL {
        dir.appendingPathComponent("\(source.rawValue).pcm")
    }
}

/// The more accurate pass after Stop: both files transcribed again in long windows with word
/// times, then the system file diarized. The two run one after the other, so the diarizer never
/// shares memory with a decode. Dictation comes first: no window or diarization starts while a
/// dictation runs.
@MainActor
final class MeetingFinalPass {
    typealias DecodeWords = (_ samples: [Float], _ language: DictationLanguage) async throws -> [TimedWord]
    /// Speaker turns in ms from the start of the file, or nil when the voices cannot be told apart.
    typealias Diarize = (_ url: URL) async -> [SpeakerTurn]?

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
        let systemURL = dir.appendingPathComponent("\(MeetingSource.system.rawValue).pcm")
        do {
            let mic = try await words(in: dir.appendingPathComponent("\(MeetingSource.mic.rawValue).pcm"), baseMs: baseMs, language: language)
            let system = try await words(in: systemURL, baseMs: baseMs, language: language)
            var turns: [SpeakerTurn]?
            if !system.isEmpty {
                try await dictationDone()
                turns = await diarize(systemURL)?.map {
                    SpeakerTurn(speaker: $0.speaker, startMs: baseMs + $0.startMs, endMs: baseMs + $0.endMs)
                }
            }
            try Task.checkCancellation()
            output.emit(.meetingFinalized(id: id, segments: FinalTranscript.segments(mic: mic, system: system, turns: turns)))
        } catch is CancellationError {
            return
        } catch {
            output.emit(.meetingFinalizeFailed(id: id, message: (error as? TranscribeError)?.message ?? "\(error)"))
        }
    }

    private func words(in url: URL, baseMs: Double, language: DictationLanguage) async throws -> [TimedWord] {
        let total = PcmFile.frames(at: url)
        var offset = 0
        var words: [TimedWord] = []
        while offset < total {
            try await dictationDone()
            let samples = try PcmFile.read(at: url, offset: offset, count: MeetingChunker.finalWindowSamples)
            guard !samples.isEmpty else { break }
            let window = Array(samples.prefix(MeetingChunker.finalCut(samples)))
            if let speech = MeetingChunker.speech(in: window) {
                let startMs = baseMs + PcmFile.milliseconds(offset + speech.lowerBound)
                words += try await decode(Array(window[speech]), language).map {
                    TimedWord(text: $0.text, startMs: startMs + $0.startMs, endMs: startMs + $0.endMs)
                }
            }
            offset += window.count
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
