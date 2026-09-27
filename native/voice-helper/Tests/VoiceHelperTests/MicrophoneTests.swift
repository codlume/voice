import AVFoundation
import CoreAudio
import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

@Test(.enabled(if: ProcessInfo.processInfo.environment["VOICE_MICROPHONE_SMOKE"] == "1"))
func availableMicrophonesCanBeRoutedWithoutRecording() throws {
    let devices = try AudioInputDevices.readDevices()
    #expect(!devices.isEmpty)
    for device in devices {
        let source = try MicSource(device: device, preference: device.microphone) { _ in }
        source.dispose()
    }
}

@Test(.enabled(if: ProcessInfo.processInfo.environment["VOICE_MICROPHONE_SMOKE"] == "1"))
func unknownMicrophoneCannotSilentlyUseTheDefault() throws {
    let device = AudioInputDevices.Device(id: AudioDeviceID.max, microphone: Microphone(uid: "missing", name: "Missing microphone"))
    #expect(throws: CaptureError.self) {
        let source = try MicSource(device: device, preference: device.microphone) { _ in }
        source.dispose()
    }
}

@Test func microphoneSelectionUsesStableUIDAndNeverFallsBack() throws {
    let first = AudioInputDevices.Device(id: 1, microphone: Microphone(uid: "one", name: "USB Microphone"))
    let second = AudioInputDevices.Device(id: 2, microphone: Microphone(uid: "two", name: "USB Microphone"))
    let devices = [first, second]
    #expect(try AudioInputDevices.resolve(nil, devices: devices, defaultUID: "one").id == 1)
    #expect(try AudioInputDevices.resolve(nil, devices: devices, defaultUID: "two").id == 2)
    #expect(try AudioInputDevices.resolve(first.microphone, devices: devices, defaultUID: "two").id == 1)
    let renamed = Microphone(uid: "one", name: "Saved name before a rename")
    #expect(try AudioInputDevices.resolve(renamed, devices: devices, defaultUID: "two").id == 1)
    #expect(throws: CaptureError.self) {
        try AudioInputDevices.resolve(first.microphone, devices: [second], defaultUID: "two")
    }
    #expect(throws: CaptureError.self) {
        try AudioInputDevices.resolve(nil, devices: [], defaultUID: nil)
    }
    #expect(try AudioInputDevices.resolve(first.microphone, devices: devices, defaultUID: "two").id == 1)
}
