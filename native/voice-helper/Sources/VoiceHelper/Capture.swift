import AVFoundation
import AudioToolbox
import Foundation
import VoiceHelperCore
import os

struct CaptureSession {
    let id: String
    let language: DictationLanguage
    let frontmostPid: pid_t?
    let commandedAt: DispatchTime
    let input = CaptureInput()
}

final class Recording {
    let session: CaptureSession
    var samples: [Float] = []
    var stream: StreamingTranscription?
    var transcription: Task<Void, Never>?

    init(session: CaptureSession) {
        self.session = session
    }
}

enum CaptureState {
    case idle
    case starting(CaptureSession)
    case recording(Recording)
    case transcribing(Recording)
    /// `started` flips on the first chunk, so a test never reports audio that has not flowed.
    case testing(id: String, started: Bool)
}

struct CaptureError: Error {
    let reason: CaptureFailure
    let message: String
}

private let sampleRate = 16_000.0
private let chunkFrames = 1600
private let silenceFloor = 1e-4 as Float

/// Owned by the main thread. `isActive` is the one reader on another thread: the hotkey tap
/// asks it before consuming Escape.
final class Capture {
    private let output: Output
    private let transcriber: Transcriber
    private let devices: AudioInputDevices
    private var microphone: Microphone?
    private let outputSilencer: OutputSilencer
    private var state: CaptureState = .idle {
        didSet {
            let active: Bool
            switch state {
            case .starting, .recording: active = true
            case .idle, .transcribing, .testing: active = false
            }
            activeFlag.withLock { $0 = active }
        }
    }
    private let activeFlag = OSAllocatedUnfairLock(initialState: false)
    private var mic: MicSource?
    private var file: FileSource?
    /// TCC answers `authorizationStatus` over XPC at ~30 ms a call, so a press reads this and
    /// the idle warmup refreshes it off main. Revoking microphone access quits the app unless
    /// the user picks "Later".
    private var microphoneAuthorized = false
    private let authorizationStatus: @Sendable () -> AVAuthorizationStatus
    private(set) var lastTarget: (id: String, pid: pid_t?)?
    var testAudioPath: String?
    private let maxSamples: Int

    init(
        output: Output, transcriber: Transcriber, devices: AudioInputDevices, maxSamples: Int = 600 * 16_000,
        authorizationStatus: @escaping @Sendable () -> AVAuthorizationStatus = { AVCaptureDevice.authorizationStatus(for: .audio) }
    ) {
        self.devices = devices
        self.maxSamples = maxSamples
        self.output = output
        self.transcriber = transcriber
        self.authorizationStatus = authorizationStatus
        self.outputSilencer = OutputSilencer(output: output)
    }

    var isActive: Bool { activeFlag.withLock { $0 } }

    func start(id: String, language: DictationLanguage, frontmostPid: pid_t?, receivedAt: DispatchTime, muteWhileDictating: Bool, microphone: Microphone?) {
        // Dictation preempts a test. The mic keeps running so dictation gets audio without an
        // engine restart.
        if case .testing(let testId, _) = state {
            file?.stop()
            file = nil
            state = .idle
            output.emit(.microphoneTestEnded(id: testId))
        }
        guard case .idle = state else {
            output.emit(.captureFailed(id: id, reason: .busy, message: "capture is busy with another session"))
            return
        }
        adopt(microphone)
        let session = CaptureSession(id: id, language: language, frontmostPid: frontmostPid, commandedAt: receivedAt)
        let sink: ([Float]) -> Void = { [weak self] chunk in self?.ingest(chunk, for: session) }
        do {
            if let testAudioPath {
                let file = try FileSource(path: testAudioPath, sink: sink) { [weak self] in
                    self?.output.log(.info, "test.audioFile ended")
                }
                state = .starting(session)
                self.file = file
                if muteWhileDictating { outputSilencer.begin() }
                file.start()
                return
            }
            guard microphoneAuthorized || refreshMicrophoneAuthorization() else {
                throw CaptureError(reason: .permission, message: "microphone access is not granted")
            }
            let mic = try self.mic ?? makeMic()
            self.mic = mic
            state = .starting(session)
            if muteWhileDictating { outputSilencer.begin() }
            try mic.start(sink: sink)
        } catch let error as CaptureError {
            fail(session, reason: error.reason, message: error.message)
        } catch {
            fail(session, reason: .unknown, message: "\(error)")
        }
    }

    // Main sends capture.stop only after capture.started, so a stop never meets `.starting`.
    func stop(id: String) {
        guard case .recording(let recording) = state, recording.session.id == id else {
            output.log(.error, "capture.stop \(id) ignored: no such active session")
            return
        }
        transcribe(recording)
    }

    private func endRecording(_ recording: Recording, reason: CaptureStopReason) {
        output.emit(.captureStopped(id: recording.session.id, reason: reason))
        transcribe(recording)
    }

    private func transcribe(_ recording: Recording) {
        stopSource()
        drain(recording.session, closing: true)
        let session = recording.session
        let samples = recording.samples
        state = .transcribing(recording)
        lastTarget = (session.id, session.frontmostPid)
        let audioMs = Double(samples.count) / sampleRate * 1000
        if samples.count < chunkFrames || rms(samples) < silenceFloor {
            recording.stream?.cancel()
            finish(session, with: .transcript(id: session.id, text: "", audioMs: audioMs, asrMs: 0))
            return
        }
        recording.transcription = Task { @MainActor in
            do {
                let result = try await transcriber.transcribe(samples, language: session.language, stream: recording.stream)
                let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                finish(session, with: .transcript(id: session.id, text: text, audioMs: audioMs, asrMs: result.asrMs))
            } catch let error as TranscribeError {
                finish(session, with: .transcriptFailed(id: session.id, reason: error.reason, message: error.message))
            } catch {
                finish(session, with: .transcriptFailed(id: session.id, reason: .unknown, message: "\(error)"))
            }
        }
    }

    func cancel(id: String) {
        switch state {
        case .starting(let session) where session.id == id:
            _ = session.input.drain(closing: true)
            stopSource()
            state = .idle
            output.emit(.captureCancelled(id: id))
        case .recording(let recording) where recording.session.id == id:
            _ = recording.session.input.drain(closing: true)
            stopSource()
            recording.stream?.cancel()
            state = .idle
            output.emit(.captureCancelled(id: id))
        case .transcribing(let recording) where recording.session.id == id:
            recording.stream?.cancel()
            recording.transcription?.cancel()
            state = .idle
            output.emit(.captureCancelled(id: id))
        default:
            output.log(.error, "capture.cancel \(id) ignored: no such active session")
        }
        prepareIdleMic()
    }

    func shutdown() {
        stopSource()
        disposeMic()
        switch state {
        case .recording(let recording), .transcribing(let recording):
            _ = recording.session.input.drain(closing: true)
            recording.stream?.cancel()
            recording.transcription?.cancel()
        case .starting(let session):
            _ = session.input.drain(closing: true)
        case .idle, .testing:
            break
        }
        state = .idle
    }

    func startTest(id: String, microphone: Microphone?) {
        if case .testing(let current, _) = state { stopTest(id: current) }
        guard case .idle = state else {
            output.emit(.microphoneTestFailed(id: id, message: "Finish dictating, then test again."))
            return
        }
        adopt(microphone)
        beginTest(id: id)
    }

    func stopTest(id: String) {
        guard case .testing(let current, _) = state, current == id else {
            output.log(.info, "microphone.test.stop \(id) ignored: no such test")
            return
        }
        stopSource()
        state = .idle
        output.emit(.microphoneTestEnded(id: id))
        prepareIdleMic()
    }

    func configure(microphone: Microphone?) {
        switch state {
        case .idle:
            adopt(microphone)
            prepareIdleMic()
        case .testing(let id, _):
            self.microphone = microphone
            if let mic, mic.preference?.uid != microphone?.uid { restartTest(id: id) }
        case .starting, .recording, .transcribing:
            self.microphone = microphone
        }
    }

    /// Only while no engine runs: a warm engine on another device is dropped, not stopped.
    private func adopt(_ microphone: Microphone?) {
        self.microphone = microphone
        if mic?.preference?.uid != microphone?.uid { disposeMic() }
    }

    func devicesChanged() {
        if let mic {
            let resolved = try? devices.resolve(mic.preference)
            if resolved?.id != mic.device.id || resolved?.microphone.uid != mic.device.microphone.uid {
                micInvalidated(mic)
            }
        }
        prepareIdleMic()
    }

    func prepareIdleMic() {
        guard case .idle = state, testAudioPath == nil else { return }
        let probe = authorizationStatus
        DispatchQueue.global(qos: .utility).async {
            let authorized = probe() == .authorized
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                microphoneAuthorized = authorized
                guard authorized, case .idle = state, testAudioPath == nil else { return }
                do throws(CaptureError) {
                    adopt(microphone)
                    if let mic { mic.prepare() } else { mic = try makeMic() }
                } catch {
                    output.log(.error, "microphone warmup failed: \(error.message)")
                }
            }
        }
    }

    private func beginTest(id: String) {
        // Chunks hop to main so one that was already in flight at a stop is dropped rather than
        // reported after `ended`.
        let sink: ([Float]) -> Void = { [weak self] chunk in
            let level = perceptualLevel(rms: rms(chunk))
            DispatchQueue.main.async { self?.meter(level, for: id) }
        }
        do {
            if let testAudioPath {
                let file = try FileSource(path: testAudioPath, sink: sink) { [weak self] in self?.stopTest(id: id) }
                state = .testing(id: id, started: false)
                self.file = file
                file.start()
                return
            }
            guard microphoneAuthorized || refreshMicrophoneAuthorization() else {
                throw CaptureError(reason: .permission, message: "Allow microphone access for Voice, then test again.")
            }
            let mic = try self.mic ?? makeMic()
            self.mic = mic
            state = .testing(id: id, started: false)
            try mic.start(sink: sink)
        } catch let error as CaptureError {
            failTest(id: id, message: error.message)
        } catch {
            failTest(id: id, message: "\(error)")
        }
    }

    private func restartTest(id: String) {
        stopSource()
        disposeMic()
        state = .idle
        beginTest(id: id)
    }

    private func meter(_ level: Double, for id: String) {
        guard case .testing(let current, let started) = state, current == id else { return }
        if !started {
            state = .testing(id: id, started: true)
            output.emit(.microphoneTestStarted(id: id))
        }
        output.emit(.microphoneTestLevel(id: id, level: level))
    }

    private func failTest(id: String, message: String) {
        disposeMic()
        stopSource()
        state = .idle
        output.emit(.microphoneTestFailed(id: id, message: message))
        prepareIdleMic()
    }

    private func ingest(_ chunk: [Float], for session: CaptureSession) {
        guard session.input.enqueue(chunk) else { return }
        output.emit(.captureLevel(id: session.id, level: perceptualLevel(rms: rms(chunk))))
        DispatchQueue.main.async { self.drain(session) }
    }

    private func drain(_ session: CaptureSession, closing: Bool = false) {
        for chunk in session.input.drain(closing: closing) {
            MainActor.assumeIsolated { append(chunk, for: session) }
        }
        if !closing, case .recording(let recording) = state, recording.session.id == session.id,
            recording.samples.count >= maxSamples
        {
            endRecording(recording, reason: .maxDuration)
        }
    }

    @MainActor private func append(_ chunk: [Float], for session: CaptureSession) {
        switch state {
        case .starting(let current) where current.id == session.id:
            let recording = Recording(session: current)
            recording.samples = chunk
            state = .recording(recording)
            output.emit(.captureStarted(id: current.id, startMs: current.commandedAt.millisecondsToNow()))
        case .recording(let recording) where recording.session.id == session.id:
            recording.samples.append(contentsOf: chunk)
            if let stream = recording.stream {
                stream.enqueue(chunk)
            } else if recording.samples.count >= StreamingTranscription.minimumSamples,
                let stream = transcriber.beginStreaming(language: session.language)
            {
                recording.stream = stream
                stream.enqueue(recording.samples)
            }
        default:
            break
        }
    }

    private func refreshMicrophoneAuthorization() -> Bool {
        microphoneAuthorized = authorizationStatus() == .authorized
        return microphoneAuthorized
    }

    private func makeMic() throws(CaptureError) -> MicSource {
        try MicSource(device: devices.resolve(microphone), preference: microphone) { [weak self] changed in self?.micInvalidated(changed) }
    }

    private func disposeMic() {
        mic?.dispose()
        mic = nil
    }

    // The engine stops delivering audio on a configuration change. Mid-recording the samples so
    // far are still the user's words, so the change ends the session like a key release.
    private func micInvalidated(_ changed: MicSource) {
        guard changed === mic else { return }
        disposeMic()
        switch state {
        case .starting(let session):
            fail(session, reason: .device, message: "audio device configuration changed")
        case .recording(let recording):
            endRecording(recording, reason: .deviceChanged)
        case .testing(let id, _):
            restartTest(id: id)
        case .idle, .transcribing:
            prepareIdleMic()
        }
    }

    private func fail(_ session: CaptureSession, reason: CaptureFailure, message: String) {
        _ = session.input.drain(closing: true)
        disposeMic()
        stopSource()
        state = .idle
        output.emit(.captureFailed(id: session.id, reason: reason, message: message))
        prepareIdleMic()
    }

    private func finish(_ session: CaptureSession, with event: HelperEvent) {
        guard case .transcribing(let current) = state, current.session.input === session.input else { return }
        output.emit(event)
        state = .idle
        prepareIdleMic()
    }

    private func stopSource() {
        file?.stop()
        file = nil
        mic?.stop()
        outputSilencer.end()
    }
}

private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)

final class MicSource {
    private let engine: AVAudioEngine
    private let converter: AVAudioConverter
    private let sink = OSAllocatedUnfairLock<(([Float]) -> Void)?>(uncheckedState: nil)
    private var observer: NSObjectProtocol?
    let device: AudioInputDevices.Device
    let preference: Microphone?

    init(device: AudioInputDevices.Device, preference: Microphone?, engine: AVAudioEngine = AVAudioEngine(), onConfigurationChange: @escaping (MicSource) -> Void) throws(CaptureError) {
        self.engine = engine
        self.device = device
        self.preference = preference
        let input = engine.inputNode
        guard let audioUnit = input.audioUnit else {
            throw CaptureError(reason: .device, message: "Could not open the selected microphone. Choose another in Settings.")
        }
        var deviceID = device.id
        let status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                          &deviceID, UInt32(MemoryLayout.size(ofValue: deviceID)))
        guard status == noErr else {
            throw CaptureError(reason: .device, message: "Could not use \(device.microphone.name). Choose another microphone in Settings.")
        }
        try Self.checkRoute(audioUnit, expected: device.id)
        let hardware = input.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0, let targetFormat,
            let converter = AVAudioConverter(from: hardware, to: targetFormat)
        else {
            throw CaptureError(reason: .device, message: "no usable audio input device")
        }
        self.converter = converter
        let sink = sink
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(chunkFrames), format: hardware) { buffer, _ in
            guard let deliver = sink.withLockUnchecked({ $0 }) else { return }
            if let chunk = resample(buffer, with: converter, to: targetFormat, endOfStream: false) {
                deliver(chunk)
            }
        }
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.configurationIsUsable() else { return }
                onConfigurationChange(self)
            }
        }
        engine.prepare()
    }

    private func configurationIsUsable() -> Bool {
        let input = engine.inputNode
        guard let audioUnit = input.audioUnit,
            input.outputFormat(forBus: 0).isEqual(converter.inputFormat)
        else { return false }
        do {
            try Self.checkRoute(audioUnit, expected: device.id)
        } catch {
            return false
        }
        return sink.withLockUnchecked { $0 == nil } || engine.isRunning
    }

    private static func checkRoute(_ audioUnit: AudioUnit, expected: AudioDeviceID) throws(CaptureError) {
        var actual = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout.size(ofValue: actual))
        let status = AudioUnitGetProperty(audioUnit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &actual, &size)
        guard status == noErr, actual == expected else {
            throw CaptureError(reason: .device, message: "The selected microphone changed. Choose a microphone in Settings and try again.")
        }
    }

    func prepare() {
        engine.prepare()
    }

    func start(sink deliver: @escaping ([Float]) -> Void) throws(CaptureError) {
        guard let audioUnit = engine.inputNode.audioUnit else {
            throw CaptureError(reason: .device, message: "The selected microphone is unavailable. Choose another in Settings.")
        }
        try Self.checkRoute(audioUnit, expected: device.id)
        // A running engine is a microphone test handing over to dictation. Resetting the converter
        // would race the tap on the audio thread, and the stream is continuous anyway.
        if engine.isRunning {
            sink.withLockUnchecked { $0 = deliver }
            return
        }
        converter.reset()
        sink.withLockUnchecked { $0 = deliver }
        do {
            try engine.start()
        } catch {
            throw CaptureError(reason: .unknown, message: "audio engine failed to start: \(error.localizedDescription)")
        }
    }

    func stop() {
        sink.withLockUnchecked { $0 = nil }
        engine.stop()
    }

    func dispose() {
        sink.withLockUnchecked { $0 = nil }
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
    }
}

private final class FileSource {
    private let samples: [Float]
    private let sink: ([Float]) -> Void
    private let onEnd: () -> Void
    private var offset = 0
    private var timer: DispatchSourceTimer?

    init(path: String, sink: @escaping ([Float]) -> Void, onEnd: @escaping () -> Void) throws {
        do {
            samples = try readAudioFile(at: path)
        } catch {
            throw CaptureError(reason: .unknown, message: "cannot read test audio file: \(error.localizedDescription)")
        }
        self.sink = sink
        self.onEnd = onEnd
    }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: 0.1)
        timer.setEventHandler { [weak self] in self?.tick() }
        self.timer = timer
        timer.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    private func tick() {
        guard offset < samples.count else {
            stop()
            onEnd()
            return
        }
        let end = min(offset + chunkFrames, samples.count)
        sink(Array(samples[offset..<end]))
        offset = end
    }
}

private func readAudioFile(at path: String) throws -> [Float] {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    guard let targetFormat, let converter = AVAudioConverter(from: file.processingFormat, to: targetFormat),
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
    else {
        throw CaptureError(reason: .unknown, message: "unsupported audio format")
    }
    try file.read(into: buffer)
    return resample(buffer, with: converter, to: targetFormat, endOfStream: true) ?? []
}

private func resample(
    _ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat, endOfStream: Bool
) -> [Float]? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var consumed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
        if consumed {
            status.pointee = endOfStream ? .endOfStream : .noDataNow
            return nil
        }
        consumed = true
        status.pointee = .haveData
        return buffer
    }
    guard error == nil, let channel = out.floatChannelData?[0] else { return nil }
    return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
}
