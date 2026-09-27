import AVFoundation
import Foundation
import VoiceHelperCore
import os

struct CaptureSession {
    let id: String
    let language: DictationLanguage
    let frontmostPid: pid_t?
    let commandedAt: DispatchTime
}

final class Recording {
    let session: CaptureSession
    var samples: [Float] = []

    init(session: CaptureSession) {
        self.session = session
    }
}

enum CaptureState {
    case idle
    case starting(CaptureSession)
    case recording(Recording)
    case transcribing(CaptureSession)
}

struct CaptureError: Error {
    let reason: CaptureFailure
    let message: String
}

private let sampleRate = 16_000.0
private let chunkFrames = 1600
private let maxSamples = 600 * 16_000
private let silenceFloor = 1e-4 as Float

/// Owned by the main thread. `isActive` is the one reader on another thread: the hotkey tap
/// asks it before consuming Escape.
final class Capture {
    private let output: Output
    private let transcriber: Transcriber
    private let outputSilencer: OutputSilencer
    private var state: CaptureState = .idle {
        didSet {
            let active: Bool
            switch state {
            case .starting, .recording: active = true
            case .idle, .transcribing: active = false
            }
            activeFlag.withLock { $0 = active }
        }
    }
    private let activeFlag = OSAllocatedUnfairLock(initialState: false)
    private var mic: MicSource?
    private var file: FileSource?
    private(set) var lastTarget: (id: String, pid: pid_t?)?
    var testAudioPath: String?

    init(output: Output, transcriber: Transcriber) {
        self.output = output
        self.transcriber = transcriber
        self.outputSilencer = OutputSilencer(output: output)
    }

    var isActive: Bool { activeFlag.withLock { $0 } }

    func start(id: String, language: DictationLanguage, frontmostPid: pid_t?, receivedAt: DispatchTime, muteWhileDictating: Bool) {
        guard case .idle = state else {
            output.emit(.captureFailed(id: id, reason: .busy, message: "capture is busy with another session"))
            return
        }
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
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
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
        switch state {
        case .recording(let recording) where recording.session.id == id:
            stopSource()
            let session = recording.session
            let samples = recording.samples
            state = .transcribing(session)
            lastTarget = (session.id, session.frontmostPid)
            let audioMs = Double(samples.count) / sampleRate * 1000
            if samples.count < chunkFrames || rms(samples) < silenceFloor {
                finish(session, with: .transcript(id: session.id, text: "", audioMs: audioMs, asrMs: 0))
                return
            }
            Task { @MainActor in
                do {
                    let result = try await transcriber.transcribe(samples, language: session.language)
                    let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    finish(session, with: .transcript(id: session.id, text: text, audioMs: audioMs, asrMs: result.asrMs))
                } catch let error as TranscribeError {
                    finish(session, with: .transcriptFailed(id: session.id, reason: error.reason, message: error.message))
                } catch {
                    finish(session, with: .transcriptFailed(id: session.id, reason: .unknown, message: "\(error)"))
                }
            }
        default:
            output.log(.error, "capture.stop \(id) ignored: no such active session")
        }
    }

    func cancel(id: String) {
        switch state {
        case .starting(let session) where session.id == id:
            stopSource()
            state = .idle
            output.emit(.captureCancelled(id: id))
        case .recording(let recording) where recording.session.id == id:
            stopSource()
            state = .idle
            output.emit(.captureCancelled(id: id))
        case .transcribing(let session) where session.id == id:
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
        state = .idle
    }

    func prepareIdleMic() {
        DispatchQueue.main.async { [weak self] in
            guard let self, case .idle = state, testAudioPath == nil,
                AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
            else { return }
            do throws(CaptureError) {
                if let mic { mic.prepare() } else { mic = try makeMic() }
            } catch {
                output.log(.error, "microphone warmup failed: \(error.message)")
            }
        }
    }

    private func ingest(_ chunk: [Float], for session: CaptureSession) {
        output.emit(.captureLevel(id: session.id, level: perceptualLevel(rms: rms(chunk))))
        DispatchQueue.main.async { self.append(chunk, for: session) }
    }

    private func append(_ chunk: [Float], for session: CaptureSession) {
        switch state {
        case .starting(let current) where current.id == session.id:
            let recording = Recording(session: current)
            recording.samples = chunk
            state = .recording(recording)
            output.emit(.captureStarted(id: current.id, startMs: current.commandedAt.millisecondsToNow()))
        case .recording(let recording) where recording.session.id == session.id:
            recording.samples.append(contentsOf: chunk)
            if recording.samples.count >= maxSamples {
                stop(id: session.id)
            }
        default:
            break
        }
    }

    private func makeMic() throws(CaptureError) -> MicSource {
        try MicSource { [weak self] changed in self?.micInvalidated(changed) }
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
            stop(id: recording.session.id)
        case .idle, .transcribing:
            prepareIdleMic()
        }
    }

    private func fail(_ session: CaptureSession, reason: CaptureFailure, message: String) {
        disposeMic()
        stopSource()
        state = .idle
        output.emit(.captureFailed(id: session.id, reason: reason, message: message))
        prepareIdleMic()
    }

    private func finish(_ session: CaptureSession, with event: HelperEvent) {
        guard case .transcribing(let current) = state, current.id == session.id else { return }
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

private let defaultInputAddress = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)

private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)

private final class MicSource {
    private let engine = AVAudioEngine()
    private let converter: AVAudioConverter
    private let sink = OSAllocatedUnfairLock<(([Float]) -> Void)?>(uncheckedState: nil)
    private var observer: NSObjectProtocol?
    private var defaultInputListener: AudioObjectPropertyListenerBlock?

    init(onConfigurationChange: @escaping (MicSource) -> Void) throws(CaptureError) {
        let input = engine.inputNode
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
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            if let self { onConfigurationChange(self) }
        }
        // A stopped engine gets no configuration change when the default input switches, so a
        // warm engine would otherwise start on the previous device.
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            if let self { onConfigurationChange(self) }
        }
        var address = defaultInputAddress
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listener) == noErr {
            defaultInputListener = listener
        }
        engine.prepare()
    }

    func prepare() {
        engine.prepare()
    }

    func start(sink deliver: @escaping ([Float]) -> Void) throws(CaptureError) {
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
        if let defaultInputListener {
            var address = defaultInputAddress
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, defaultInputListener)
        }
        defaultInputListener = nil
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
