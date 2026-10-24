import CoreAudio
import Foundation
import VoiceHelperCore

private let deviceListAddress = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)

final class OutputLowering {
    private let output: Output
    private let suppression: OutputSuppression
    private var listener: AudioObjectPropertyListenerBlock?
    private var generation = 0

    init(output: Output, stateDir: URL) {
        self.output = output
        let store = OutputRestoreFile(url: stateDir.appendingPathComponent("output-restore.json")) { output.log(.error, $0) }
        suppression = OutputSuppression(controls: CoreAudioOutputControls(onError: { output.log(.error, $0) }), store: store) { output.log(.error, $0) }
    }

    func begin(scale: Float) {
        installListener()
        suppression.begin(scale: scale)
    }

    func recover() {
        end()
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

struct OutputRestoreFile: OutputOriginalsStore {
    let url: URL
    private let onError: (String) -> Void

    init(url: URL, onError: @escaping (String) -> Void) {
        self.url = url
        self.onError = onError
    }

    func load() throws -> [String: [OutputControl]] {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch CocoaError.fileReadNoSuchFile {
            return [:]
        }
        do {
            return try JSONDecoder().decode([String: [OutputControl]].self, from: data)
        } catch let error as DecodingError {
            onError("discarding unreadable \(url.lastPathComponent): \(error)")
            try FileManager.default.removeItem(at: url)
            return [:]
        }
    }

    func save(_ originals: [String: [OutputControl]]) throws {
        if originals.isEmpty {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            return
        }
        try JSONEncoder().encode(originals).write(to: url, options: .atomic)
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
        let groups = [[UInt32(0)], Array(UInt32(1)...channels)]
        func elements(_ selector: AudioObjectPropertySelector) -> [UInt32] {
            groups.first { $0.allSatisfy { writable(device, selector: selector, element: $0) } } ?? []
        }
        let mutes = try elements(kAudioDevicePropertyMute).map { element in
            OutputControl.mute(element: element, value: try read(device, selector: kAudioDevicePropertyMute, element: element, initial: UInt32(0)))
        }
        let volumes = try elements(kAudioDevicePropertyVolumeScalar).map { element in
            OutputControl.volume(element: element, value: try read(device, selector: kAudioDevicePropertyVolumeScalar, element: element, initial: Float32(0)))
        }
        guard !mutes.isEmpty || !volumes.isEmpty else {
            throw AudioOutputError(description: "output has no writable mute or volume controls")
        }
        return mutes + volumes
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
