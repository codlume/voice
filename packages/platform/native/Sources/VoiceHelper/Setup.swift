import Foundation
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

    func receive(_ object: [String: Any]) -> [String: Any] {
        guard Set(object.keys) == Set(["type", "version", "id", "command"]),
              let version = object["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let id = object["id"] as? NSNumber,
              CFGetTypeID(id) != CFBooleanGetTypeID(), id.doubleValue.rounded() == id.doubleValue,
              let command = object["command"] as? [String: Any],
              let type = command["type"] as? String else { return error("invalid-command") }
        switch type {
        case "setup.status":
            guard Set(command.keys) == Set(["type", "shortcuts"]),
                  let bindings = command["shortcuts"] as? [String: String],
                  Set(bindings.keys) == Set(["hold", "toggle", "cancel"]),
                  bindings.values.allSatisfy({ Self.bindings.contains($0) }) else { return error("invalid-command") }
            let permissions = permissions()
            let inputs = devices()
            return ["type": "setup", "status": [
                "permissions": permissions,
                "devices": inputs,
                "defaultDevice": defaultDevice() as Any? ?? NSNull(),
                "shortcuts": shortcuts(bindings, permissions: permissions)
            ]]
        case "permission.request":
            guard Set(command.keys) == Set(["type", "permission"]),
                  let permission = command["permission"] as? String,
                  ["microphone", "accessibility", "inputMonitoring"].contains(permission) else { return error("invalid-command") }
            request(permission)
            return ["type": "permission"]
        case "credential.status", "credential.remove":
            guard Set(command.keys) == Set(["type"]) else { return error("invalid-command") }
            return credential(type: type, key: nil)
        case "credential.set":
            guard Set(command.keys) == Set(["type", "key"]),
                  let key = command["key"] as? String, (1...512).contains(key.utf8.count),
                  key.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else { return error("invalid-command") }
            return credential(type: type, key: key)
        default: return error("invalid-command")
        }
    }

    private func error(_ code: String) -> [String: Any] { ["type": "error", "error": code] }

    private func credential(type: String, key: String?) -> [String: Any] {
        // Never allow status inspection to show a Keychain dialog on startup.
        let authentication = LAContext()
        authentication.interactionNotAllowed = true
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "deepgram",
            kSecUseAuthenticationContext as String: authentication]
        var status: OSStatus
        switch type {
        case "credential.set":
            guard let key else { return error("invalid-command") }
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
                  let stored = stored as? Data, stored == Data(key.utf8) else { return error("keychain-unavailable") }
        }
        if status == errSecItemNotFound { return ["type": "credential", "presence": "missing"] }
        guard status == errSecSuccess else { return error("keychain-unavailable") }
        return ["type": "credential", "presence": type == "credential.remove" ? "missing" : "saved"]
    }

    private func permissions() -> [String: String] {
        let microphone: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined: microphone = "not-requested"
        case .authorized: microphone = "granted"
        case .denied: microphone = "denied"
        default: microphone = "unavailable"
        }
        return ["microphone": microphone,
                "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
                "inputMonitoring": CGPreflightListenEventAccess() ? "granted" : "denied"]
    }

    private func request(_ permission: String) {
        let pane: String
        switch permission {
        case "microphone":
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                let signal = DispatchSemaphore(value: 0)
                AVCaptureDevice.requestAccess(for: .audio) { _ in signal.signal() }
                signal.wait()
                return
            }
            pane = "Privacy_Microphone"
        case "accessibility":
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
        return value?.takeUnretainedValue() as String?
    }

    private func devices() -> [[String: String]] {
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
            return ["id": uid, "name": name]
        }
    }

    private func defaultDevice() -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else { return nil }
        return stringProperty(id, kAudioDevicePropertyDeviceUID)
    }

    static let bindings = ["Fn", "Fn+Space", "Escape", "Control+Option+Space", "Control+Shift+Space", "Control+Option+Escape"]
    private func shortcuts(_ bindings: [String: String], permissions: [String: String]) -> [String: String] {
        var results: [String: String] = [:]
        for (role, binding) in bindings {
            if bindings.values.filter({ $0 == binding }).count > 1 { results[role] = "conflict"; continue }
            guard permissions["inputMonitoring"] == "granted", permissions["accessibility"] == "granted" else {
                results[role] = "unavailable"; continue
            }
            if binding.hasPrefix("Fn") {
                // macOS can reserve Fn for dictation, emoji, or input-source switching.
                let action = CFPreferencesCopyAppValue("AppleFnUsageType" as CFString, "com.apple.HIToolbox" as CFString) as? NSNumber
                results[role] = (action?.intValue ?? 0) == 0 ? "available" : "conflict"
            } else if binding == "Escape" {
                results[role] = "available"
            } else {
                let key: UInt32 = binding.hasSuffix("Escape") ? 53 : 49
                let modifiers = UInt32(controlKey | (binding.contains("Option") ? optionKey : shiftKey))
                var reference: EventHotKeyRef?
                let status = RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: 0x564f4943, id: 1), GetApplicationEventTarget(), 0, &reference)
                if let reference { UnregisterEventHotKey(reference) }
                results[role] = status == noErr ? "available" : status == eventHotKeyExistsErr ? "conflict" : "unavailable"
            }
        }
        return results
    }
}
