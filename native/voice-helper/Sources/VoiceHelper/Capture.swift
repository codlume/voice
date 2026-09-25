import AVFoundation
import Foundation
import VoiceHelperCore

struct CaptureSession {
    let id: String
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

/// Owns the capture state machine. Every transition happens on the main thread.
final class Capture {
    private let output: Output
    private let transcriber: Transcriber
    private(set) var state: CaptureState = .idle
    private var source: CaptureSource?
    private(set) var lastTarget: (id: String, pid: pid_t?)?
    /// Test hook: when set, sessions read this WAV instead of the microphone.
    var testAudioPath: String?

    init(output: Output, transcriber: Transcriber) {
        self.output = output
        self.transcriber = transcriber
    }

    var isActive: Bool {
        switch state {
        case .starting, .recording: return true
        case .idle, .transcribing: return false
        }
    }

    func start(id: String, frontmostPid: pid_t?, receivedAt: DispatchTime) {
        guard case .idle = state else {
            output.log(.error, "capture.start \(id) ignored: capture is busy")
            return
        }
        let session = CaptureSession(id: id, frontmostPid: frontmostPid, commandedAt: receivedAt)
        let sink: ([Float]) -> Void = { [weak self] chunk in self?.ingest(chunk, for: session) }
        do {
            if let testAudioPath {
                let file = try FileSource(path: testAudioPath, sink: sink) { [weak self] in
                    self?.output.log(.info, "test.audioFile ended")
                }
                state = .starting(session)
                source = file
                file.start()
                return
            }
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
                throw CaptureError(reason: .permission, message: "microphone access is not granted")
            }
            let mic = try MicSource(sink: sink) { [weak self] in self?.deviceChanged(during: session) }
            state = .starting(session)
            source = mic
            try mic.start()
        } catch let error as CaptureError {
            fail(session, reason: error.reason, message: error.message)
        } catch {
            fail(session, reason: .unknown, message: "\(error)")
        }
    }

    func stop(id: String) {
        switch state {
        case .starting(let session) where session.id == id:
            stopSource()
            state = .transcribing(session)
            lastTarget = (session.id, session.frontmostPid)
            finish(session, with: .transcript(id: session.id, text: "", audioMs: 0, asrMs: 0))
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
                    let result = try await transcriber.transcribe(samples)
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
    }

    func shutdown() {
        stopSource()
        state = .idle
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

    private func deviceChanged(during session: CaptureSession) {
        switch state {
        case .starting(let current) where current.id == session.id:
            fail(current, reason: .device, message: "audio device configuration changed")
        case .recording(let recording) where recording.session.id == session.id:
            fail(recording.session, reason: .device, message: "audio device configuration changed")
        default:
            break
        }
    }

    private func fail(_ session: CaptureSession, reason: CaptureFailure, message: String) {
        stopSource()
        state = .idle
        output.emit(.captureFailed(id: session.id, reason: reason, message: message))
    }

    private func finish(_ session: CaptureSession, with event: HelperEvent) {
        guard case .transcribing(let current) = state, current.id == session.id else { return }
        output.emit(event)
        state = .idle
    }

    private func stopSource() {
        source?.stop()
        source = nil
    }
}

private protocol CaptureSource: AnyObject {
    func stop()
}

private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)

private final class MicSource: CaptureSource {
    private let engine = AVAudioEngine()
    private var observer: NSObjectProtocol?

    init(sink: @escaping ([Float]) -> Void, onConfigurationChange: @escaping () -> Void) throws {
        let input = engine.inputNode
        let hardware = input.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0, let targetFormat,
            let converter = AVAudioConverter(from: hardware, to: targetFormat)
        else {
            throw CaptureError(reason: .device, message: "no usable audio input device")
        }
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(chunkFrames), format: hardware) { buffer, _ in
            if let chunk = resample(buffer, with: converter, to: targetFormat, endOfStream: false) {
                sink(chunk)
            }
        }
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { _ in onConfigurationChange() }
    }

    func start() throws {
        engine.prepare()
        do {
            try engine.start()
        } catch {
            throw CaptureError(reason: .unknown, message: "audio engine failed to start: \(error.localizedDescription)")
        }
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
    }
}

/// Feeds a WAV file through the same append path at real-time pace.
private final class FileSource: CaptureSource {
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
