import AVFoundation
import Foundation
import VoiceHelperCore

/// A live leg's microphone, as `MicSource` is one.
protocol MeetingMic: AnyObject {
    func start(sink: @escaping ([Float]) -> Void) throws(CaptureError)
    func finish()
    func dispose()
}

extension MicSource: MeetingMic {}

/// A live leg's system audio, as `SystemAudioSource` is one.
protocol MeetingTap: AnyObject {
    func start(sink: @escaping ([Float]) -> Void, onFormatChange: @escaping () -> Void) throws(CaptureError)
    func stop()
    var msSinceAudio: Double { get }
}

/// One of a leg's two files, as `PcmWriter` is one.
protocol MeetingAudioWriter: AnyObject {
    var frames: Int { get }
    func append(_ samples: [Float]) throws
    func pad(to target: Int) throws
    func close() throws
}

extension PcmWriter: MeetingAudioWriter {}

/// What a leg takes from the Mac: TCC's answers, the microphone, the system tap and the files.
/// Tests pass fakes, so none of them opens a microphone or a process tap, or asks TCC.
struct MeetingHardware {
    var micAllowed: @Sendable () -> Bool
    /// False only once the user refused system audio; until then the first tap start asks.
    var systemAllowed: @Sendable () -> Bool
    var openMic: (AudioInputDevices, Microphone?, _ onChange: @escaping (MeetingMic) -> Void) throws(CaptureError) -> MeetingMic
    /// nil on a macOS without process taps.
    var openTap: (() throws(CaptureError) -> MeetingTap)?
    var openWriter: (URL) throws -> MeetingAudioWriter

    static let mac = MeetingHardware(
        micAllowed: { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized },
        systemAllowed: { SystemAudioAccess.state != .denied },
        openMic: { (devices, microphone, onChange) throws(CaptureError) -> MeetingMic in
            try MicSource(device: devices.resolve(microphone), preference: microphone) { onChange($0) }
        },
        openTap: systemTap,
        openWriter: { try PcmWriter(url: $0) })

    private static var systemTap: (() throws(CaptureError) -> MeetingTap)? {
        guard #available(macOS 14.4, *) else { return nil }
        return { () throws(CaptureError) -> MeetingTap in try SystemAudioSource() }
    }
}

/// One recording leg of a meeting: the microphone into `mic.pcm` and system audio into
/// `system.pcm`, appended as the audio arrives. Both files share one timeline: each source opened
/// for a leg first pads its file to the longer of the two, and stopping pads both to the same end.
/// Independent of dictation's capture, so dictating mid-meeting keeps working; while it runs the
/// meeting mic records silence instead of the dictated words.
final class MeetingCapture {
    private let output: Output
    private let devices: AudioInputDevices
    private let source: MeetingAudioSource
    private let hardware: MeetingHardware
    private let isCapturingDictation: () -> Bool
    private let onFailed: (String) -> Void
    private let onLost: (AudioLoss) -> Void
    private var watch: DispatchSourceTimer?
    private var lastMicAudio = DispatchTime.now()
    private let microphone: Microphone?
    private let micURL: URL
    private let systemURL: URL
    private var mic: MeetingAudioWriter?
    private var system: MeetingAudioWriter?
    private var micSource: MeetingMic?
    private var systemSource: MeetingTap?
    private var systemRestarts = TapRestarts()
    private var fixtures: [FileSource] = []
    private var stopped = false
    private let startedAt = DispatchTime.now()
    /// Where this leg's audio starts in the files.
    private(set) var startFrames = 0

    init(dir: URL, microphone: Microphone?, source: MeetingAudioSource, output: Output, devices: AudioInputDevices,
         isCapturingDictation: @escaping () -> Bool, onFailed: @escaping (String) -> Void, onLost: @escaping (AudioLoss) -> Void,
         hardware: MeetingHardware = .mac) {
        micURL = MeetingSource.mic.file(in: dir)
        systemURL = MeetingSource.system.file(in: dir)
        self.microphone = microphone
        self.source = source
        self.hardware = hardware
        self.output = output
        self.devices = devices
        self.isCapturingDictation = isCapturingDictation
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
        case .fixture(let micPath, let systemPath, let speed):
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
            guard hardware.micAllowed() else {
                throw CaptureError(reason: .permission, message: "Allow microphone access for Voice to record meetings.")
            }
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
        systemSource?.stop()
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

    private func open(_ url: URL) throws(CaptureError) -> MeetingAudioWriter {
        do {
            let writer = try hardware.openWriter(url)
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
        let source = try hardware.openMic(devices, microphone) { [weak self] changed in
            self?.micChanged(changed)
        }
        try source.start { [weak self] in self?.receiveMic($0) }
        micSource = source
        // The stall clock runs from here: a new device, Bluetooth above all, takes a moment to
        // deliver its first buffer.
        lastMicAudio = .now()
    }

    // A device change stops the engine. Unlike dictation, a meeting keeps going on whatever input
    // is now current, with silence for the moments it took to switch.
    private func micChanged(_ changed: MeetingMic) {
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
        guard let openTap = hardware.openTap else { return .unavailable }
        if !hardware.systemAllowed() { return .denied }
        do throws(CaptureError) {
            system = try open(systemURL)
            try openSystem(openTap)
            return .active
        } catch {
            output.log(.error, "meeting system audio unavailable: \(error.message)")
            try? system?.close()
            system = nil
            return .unavailable
        }
    }

    private func openSystem(_ openTap: () throws(CaptureError) -> MeetingTap) throws(CaptureError) {
        let source = try openTap()
        do throws(CaptureError) {
            try source.start(sink: { [weak self] in self?.receiveSystem($0) }, onFormatChange: { [weak self] in
                self?.restartSystem(because: "its format changed")
            })
        } catch {
            source.stop()
            throw error
        }
        systemSource = source
    }

    // A tap that stopped delivering, or whose sample rate changed, is recreated in place; the
    // file gets silence for the moments it missed. A tap that keeps stalling ends the leg.
    private func restartSystem(because reason: String) {
        guard !stopped, let old = systemSource, let openTap = hardware.openTap else { return }
        old.stop()
        // The old tap hands over its tail as it stops, and a tail the disk cannot take ends the leg.
        guard !stopped else { return }
        systemSource = nil
        guard systemRestarts.allows(restartAtMs: startedAt.millisecondsToNow()) else {
            output.log(.error, "meeting system audio stalled again after \(TapRestarts.limit) restarts")
            return lose(AudioLoss(source: .system, reason: .device))
        }
        do {
            try system?.pad(to: elapsedFrames)
            try openSystem(openTap)
            output.log(.info, "meeting system audio restarted: \(reason)")
        } catch {
            output.log(.error, "meeting system audio did not restart: \(error)")
            lose(AudioLoss(source: .system, reason: .device))
        }
    }

    // Permissions can be taken away mid-meeting, and macOS then hands the app silence, not an
    // error, so the leg checks every two seconds. Each question is an XPC round trip to TCC,
    // ~30 ms for the microphone, which a dictation press would wait behind on main, so both are
    // asked off main.
    private func startWatch(system: Bool) {
        let tick: (Bool, Bool) -> Void = { [weak self] micAllowed, systemAllowed in
            self?.watchTick(micAllowed: micAllowed, systemAllowed: systemAllowed, system: system)
        }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 2, repeating: 2, leeway: .milliseconds(200))
        timer.setEventHandler { [micAllowed = hardware.micAllowed, systemAllowed = hardware.systemAllowed] in
            let answers = (mic: micAllowed(), system: systemAllowed())
            DispatchQueue.main.async { tick(answers.mic, answers.system) }
        }
        watch = timer
        timer.resume()
    }

    private func watchTick(micAllowed: Bool, systemAllowed: Bool, system: Bool) {
        // An answer can come back after the leg stopped.
        guard !stopped else { return }
        switch MeetingWatch.check(
            micAllowed: micAllowed,
            systemAllowed: systemAllowed,
            msSinceMicAudio: micSource == nil ? nil : lastMicAudio.millisecondsToNow(),
            msSinceSystemAudio: system ? systemSource?.msSinceAudio : nil) {
        case .lost(let loss): lose(loss)
        case .systemStalled: restartSystem(because: "it delivered nothing for \(Int(MeetingWatch.systemStallMs)) ms")
        case nil: break
        }
    }

    // The files' frame for now, by the clock: a source that stalled has fewer frames than this.
    private var elapsedFrames: Int {
        startFrames + Int(startedAt.millisecondsToNow() * Double(PcmFile.sampleRate) / 1000)
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
        write(isCapturingDictation() ? [Float](repeating: 0, count: chunk.count) : chunk, to: mic)
    }

    private func receiveSystem(_ chunk: [Float]) {
        write(chunk, to: system)
    }

    // Keyed on the writer, not `stopped`: `stop` flushes the sources' tails through here before
    // it closes the files.
    private func write(_ chunk: [Float], to writer: MeetingAudioWriter?) {
        guard let writer else { return }
        do {
            try writer.append(chunk)
        } catch {
            fail("Could not save meeting audio: \(error.localizedDescription)")
        }
    }

    private func fail(_ message: String) {
        guard !stopped else { return output.log(.error, message) }
        stop()
        onFailed(message)
    }
}
