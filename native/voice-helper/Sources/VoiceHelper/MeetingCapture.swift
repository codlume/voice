import AVFoundation
import Foundation
import VoiceHelperCore

/// One recording leg of a meeting: the microphone into `mic.pcm` and system audio into
/// `system.pcm`, appended as the audio arrives. Both files share one timeline: each source opened
/// for a leg first pads its file to the longer of the two, and stopping pads both to the same end.
/// Independent of dictation's capture, so dictating mid-meeting keeps working; while it runs the
/// meeting mic records silence instead of the dictated words.
final class MeetingCapture {
    private let output: Output
    private let devices: AudioInputDevices
    private let source: MeetingAudioSource
    private let isDictating: () -> Bool
    private let onFailed: (String) -> Void
    private let onLost: (AudioLoss) -> Void
    private var watch: DispatchSourceTimer?
    private var lastMicAudio = DispatchTime.now()
    private let microphone: Microphone?
    private let dir: URL
    private let micURL: URL
    private let systemURL: URL
    private var mic: PcmWriter?
    private var system: PcmWriter?
    private var micSource: MicSource?
    private var systemSource: AnyObject?
    private var fixtures: [FileSource] = []
    private var stopped = false
    private let startedAt = DispatchTime.now()
    private var startFrames = 0
    private var route: MeetingOutput?

    init(dir: URL, microphone: Microphone?, source: MeetingAudioSource, output: Output, devices: AudioInputDevices,
         isDictating: @escaping () -> Bool, onFailed: @escaping (String) -> Void, onLost: @escaping (AudioLoss) -> Void) {
        self.dir = dir
        micURL = dir.appendingPathComponent("mic.pcm")
        systemURL = dir.appendingPathComponent("system.pcm")
        self.microphone = microphone
        self.source = source
        self.output = output
        self.devices = devices
        self.isDictating = isDictating
        self.onFailed = onFailed
        self.onLost = onLost
    }

    /// Starts both sources; throws only when the microphone cannot record, since a meeting
    /// without the user's voice is not one. System audio that cannot record is reported instead.
    func start() throws(CaptureError) -> (mic: MeetingSourceState, system: MeetingSourceState) {
        startFrames = max(PcmFile.frames(at: micURL), PcmFile.frames(at: systemURL))
        switch source {
        case .disabled:
            throw CaptureError(reason: .device, message: "meeting capture disabled in test mode; set a meeting fixture")
        case .fixture(let micPath, let systemPath, let speed, let outputPath):
            let said = (try? String(contentsOfFile: outputPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
            note(said == MeetingOutput.headphones.rawValue ? .headphones : .speakers)
            mic = try open(micURL)
            fixtures.append(try fixture(micPath, speed: speed) { [weak self] in self?.receiveMic($0) })
            var systemState = MeetingSourceState.unavailable
            if !systemPath.isEmpty, FileManager.default.fileExists(atPath: systemPath) {
                system = try open(systemURL)
                fixtures.append(try fixture(systemPath, speed: speed) { [weak self] in self?.receiveSystem($0) })
                systemState = .active
            }
            fixtures.forEach { $0.start() }
            return (.active, systemState)
        case .live:
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
                throw CaptureError(reason: .permission, message: "Allow microphone access for Voice to record meetings.")
            }
            note(OutputRoute.current)
            mic = try open(micURL)
            try openMic()
            let system = startSystem()
            startWatch(system: system == .active)
            return (.active, system)
        }
    }

    /// Delivers what the sources still hold, pads both files to one end and closes them.
    func stop() {
        guard !stopped else { return }
        stopped = true
        watch?.cancel()
        watch = nil
        fixtures.forEach { $0.stop() }
        fixtures = []
        micSource?.finish()
        micSource?.dispose()
        micSource = nil
        if #available(macOS 14.4, *) { (systemSource as? SystemAudioSource)?.stop() }
        systemSource = nil
        let end = max(mic?.frames ?? 0, system?.frames ?? 0)
        for writer in [mic, system].compactMap({ $0 }) {
            do {
                try writer.pad(to: end)
                try writer.close()
            } catch {
                output.log(.error, "meeting audio close failed: \(error.localizedDescription)")
            }
        }
        mic = nil
        system = nil
    }

    private func open(_ url: URL) throws(CaptureError) -> PcmWriter {
        do {
            let writer = try PcmWriter(url: url)
            try writer.pad(to: startFrames)
            return writer
        } catch {
            throw CaptureError(reason: .unknown, message: "Could not save meeting audio: \(error.localizedDescription)")
        }
    }

    private func fixture(_ path: String, speed: Double, sink: @escaping ([Float]) -> Void) throws(CaptureError) -> FileSource {
        do {
            return try FileSource(path: path, speed: speed, sink: sink) { [output] in output.log(.info, "meeting fixture ended \(path)") }
        } catch let error as CaptureError {
            throw error
        } catch {
            throw CaptureError(reason: .unknown, message: "\(error)")
        }
    }

    private func openMic() throws(CaptureError) {
        let source = try MicSource(device: devices.resolve(microphone), preference: microphone) { [weak self] changed in
            self?.micChanged(changed)
        }
        try source.start { [weak self] in self?.receiveMic($0) }
        micSource = source
    }

    // A device change stops the engine. Unlike dictation, a meeting keeps going on whatever input
    // is now current, with silence for the moments it took to switch.
    private func micChanged(_ changed: MicSource) {
        guard changed === micSource, !stopped else { return }
        changed.finish()
        changed.dispose()
        micSource = nil
        reopenMic(attempt: 1)
    }

    private func reopenMic(attempt: Int) {
        guard !stopped else { return }
        do {
            try openMic()
            try mic?.pad(to: system?.frames ?? elapsedFrames)
            output.log(.info, "meeting microphone reopened after a device change")
        } catch {
            guard attempt < 10 else {
                output.log(.error, "meeting microphone did not come back: \(error)")
                return lose(AudioLoss(source: .mic, reason: .device))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.reopenMic(attempt: attempt + 1) }
        }
    }

    private func startSystem() -> MeetingSourceState {
        guard #available(macOS 14.4, *) else { return .unavailable }
        if SystemAudioAccess.state == .denied { return .denied }
        let source: SystemAudioSource
        do throws(CaptureError) {
            source = try SystemAudioSource()
        } catch {
            output.log(.error, "meeting system audio unavailable: \(error.message)")
            return .unavailable
        }
        do throws(CaptureError) {
            system = try open(systemURL)
            try source.start { [weak self] in self?.receiveSystem($0) }
            systemSource = source
            return .active
        } catch {
            output.log(.error, "meeting system audio unavailable: \(error.message)")
            source.stop()
            try? system?.close()
            system = nil
            return .unavailable
        }
    }

    // Permissions can be taken away mid-meeting, and macOS then hands the app silence, not an
    // error, so the leg checks every two seconds.
    private func startWatch(system: Bool) {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 2, repeating: 2, leeway: .milliseconds(200))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            note(OutputRoute.current)
            let loss = MeetingWatch.loss(
                micAllowed: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
                systemRecording: system, systemAllowed: SystemAudioAccess.state != .denied,
                msSinceMicAudio: micSource == nil ? nil : lastMicAudio.millisecondsToNow())
            if let loss { lose(loss) }
        }
        watch = timer
        timer.resume()
    }

    // The files' frame for now, by the clock: a source that stalled has fewer frames than this.
    private var elapsedFrames: Int {
        startFrames + Int(startedAt.millisecondsToNow() * Double(PcmFile.sampleRate) / 1000)
    }

    // Echo can only come from speakers, so the transcription needs to know where the other side
    // played at every moment of the meeting.
    private func note(_ current: MeetingOutput) {
        guard current != route else { return }
        let frame = route == nil ? startFrames : elapsedFrames
        route = current
        do {
            try OutputTimeline.append(current, atFrame: frame, dir: dir)
        } catch {
            output.log(.error, "meeting output route not saved: \(error.localizedDescription)")
        }
    }

    private func lose(_ loss: AudioLoss) {
        guard !stopped else { return }
        output.log(.error, "meeting \(loss.source.rawValue) lost (\(loss.reason.rawValue)); the leg ends")
        stop()
        onLost(loss)
    }

    private func receiveMic(_ chunk: [Float]) {
        lastMicAudio = .now()
        // Dictated words belong to wherever they were inserted, not to the meeting.
        write(isDictating() ? [Float](repeating: 0, count: chunk.count) : chunk, to: mic)
    }

    private func receiveSystem(_ chunk: [Float]) {
        write(chunk, to: system)
    }

    private func write(_ chunk: [Float], to writer: PcmWriter?) {
        guard !stopped, let writer else { return }
        do {
            try writer.append(chunk)
        } catch {
            fail("Could not save meeting audio: \(error.localizedDescription)")
        }
    }

    private func fail(_ message: String) {
        guard !stopped else { return }
        stop()
        onFailed(message)
    }
}
