import AVFoundation
import CoreAudio
import Foundation
import Testing
import VoiceHelperCore
import XCTest
import os
@testable import VoiceHelper

@Suite(.serialized)
struct MicrophoneHardwareTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["VOICE_MICROPHONE_SMOKE"] == "1"))
    @MainActor func availableMicrophonesCanBeRoutedWithoutRecording() async throws {
        let devices = try AudioInputDevices.readDevices()
        #expect(!devices.isEmpty)
        for device in devices {
            let engine = AVAudioEngine()
            var invalidations = 0
            let source = try MicSource(device: device, preference: device.microphone, engine: engine) { _ in
                invalidations += 1
            }
            defer { source.dispose() }
            NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)
            await drainMainQueue()
            #expect(invalidations == 0)
            #expect(!engine.isRunning)
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["VOICE_MICROPHONE_SMOKE"] == "1"))
    @MainActor func unknownMicrophoneCannotSilentlyUseTheDefault() throws {
        let device = AudioInputDevices.Device(id: AudioDeviceID.max, microphone: Microphone(uid: "missing", name: "Missing microphone"))
        #expect(throws: CaptureError.self) {
            let source = try MicSource(device: device, preference: device.microphone) { _ in }
            source.dispose()
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["VOICE_MICROPHONE_CAPTURE_SMOKE"] == "1"))
    @MainActor func configurationNotificationPreservesWorkingCaptureButInvalidatesStoppedEngine() async throws {
        try #require(AVCaptureDevice.authorizationStatus(for: .audio) == .authorized)
        let device = try defaultMicrophone()
        let engine = AVAudioEngine()
        var invalidations = 0
        let source = try MicSource(device: device, preference: device.microphone, engine: engine) { _ in
            invalidations += 1
        }
        defer { source.dispose() }
        let receivedAudio = XCTestExpectation(description: "audio arrives after the configuration notification")
        let observeAudio = OSAllocatedUnfairLock(initialState: false)
        try source.start { chunk in
            guard !chunk.isEmpty else { return }
            let shouldFulfill = observeAudio.withLock { observing in
                defer { observing = false }
                return observing
            }
            if shouldFulfill { receivedAudio.fulfill() }
        }
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)
        await drainMainQueue()
        #expect(invalidations == 0)
        #expect(engine.isRunning)
        observeAudio.withLock { $0 = true }
        let result = await XCTWaiter.fulfillment(of: [receivedAudio], timeout: 3)
        #expect(result == .completed)
        observeAudio.withLock { $0 = false }
        #expect(invalidations == 0)

        engine.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)
        await drainMainQueue()
        #expect(invalidations > 0)
        #expect(!engine.isRunning)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["VOICE_MICROPHONE_CAPTURE_SMOKE"] == "1"))
    @MainActor func stoppingBeforeQueuedConfigurationNotificationDoesNotRestartCapture() async throws {
        try #require(AVCaptureDevice.authorizationStatus(for: .audio) == .authorized)
        let device = try defaultMicrophone()
        let engine = AVAudioEngine()
        var invalidations = 0
        let source = try MicSource(device: device, preference: device.microphone, engine: engine) { _ in
            invalidations += 1
        }
        defer { source.dispose() }
        try source.start { _ in }
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)
        source.stop()
        await drainMainQueue()
        #expect(invalidations == 0)
        #expect(!engine.isRunning)
    }

    private func defaultMicrophone() throws -> AudioInputDevices.Device {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout.size(ofValue: deviceID))
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
        try #require(status == noErr)
        return try #require(AudioInputDevices.readDevices().first { $0.id == deviceID })
    }

    @MainActor private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
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
