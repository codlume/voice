import CoreAudio
import Foundation
import VoiceHelperCore

final class AudioInputDevices {
    struct Device {
        let id: AudioDeviceID
        let microphone: Microphone
    }

    private let output: Output
    private var devices: [Device] = []
    private var defaultUID: String?
    private var available = false
    private var listeners: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    var onChange: (() -> Void)?

    init(output: Output) {
        self.output = output
        for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice] {
            var address = Self.address(selector)
            let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.refresh() }
            if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listener) == noErr {
                listeners.append((address, listener))
            } else {
                output.log(.error, "could not monitor microphone changes")
            }
        }
        refresh()
    }

    func shutdown() {
        onChange = nil
        for (var address, listener) in listeners {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listener)
        }
        listeners.removeAll()
    }

    func resolve(_ preference: Microphone?) throws(CaptureError) -> Device {
        guard available else {
            throw CaptureError(reason: .device, message: "Could not list microphones. Reopen Voice to try again.")
        }
        return try Self.resolve(preference, devices: devices, defaultUID: defaultUID)
    }

    static func resolve(_ preference: Microphone?, devices: [Device], defaultUID: String?) throws(CaptureError) -> Device {
        let uid = preference?.uid ?? defaultUID
        guard let device = devices.first(where: { $0.microphone.uid == uid }) else {
            let message = preference.map { "\($0.name) is unavailable. Reconnect it or choose another microphone in Settings." }
                ?? "No default microphone is available. Choose a microphone in Settings."
            throw CaptureError(reason: .device, message: message)
        }
        return device
    }

    private func refresh() {
        do {
            let next = try Self.readDevices()
            var address = Self.address(kAudioHardwarePropertyDefaultInputDevice)
            var defaultID = AudioDeviceID(kAudioObjectUnknown)
            var size = UInt32(MemoryLayout.size(ofValue: defaultID))
            try Self.check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &defaultID))
            devices = next
            defaultUID = next.first(where: { $0.id == defaultID })?.microphone.uid
            available = true
            output.emit(.microphonesChanged(devices: next.map(\.microphone), defaultUid: defaultUID))
            onChange?()
        } catch {
            available = false
            output.emit(.microphonesUnavailable(message: "Could not list microphones. Reopen Voice to try again."))
            output.log(.error, "microphone list failed: \(error)")
        }
    }

    static func readDevices() throws -> [Device] {
        var address = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        try check(AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size))
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        try check(AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids))
        return try ids.compactMap { id -> Device? in
            guard try inputChannels(id) > 0 else { return nil }
            let uid = try string(id, selector: kAudioDevicePropertyDeviceUID)
            let name = try string(id, selector: kAudioObjectPropertyName)
            guard !uid.isEmpty, !name.isEmpty else { return nil }
            return Device(id: id, microphone: Microphone(uid: uid, name: name))
        }.sorted {
            let order = $0.microphone.name.localizedStandardCompare($1.microphone.name)
            return order == .orderedSame ? $0.microphone.uid < $1.microphone.uid : order == .orderedAscending
        }
    }

    private static func string(_ device: AudioDeviceID, selector: AudioObjectPropertySelector) throws -> String {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout.size(ofValue: value))
        try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value))
        guard let value else { throw CaptureError(reason: .device, message: "microphone has no name or UID") }
        return (value.takeRetainedValue() as String).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func inputChannels(_ device: AudioDeviceID) throws -> UInt32 {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
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
            throw CaptureError(reason: .device, message: "invalid microphone channel configuration")
        }
        return UnsafeMutableAudioBufferListPointer(buffers).reduce(0) { $0 + $1.mNumberChannels }
    }

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private static func check(_ status: OSStatus) throws {
        guard status == noErr else { throw CaptureError(reason: .device, message: "CoreAudio failed (\(status))") }
    }
}
