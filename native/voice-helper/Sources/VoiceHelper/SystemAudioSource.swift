import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation
import VoiceHelperCore

/// Everything the Mac plays except Voice itself, through a Core Audio process tap on a private
/// aggregate device that holds only the tap. With no output device in the aggregate, switching
/// headphones and speakers mid-meeting cannot take the tap's clock away.
@available(macOS 14.4, *)
final class SystemAudioSource {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private let description: CATapDescription
    private let pipeline: MicPipeline
    private var pump: DispatchSourceTimer?
    private var sink: (([Float]) -> Void)?
    private var processListener: AudioObjectPropertyListenerBlock?

    init() throws(CaptureError) {
        description = CATapDescription(monoGlobalTapButExcludeProcesses: voiceProcessObjects())
        description.name = "Voice meeting"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        guard AudioHardwareCreateProcessTap(description, &tap) == noErr,
              let tapUID = readString(tap, kAudioTapPropertyUID),
              let sampleRate = readValue(tap, kAudioTapPropertyFormat, AudioStreamBasicDescription()).map({ $0.mSampleRate }),
              let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)
        else {
            Self.destroy(tap: tap, aggregate: aggregate)
            throw CaptureError(reason: .device, message: "Could not open system audio.")
        }
        let config: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Voice meeting",
            kAudioAggregateDeviceUIDKey: "com.voice.meeting.tap." + UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: true]],
        ]
        do {
            pipeline = try MicPipeline(hardware: mono)
        } catch {
            Self.destroy(tap: tap, aggregate: aggregate)
            throw error
        }
        let pipeline = pipeline
        guard AudioHardwareCreateAggregateDevice(config as CFDictionary, &aggregate) == noErr,
              AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, nil, { _, input, _, _, _ in
                  pipeline.receive(input, frames: Int(input.pointee.mBuffers.mDataByteSize) / MemoryLayout<Float>.size)
              }) == noErr
        else {
            Self.destroy(tap: tap, aggregate: aggregate)
            throw CaptureError(reason: .device, message: "Could not open system audio.")
        }
        watchProcesses()
    }

    func start(sink deliver: @escaping ([Float]) -> Void) throws(CaptureError) {
        pipeline.start()
        sink = deliver
        guard AudioDeviceStart(aggregate, ioProc) == noErr else {
            sink = nil
            pipeline.discard()
            throw CaptureError(reason: .device, message: "Could not start system audio.")
        }
        let pump = DispatchSource.makeTimerSource(queue: .main)
        pump.schedule(deadline: .now() + 0.1, repeating: 0.1, leeway: .milliseconds(10))
        pump.setEventHandler { [weak self] in
            guard let self else { return }
            let chunk = pipeline.pull()
            if !chunk.isEmpty { sink?(chunk) }
        }
        self.pump = pump
        pump.resume()
    }

    var droppedFrames: Int { pipeline.droppedFrames }

    /// Delivers the tail and releases the tap; the source cannot start again.
    func stop() {
        pump?.cancel()
        pump = nil
        if let ioProc {
            AudioDeviceStop(aggregate, ioProc)
            AudioDeviceDestroyIOProcID(aggregate, ioProc)
        }
        ioProc = nil
        let tail = pipeline.finish()
        if !tail.isEmpty { sink?(tail) }
        sink = nil
        if let processListener {
            var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, processListener)
        }
        processListener = nil
        Self.destroy(tap: tap, aggregate: aggregate)
        tap = AudioObjectID(kAudioObjectUnknown)
        aggregate = AudioObjectID(kAudioObjectUnknown)
    }

    // Voice's renderer and utility processes register with Core Audio only when they first make a
    // sound, so the exclusion list follows the process list for the whole meeting.
    private func watchProcesses() {
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self, tap != kAudioObjectUnknown else { return }
            let excluded = voiceProcessObjects()
            guard excluded != description.processes else { return }
            description.processes = excluded
            var address = propertyAddress(kAudioTapPropertyDescription)
            var value = description
            AudioObjectSetPropertyData(tap, &address, 0, nil, UInt32(MemoryLayout<CATapDescription>.size), &value)
        }
        var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listener) == noErr {
            processListener = listener
        }
    }

    private static func destroy(tap: AudioObjectID, aggregate: AudioObjectID) {
        if aggregate != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregate) }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
    }
}

/// Core Audio process objects that belong to Voice: the helper, the app that launched it, and the
/// app's own child processes.
private func voiceProcessObjects() -> [AudioObjectID] {
    let app = getppid()
    return readObjects(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).filter { object in
        guard let pid = readValue(object, kAudioProcessPropertyPID, pid_t(0)) else { return false }
        return pid == getpid() || pid == app || parentPid(of: pid) == app
    }
}

private func parentPid(of pid: pid_t) -> pid_t? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&name, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
    return info.kp_eproc.e_ppid
}

private func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

private func readValue<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var address = propertyAddress(selector)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
}

private func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = propertyAddress(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

private func readObjects(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
    var address = propertyAddress(selector)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &objects) == noErr else { return [] }
    return objects
}

/// System Audio Recording has no public status API. TCC's own preflight answers it; a build
/// without the symbol reports "not determined" and lets the first tap start ask.
enum SystemAudioAccess {
    private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
    private typealias Request = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void
    private static let service = "kTCCServiceAudioCapture" as CFString
    private static let framework = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)

    static var state: SystemAudioPermission {
        guard #available(macOS 14.4, *) else { return .unavailable }
        guard let symbol = dlsym(framework, "TCCAccessPreflight") else { return .notDetermined }
        switch unsafeBitCast(symbol, to: Preflight.self)(service, nil) {
        case 0: return .granted
        case 1: return .denied
        default: return .notDetermined
        }
    }

    static func request(_ done: @escaping () -> Void) {
        guard #available(macOS 14.4, *), let symbol = dlsym(framework, "TCCAccessRequest") else { return done() }
        unsafeBitCast(symbol, to: Request.self)(service, nil) { _ in DispatchQueue.main.async(execute: done) }
    }
}
