import Testing
import VoiceHelperCore
@testable import VoiceHelper

@Test func anUnreadableDeviceIsLeftOutOfTheMicrophoneList() {
    // 560947818 is kAudioHardwareBadObjectError, the answer of a device removed after the list was read.
    let devices = AudioInputDevices.devices(ids: [3, 2, 1]) { id in
        guard id != 2 else { throw CaptureError(reason: .device, message: "CoreAudio failed (560947818)") }
        return AudioInputDevices.Device(id: id, microphone: Microphone(uid: "uid-\(id)", name: "Microphone \(id)"))
    }
    #expect(devices.map(\.id) == [1, 3])
}
