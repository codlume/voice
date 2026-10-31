import CoreAudio
import VoiceHelperCore

/// Where the Mac plays sound, as far as echo goes. Headphones on the built-in jack, AirPods and
/// other Bluetooth devices keep the other side out of the microphone; anything else may play it
/// into the room, so it counts as speakers.
enum OutputRoute {
    static var current: MeetingOutput {
        var device = AudioObjectID(kAudioObjectUnknown)
        guard read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, &device),
              device != kAudioObjectUnknown
        else { return .speakers }
        var transport: UInt32 = 0
        _ = read(device, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, &transport)
        switch transport {
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE:
            return .headphones
        case kAudioDeviceTransportTypeBuiltIn:
            var source: UInt32 = 0
            let headphones: UInt32 = 0x6864_706E // 'hdpn'
            return read(device, kAudioDevicePropertyDataSource, kAudioDevicePropertyScopeOutput, &source) && source == headphones
                ? .headphones : .speakers
        default:
            return .speakers
        }
    }

    private static func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope,
                                _ value: inout T) -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<T>.size)
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr
    }
}
