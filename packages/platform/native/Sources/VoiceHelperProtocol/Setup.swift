import Foundation
import CoreFoundation

public enum SetupPermission: String, Codable, Sendable {
    case microphone, accessibility, inputMonitoring
}
public enum PermissionState: String, Encodable { case notRequested = "not-requested", granted, denied, unavailable }
public struct SetupPermissions: Encodable {
    public let microphone: PermissionState
    public let accessibility: PermissionState
    public let inputMonitoring: PermissionState
    public init(microphone: PermissionState, accessibility: PermissionState, inputMonitoring: PermissionState) {
        self.microphone = microphone; self.accessibility = accessibility; self.inputMonitoring = inputMonitoring
    }
}
public enum ShortcutBinding: String, Sendable {
    case fn = "Fn", fnSpace = "Fn+Space", escape = "Escape"
    case controlOptionSpace = "Control+Option+Space", controlShiftSpace = "Control+Shift+Space", controlOptionEscape = "Control+Option+Escape"
}
public struct SetupShortcuts: Sendable {
    public let hold: ShortcutBinding
    public let toggle: ShortcutBinding
    public let cancel: ShortcutBinding
    public var values: [ShortcutBinding] { [hold, toggle, cancel] }
}
public enum ShortcutAvailability: String, Encodable { case available, conflict, unavailable }
public struct SetupShortcutStatus: Encodable {
    public let hold: ShortcutAvailability
    public let toggle: ShortcutAvailability
    public let cancel: ShortcutAvailability
    public init(hold: ShortcutAvailability, toggle: ShortcutAvailability, cancel: ShortcutAvailability) {
        self.hold = hold; self.toggle = toggle; self.cancel = cancel
    }
}
public struct SetupDevice: Encodable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}
public struct SetupStatus: Encodable {
    public let permissions: SetupPermissions
    public let devices: [SetupDevice]
    public let defaultDevice: String?
    public let shortcuts: SetupShortcutStatus
    public init(permissions: SetupPermissions, devices: [SetupDevice], defaultDevice: String?, shortcuts: SetupShortcutStatus) {
        self.permissions = permissions; self.devices = devices; self.defaultDevice = defaultDevice; self.shortcuts = shortcuts
    }
    private enum CodingKeys: String, CodingKey { case permissions, devices, defaultDevice, shortcuts }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(permissions, forKey: .permissions)
        try values.encode(devices, forKey: .devices)
        try values.encode(defaultDevice, forKey: .defaultDevice)
        try values.encode(shortcuts, forKey: .shortcuts)
    }
}
public enum SetupCommand: Sendable {
    case status(SetupShortcuts), requestPermission(SetupPermission), credentialStatus, setCredential(String), removeCredential
}
public struct SetupRequest {
    public let id: Int
    public let command: SetupCommand
    // JSON's untyped representation is confined to the strict decoding boundary.
    public init?(_ object: [String: Any]) {
        guard Set(object.keys) == Set(["type", "version", "id", "command"]),
              object["type"] as? String == "setup.request",
              let version = object["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let number = object["id"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue > 0, number.doubleValue <= 9007199254740991,
              number.doubleValue.rounded() == number.doubleValue,
              let command = object["command"] as? [String: Any],
              let type = command["type"] as? String else { return nil }
        self.id = number.intValue
        switch type {
        case "setup.status":
            guard Set(command.keys) == Set(["type", "shortcuts"]),
                  let bindings = command["shortcuts"] as? [String: String],
                  Set(bindings.keys) == Set(["hold", "toggle", "cancel"]),
                  let hold = bindings["hold"].flatMap(ShortcutBinding.init),
                  let toggle = bindings["toggle"].flatMap(ShortcutBinding.init),
                  let cancel = bindings["cancel"].flatMap(ShortcutBinding.init) else { return nil }
            self.command = .status(SetupShortcuts(hold: hold, toggle: toggle, cancel: cancel))
        case "permission.request":
            guard Set(command.keys) == Set(["type", "permission"]),
                  let name = command["permission"] as? String,
                  let permission = SetupPermission(rawValue: name) else { return nil }
            self.command = .requestPermission(permission)
        case "credential.status", "credential.remove":
            guard Set(command.keys) == Set(["type"]) else { return nil }
            self.command = type == "credential.status" ? .credentialStatus : .removeCredential
        case "credential.set":
            guard Set(command.keys) == Set(["type", "key"]),
                  let key = command["key"] as? String, (1...512).contains(key.utf8.count),
                  key.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else { return nil }
            self.command = .setCredential(key)
        default: return nil
        }
    }
}
public enum CredentialPresence: String, Encodable { case missing, saved }
public enum SetupError: String, Encodable { case keychainUnavailable = "keychain-unavailable", invalidCommand = "invalid-command" }
public enum SetupResult: Encodable {
    case setup(SetupStatus), credential(CredentialPresence), permission, error(SetupError)
    private enum CodingKeys: String, CodingKey { case type, status, presence, error }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .setup(let status): try values.encode("setup", forKey: .type); try values.encode(status, forKey: .status)
        case .credential(let presence): try values.encode("credential", forKey: .type); try values.encode(presence, forKey: .presence)
        case .permission: try values.encode("permission", forKey: .type)
        case .error(let error): try values.encode("error", forKey: .type); try values.encode(error, forKey: .error)
        }
    }
}
public struct SetupReply: Encodable {
    let type = "setup.result"
    let version = 1
    public let id: Int
    public let result: SetupResult
    public init(id: Int, result: SetupResult) { self.id = id; self.result = result }
}
