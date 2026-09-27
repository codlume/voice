import CoreAudio
import Foundation
import VoiceHelperCore

private let deviceListAddress = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)

final class OutputSilencer {
    private let output: Output
    private let suppression: OutputSuppression
    private var listener: AudioObjectPropertyListenerBlock?
    private var generation = 0

    init(output: Output) {
        self.output = output
        suppression = OutputSuppression(controls: CoreAudioOutputControls(onError: { output.log(.error, $0) })) { output.log(.error, $0) }
    }

    func begin() {
        installListener()
        suppression.begin()
    }

    func end() {
        removeListener()
        suppression.end()
        if suppression.needsDeviceListener { installListener() }
    }

    private func installListener() {
        guard listener == nil else { return }
        let current = generation
        let callback: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self, generation == current else { return }
            suppression.reconcile()
            if !suppression.needsDeviceListener { removeListener() }
        }
        var address = deviceListAddress
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &address, .main, callback)
        if status == noErr {
            listener = callback
        } else {
            output.log(.error, "could not monitor audio outputs: \(status)")
        }
    }

    private func removeListener() {
        generation += 1
        guard let listener else { return }
        var address = deviceListAddress
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listener)
        self.listener = nil
    }
}

private struct AudioOutputError: Error, CustomStringConvertible {
    let description: String
}

private final class CoreAudioOutputControls: OutputControls {
    private let onError: (String) -> Void

    init(onError: @escaping (String) -> Void) { self.onError = onError }

    func devices() throws -> [String] {
        try deviceIDs().compactMap { device in
            do {
                guard try channelCount(device) > 0 else { return nil }
                return try uid(device)
            } catch {
                onError("could not inspect audio output: \(error)")
                return nil
            }
        }
    }

    func snapshot(uid: String) throws -> [OutputControl] {
        let device = try resolve(uid)
        let channels = try channelCount(device)
        guard channels > 0 else { throw AudioOutputError(description: "output has no channels") }
        let elements = [UInt32(0)]
        let channelElements = Array(UInt32(1)...channels)
        for selector in [kAudioDevicePropertyMute, kAudioDevicePropertyVolumeScalar] {
            for group in [elements, channelElements] {
                guard group.allSatisfy({ writable(device, selector: selector, element: $0) }) else { continue }
                return try group.map { element in
                    if selector == kAudioDevicePropertyMute {
                        return .mute(element: element, value: try read(device, selector: selector, element: element, initial: UInt32(0)))
                    }
                    return .volume(element: element, value: try read(device, selector: selector, element: element, initial: Float32(0)))
                }
            }
        }
        throw AudioOutputError(description: "output has no writable mute or volume controls")
    }

    func write(uid: String, control: OutputControl) throws {
        let device = try resolve(uid)
        switch control {
        case .mute(let element, var value):
            var address = address(kAudioDevicePropertyMute, element: element)
            try check(AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout.size(ofValue: value)), &value))
        case .volume(let element, var value):
            var address = address(kAudioDevicePropertyVolumeScalar, element: element)
            try check(AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout.size(ofValue: value)), &value))
        }
    }

    private func resolve(_ expected: String) throws -> AudioDeviceID {
        for device in try deviceIDs() where (try? uid(device)) == expected { return device }
        throw AudioOutputError(description: "audio output disconnected")
    }

    private func deviceIDs() throws -> [AudioDeviceID] {
        var address = deviceListAddress
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        try check(AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size))
        var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        try check(AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices))
        return devices
    }

    private func uid(_ device: AudioDeviceID) throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout.size(ofValue: value))
        try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value))
        guard let value else { throw AudioOutputError(description: "audio output has no UID") }
        return value.takeRetainedValue() as String
    }

    private func channelCount(_ device: AudioDeviceID) throws -> UInt32 {
        var address = address(kAudioDevicePropertyStreamConfiguration)
        var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size))
        guard size >= MemoryLayout<AudioBufferList>.size else { return 0 }
        let capacity = size
        let memory = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { memory.deallocate() }
        try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, memory))
        let buffers = memory.assumingMemoryBound(to: AudioBufferList.self)
        let headerSize = MemoryLayout<AudioBufferList>.offset(of: \.mBuffers) ?? 8
        let requiredSize = headerSize + Int(buffers.pointee.mNumberBuffers) * MemoryLayout<AudioBuffer>.stride
        guard requiredSize <= Int(capacity), requiredSize <= Int(size) else {
            throw AudioOutputError(description: "invalid audio channel configuration")
        }
        return UnsafeMutableAudioBufferListPointer(buffers).reduce(0) { $0 + $1.mNumberChannels }
    }

    private func address(_ selector: AudioObjectPropertySelector, element: UInt32 = 0) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioDevicePropertyScopeOutput, mElement: element)
    }

    private func writable(_ device: AudioDeviceID, selector: AudioObjectPropertySelector, element: UInt32) -> Bool {
        var address = address(selector, element: element)
        var settable: DarwinBoolean = false
        return AudioObjectHasProperty(device, &address)
            && AudioObjectIsPropertySettable(device, &address, &settable) == noErr && settable.boolValue
    }

    private func read<T: BitwiseCopyable>(_ device: AudioDeviceID, selector: AudioObjectPropertySelector, element: UInt32, initial: T) throws -> T {
        var value = initial
        var address = address(selector, element: element)
        var size = UInt32(MemoryLayout<T>.size)
        try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value))
        return value
    }

    private func check(_ status: OSStatus) throws {
        if status != noErr { throw AudioOutputError(description: "CoreAudio status \(status)") }
    }
}
