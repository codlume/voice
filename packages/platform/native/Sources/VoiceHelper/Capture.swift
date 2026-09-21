import Foundation
@preconcurrency import AVFoundation
import AudioToolbox
import CoreAudio
import VoiceHelperProtocol

// All capture state and conversion run on this queue. Tap buffers are copied before leaving the callback.
final class CaptureService: @unchecked Sendable {
    private let lifetime = DispatchGroup()
    private var inputBuffers = CaptureBuffers()
    private var stopping = false
    private var stopFailed = false
    private let queue = DispatchQueue(label: "voice.capture")
    private let emit: @Sendable (Data) -> Void
    private let fixture: Bool
    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var timer: DispatchSourceTimer?
    private var watchdog: DispatchSourceTimer?
    private var observer: NSObjectProtocol?
    private var identity: CaptureRequest?
    private var fixtureFrames = 0
    private var frames = 0
    private var samples = 0
    private var lastFrame = DispatchTime.now()
    init(fixture: Bool, emit: @escaping @Sendable (Data) -> Void) { self.fixture = fixture; self.emit = emit }

    func receive(_ request: CaptureRequest) {
        queue.async {
            if request.type == "capture.start" {
                guard self.identity == nil else { return }
                self.identity = request; self.frames = 0; self.samples = 0; self.fixtureFrames = 0
                self.stopping = false; self.stopFailed = false; self.inputBuffers = CaptureBuffers(); self.lifetime.enter()
                do { try self.start(device: request.device) } catch { self.finish(failed: true) }
            } else if self.identity?.session == request.session && self.identity?.attempt == request.attempt {
                self.finish(failed: false)
            }
        }
    }
    func disconnect() { queue.sync { finish(failed: false) }; lifetime.wait() }
    private func send(_ type: String, extra: [String: Any] = [:]) {
        guard let identity else { return }
        var object = extra
        object["type"] = type; object["session"] = identity.session; object["attempt"] = identity.attempt
        if let data = try? JSONSerialization.data(withJSONObject: object) { emit(data) }
    }
    private func pcm(_ data: Data) {
        guard identity != nil, !data.isEmpty else { return }
        let remaining = (4_800_000 - samples) * 2
        guard remaining > 0 else { finish(failed: false); return }
        let limited = data.prefix(remaining)
        for offset in stride(from: 0, to: limited.count, by: 640) {
            let frame = limited.subdata(in: offset..<min(offset + 640, limited.count))
            send("capture.frame", extra: ["sequence": frames, "pcm": frame.base64EncodedString()])
            frames += 1; samples += frame.count / 2
        }
        lastFrame = .now()
        if samples == 4_800_000 { finish(failed: false) }
    }
    private func start(device: String?) throws {
        lastFrame = .now()
        let watchdog = DispatchSource.makeTimerSource(queue: queue)
        watchdog.schedule(deadline: .now() + 1, repeating: 1)
        watchdog.setEventHandler { [weak self] in
            guard let self, self.identity != nil else { return }
            if DispatchTime.now().uptimeNanoseconds - self.lastFrame.uptimeNanoseconds > 2_000_000_000 || (!self.fixture && AVCaptureDevice.authorizationStatus(for: .audio) != .authorized) { self.finish(failed: true) }
        }
        self.watchdog = watchdog; watchdog.resume()
        if fixture, ProcessInfo.processInfo.environment["VOICE_TEST_SAMPLE_RATE"] == "48000" {
            guard let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false),
                  let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
                  let converter = AVAudioConverter(from: input, to: output) else { throw CaptureError.unavailable }
            self.converter = converter; converter.primeMethod = .none
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + .milliseconds(20), repeating: .milliseconds(20))
            timer.setEventHandler { [weak self] in
                guard let self, let buffer = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: 1024), let pointer = buffer.floatChannelData?[0] else { return }
                buffer.frameLength = 1024
                for index in 0..<1024 { pointer[index] = self.fixtureFrames == 9 && index == 1023 ? 0.75 : 0 }
                self.fixtureFrames += 1
                if self.fixtureFrames == 10 {
                    // Emulate a tap that accepted its final buffer before Stop but has not queued conversion yet.
                    let accepted = self.inputBuffers
                    guard accepted.begin() == .accepted else { self.finish(failed: true); return }
                    self.finish(failed: false)
                    self.queue.async { [weak self] in self?.convert(buffer); accepted.complete() }
                } else { self.convert(buffer) }
            }
            self.timer = timer; timer.resume(); return
        }
        if fixture {
            guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
                  let converter = AVAudioConverter(from: format, to: format) else { throw CaptureError.unavailable }
            self.converter = converter
            converter.primeMethod = .none
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + .milliseconds(20), repeating: .milliseconds(20))
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                let values = (0..<320).map { index in Int16(sin(Double(self.samples + index) * 2 * .pi * 440 / 16000) * 8000).littleEndian }
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 320), let destination = buffer.int16ChannelData?[0] else { self.finish(failed: true); return }
                buffer.frameLength = 320
                values.withUnsafeBufferPointer { source in if let base = source.baseAddress { destination.update(from: base, count: 320) } }
                self.convert(buffer)
            }
            self.timer = timer; timer.resume(); return
        }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw CaptureError.unavailable }
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        if let device {
            var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslateUIDToDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var uid: CFString = device as CFString
            var id = AudioDeviceID(0)
            let status = withUnsafeMutablePointer(to: &uid) { uidPointer in
                withUnsafeMutablePointer(to: &id) { idPointer in
                    var translation = AudioValueTranslation(mInputData: uidPointer, mInputDataSize: UInt32(MemoryLayout<CFString>.size), mOutputData: idPointer, mOutputDataSize: UInt32(MemoryLayout<AudioDeviceID>.size))
                    var size = UInt32(MemoryLayout<AudioValueTranslation>.size)
                    return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &translation)
                }
            }
            guard status == noErr, id != 0, let unit = input.audioUnit,
                  AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else { throw CaptureError.unavailable }
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: output) else { throw CaptureError.unavailable }
        self.converter = converter
        converter.primeMethod = .none
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.queue.async { [weak self] in self?.finish(failed: true) }
        }
        let captureID = identity?.attempt
        let accepted = inputBuffers
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            switch accepted.begin() {
            case .closed: return
            case .full:
                self.queue.async { [weak self] in if self?.identity?.attempt == captureID { self?.finish(failed: true) } }; return
            case .accepted: break
            }
            guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { accepted.complete(); self.queue.async { [weak self] in self?.finish(failed: true) }; return }
            copy.frameLength = buffer.frameLength
            let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
            let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
            for (from, to) in zip(source, destination) {
                if let src = from.mData, let dst = to.mData { memcpy(dst, src, Int(from.mDataByteSize)) }
            }
            self.queue.async { [weak self] in
                guard let self else { return }
                defer { accepted.complete() }
                if self.identity?.attempt == captureID { self.convert(copy) }
            }
        }
        engine.prepare()
        try engine.start()
    }
    private func convert(_ buffer: AVAudioPCMBuffer) {
        guard identity != nil, let converter,
              let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate)) + 64) else { return }
        let input = ConverterInput(buffer)
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            guard let buffer = input.take() else { inputStatus.pointee = .noDataNow; return nil }
            inputStatus.pointee = .haveData; return buffer
        }
        guard status != .error, error == nil, let pointer = output.int16ChannelData?[0] else { finish(failed: true); return }
        pcm(Data(bytes: pointer, count: Int(output.frameLength) * 2))
    }
    private func finish(failed: Bool) {
        guard identity != nil else { return }
        stopFailed = stopFailed || failed
        guard !stopping else { return }
        stopping = true
        // Close admission before removing the tap. Already accepted copies own a group entry
        // until conversion finishes, even if their callback has not enqueued that work yet.
        inputBuffers.close()
        timer?.cancel(); timer = nil; watchdog?.cancel(); watchdog = nil
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine?.inputNode.removeTap(onBus: 0); engine?.stop(); engine = nil
        inputBuffers.drained(on: queue) { [weak self] in self?.completeStop() }
    }
    private func completeStop() {
        if let converter {
            var drained = false
            for _ in 0..<8 {
                guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 4096) else { break }
                var error: NSError?
                let status = converter.convert(to: output, error: &error) { _, inputStatus in
                    inputStatus.pointee = .endOfStream; return nil
                }
                if let pointer = output.int16ChannelData?[0], output.frameLength > 0 {
                    pcm(Data(bytes: pointer, count: Int(output.frameLength) * 2))
                }
                if error != nil || status == .error { break }
                if status == .endOfStream { drained = true; break }
            }
            if !drained { stopFailed = true }
        }
        converter = nil
        if stopFailed { send("capture.failed") }
        else { send("capture.stopped", extra: ["frames": frames, "samples": samples]) }
        identity = nil
        lifetime.leave()
    }
    private enum CaptureError: Error { case unavailable }
}

// AVAudioConverter declares a sendable input callback even though conversion is synchronous.
private final class ConverterInput: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: AVAudioPCMBuffer?
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
    func take() -> AVAudioPCMBuffer? {
        lock.lock(); defer { lock.unlock() }
        let value = buffer; buffer = nil; return value
    }
}

// Admission and group entry are atomic so Stop cannot overtake a copied tap buffer.
private final class CaptureBuffers: @unchecked Sendable {
    enum Admission { case accepted, closed, full }
    private let lock = NSLock()
    private let group = DispatchGroup()
    private var open = true
    private var pending = 0
    func begin() -> Admission {
        lock.lock(); defer { lock.unlock() }
        guard open else { return .closed }
        guard pending < 32 else { return .full }
        pending += 1; group.enter(); return .accepted
    }
    func complete() {
        lock.lock(); pending -= 1; lock.unlock(); group.leave()
    }
    func close() { lock.lock(); open = false; lock.unlock() }
    func drained(on queue: DispatchQueue, _ action: @escaping @Sendable () -> Void) { group.notify(queue: queue, execute: action) }
}
