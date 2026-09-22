import Foundation
import VoiceHelperProtocol
import AVFoundation
@preconcurrency import ApplicationServices
import CoreAudio
import Carbon
import AppKit
import Security
import LocalAuthentication

// Setup only inspects hardware and access. It never opens an audio stream or installs a key listener.
@MainActor
struct SetupService {
    private let service: String
    init() {
        let testService = ProcessInfo.processInfo.environment["VOICE_TEST_KEYCHAIN_SERVICE"]
        service = testService?.hasPrefix("com.codlume.voice.test.") == true
            ? testService! : "com.codlume.voice.development.deepgram"
    }

    func receive(_ command: SetupCommand) -> SetupResult {
        switch command {
        case .status(let bindings):
            let permissions = permissions()
            return .setup(SetupStatus(permissions: permissions, devices: devices(), defaultDevice: defaultDevice(), shortcuts: shortcuts(bindings, permissions: permissions)))
        case .requestPermission(let permission):
            request(permission)
            return .permission
        case .credentialStatus: return credential(type: "credential.status", key: nil)
        case .removeCredential: return credential(type: "credential.remove", key: nil)
        case .setCredential(let key): return credential(type: "credential.set", key: key)
        default: return .error(.invalidCommand)
        }
    }

    func readKey() -> String? {
        let context = LAContext()
        context.interactionNotAllowed = true
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "deepgram",
            kSecUseAuthenticationContext as String: context,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
              let data = value as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func credential(type: String, key: String?) -> SetupResult {
        // Never allow status inspection to show a Keychain dialog on startup.
        let authentication = LAContext()
        authentication.interactionNotAllowed = type == "credential.status"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "deepgram",
            kSecUseAuthenticationContext as String: authentication]
        var status: OSStatus
        switch type {
        case "credential.set":
            guard let key else { return .error(.invalidCommand) }
            let data = Data(key.utf8)
            status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var item = query
                item[kSecValueData as String] = data
                status = SecItemAdd(item as CFDictionary, nil)
            }
        case "credential.remove":
            status = SecItemDelete(query as CFDictionary)
        default:
            // Request the data to establish that this process can use the item, then discard it.
            var read = query
            read[kSecReturnData as String] = true
            read[kSecMatchLimit as String] = kSecMatchLimitOne
            var value: CFTypeRef?
            status = SecItemCopyMatching(read as CFDictionary, &value)
        }
        if type == "credential.set", status == errSecSuccess, let key {
            var read = query
            read[kSecReturnData as String] = true
            read[kSecMatchLimit as String] = kSecMatchLimitOne
            var stored: CFTypeRef?
            guard SecItemCopyMatching(read as CFDictionary, &stored) == errSecSuccess,
                  let stored = stored as? Data, stored == Data(key.utf8) else { return .error(.keychainUnavailable) }
        }
        if status == errSecItemNotFound { return .credential(.missing) }
        guard status == errSecSuccess else { return .error(.keychainUnavailable) }
        return .credential(type == "credential.remove" ? .missing : .saved)
    }

    private func permissions() -> SetupPermissions {
        let microphone: PermissionState
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined: microphone = .notRequested
        case .authorized: microphone = .granted
        case .denied: microphone = .denied
        default: microphone = .unavailable
        }
        return SetupPermissions(microphone: microphone,
                accessibility: AXIsProcessTrusted() ? .granted : .denied,
                inputMonitoring: CGPreflightListenEventAccess() ? .granted : .denied)
    }

    private func request(_ permission: SetupPermission) {
        let pane: String
        switch permission {
        case .microphone:
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                let signal = DispatchSemaphore(value: 0)
                AVCaptureDevice.requestAccess(for: .audio) { _ in signal.signal() }
                signal.wait()
                return
            }
            pane = "Privacy_Microphone"
        case .accessibility:
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            pane = "Privacy_Accessibility"
        default:
            _ = CGRequestListenEventAccess()
            pane = "Privacy_ListenEvent"
        }
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    private func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<CFString>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value?.takeRetainedValue() as String?
    }

    private func devices() -> [SetupDevice] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            var streamAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
            var streamSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &streamAddress, 0, nil, &streamSize) == noErr, streamSize > 0,
                  let uid = stringProperty(id, kAudioDevicePropertyDeviceUID),
                  let name = stringProperty(id, kAudioObjectPropertyName) else { return nil }
            return SetupDevice(id: uid, name: name)
        }
    }

    private func defaultDevice() -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else { return nil }
        return stringProperty(id, kAudioDevicePropertyDeviceUID)
    }

    private func shortcuts(_ bindings: SetupShortcuts, permissions: SetupPermissions) -> SetupShortcutStatus {
        func check(_ binding: ShortcutBinding) -> ShortcutAvailability {
            if bindings.values.filter({ $0 == binding }).count > 1 { return .conflict }
            guard permissions.inputMonitoring == .granted, permissions.accessibility == .granted else { return .unavailable }
            switch binding {
            case .fn, .fnSpace:
                // macOS can reserve Fn for dictation, emoji, or input-source switching.
                let action = CFPreferencesCopyAppValue("AppleFnUsageType" as CFString, "com.apple.HIToolbox" as CFString) as? NSNumber
                return (action?.intValue ?? 0) == 0 ? .available : .conflict
            case .escape: return .available
            case .controlOptionSpace, .controlShiftSpace, .controlOptionEscape:
                let key: UInt32 = binding == .controlOptionEscape ? 53 : 49
                let modifiers = UInt32(controlKey | (binding == .controlShiftSpace ? shiftKey : optionKey))
                var reference: EventHotKeyRef?
                let status = RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: 0x564f4943, id: 1), GetApplicationEventTarget(), 0, &reference)
                if let reference { UnregisterEventHotKey(reference) }
                return status == noErr ? .available : status == eventHotKeyExistsErr ? .conflict : .unavailable
            }
        }
        return SetupShortcutStatus(hold: check(bindings.hold), toggle: check(bindings.toggle), cancel: check(bindings.cancel))
    }
}
