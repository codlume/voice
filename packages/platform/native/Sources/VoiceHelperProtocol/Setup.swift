import Foundation
import CoreFoundation

public enum SetupPermission: String, Codable, Sendable {
    case microphone, accessibility, inputMonitoring
}
public enum PermissionState: String, Encodable, Sendable { case notRequested = "not-requested", granted, denied, unavailable }
public struct SetupPermissions: Encodable, Sendable {
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
public struct SetupShortcuts: Sendable, Equatable {
    public let hold: ShortcutBinding
    public let toggle: ShortcutBinding
    public let cancel: ShortcutBinding
    public var values: [ShortcutBinding] { [hold, toggle, cancel] }
}
// Where the helper takes floating-bar clicks over, in screen points with a top-left origin, and
// the bar's CGWindowID.
public struct BarRegion: Sendable, Equatable {
    public let x: Double, y: Double, width: Double, height: Double
    public let window: UInt32
    public init(x: Double, y: Double, width: Double, height: Double, window: UInt32) {
        self.x = x; self.y = y; self.width = width; self.height = height; self.window = window
    }
    public func contains(x px: Double, y py: Double) -> Bool {
        px >= x && px < x + width && py >= y && py < y + height
    }
}
public enum ShortcutAvailability: String, Encodable, Sendable { case available, conflict, unavailable }
public struct SetupShortcutStatus: Encodable, Sendable {
    public let hold: ShortcutAvailability
    public let toggle: ShortcutAvailability
    public let cancel: ShortcutAvailability
    public init(hold: ShortcutAvailability, toggle: ShortcutAvailability, cancel: ShortcutAvailability) {
        self.hold = hold; self.toggle = toggle; self.cancel = cancel
    }
}
public struct SetupDevice: Encodable, Sendable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}
public struct SetupStatus: Encodable, Sendable {
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
public enum TargetStatus: String, Encodable, Sendable { case eligible, none, unsupported, protected, terminal, unavailable }
public enum InsertionOutcome: String, Encodable, Sendable { case inserted, changed, closed, protected, unsupported, missing, failed, uncertain }
public enum SetupCommand: Sendable {
    case status(SetupShortcuts), requestPermission(SetupPermission), credentialStatus, setCredential(String), removeCredential
    case configureShortcuts(SetupShortcuts, active: Bool, bar: BarRegion?)
    case captureTarget(String), armTarget(String), releaseTarget(String), insertTarget(String, text: String)
}
private func shortcuts(_ value: Any?) -> SetupShortcuts? {
    guard let bindings = value as? [String: String],
          Set(bindings.keys) == Set(["hold", "toggle", "cancel"]),
          let hold = bindings["hold"].flatMap(ShortcutBinding.init),
          let toggle = bindings["toggle"].flatMap(ShortcutBinding.init),
          let cancel = bindings["cancel"].flatMap(ShortcutBinding.init) else { return nil }
    return SetupShortcuts(hold: hold, toggle: toggle, cancel: cancel)
}
private func number(_ value: Any?, _ range: ClosedRange<Double>) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
          range.contains(value.doubleValue) else { return nil }
    return value.doubleValue
}
// nil for an invalid value; .some(nil) for an explicit null.
private func barRegion(_ value: Any?) -> BarRegion?? {
    if value is NSNull { return .some(nil) }
    guard let region = value as? [String: Any], Set(region.keys) == Set(["x", "y", "width", "height", "window"]),
          let x = number(region["x"], -100_000...100_000), let y = number(region["y"], -100_000...100_000),
          let width = number(region["width"], .ulpOfOne...10_000), let height = number(region["height"], .ulpOfOne...10_000),
          let window = number(region["window"], 1...Double(UInt32.max)), window.rounded() == window
    else { return nil }
    return .some(BarRegion(x: x, y: y, width: width, height: height, window: UInt32(window)))
}
private func identity(_ value: Any?) -> String? {
    guard let session = value as? String, !session.isEmpty, session.count <= 64 else { return nil }
    return session
}
public struct SetupRequest: Sendable {
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
            guard Set(command.keys) == Set(["type", "shortcuts"]), let bindings = shortcuts(command["shortcuts"]) else { return nil }
            self.command = .status(bindings)
        case "shortcut.configure":
            guard Set(command.keys) == Set(["type", "shortcuts", "active", "bar"]), let bindings = shortcuts(command["shortcuts"]),
                  let active = command["active"] as? NSNumber, CFGetTypeID(active) == CFBooleanGetTypeID(),
                  let bar = barRegion(command["bar"]) else { return nil }
            self.command = .configureShortcuts(bindings, active: active.boolValue, bar: bar)
        case "target.capture", "target.arm", "target.release":
            guard Set(command.keys) == Set(["type", "session"]), let session = identity(command["session"]) else { return nil }
            self.command = type == "target.capture" ? .captureTarget(session) : type == "target.arm" ? .armTarget(session) : .releaseTarget(session)
        case "target.insert":
            guard Set(command.keys) == Set(["type", "session", "text"]), let session = identity(command["session"]),
                  let text = command["text"] as? String, !text.isEmpty, text.utf8.count <= 400_000, text.count <= 100_000 else { return nil }
            self.command = .insertTarget(session, text: text)
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
public enum CredentialPresence: String, Encodable, Sendable { case missing, saved }
public enum SetupError: String, Encodable, Sendable { case keychainUnavailable = "keychain-unavailable", invalidCommand = "invalid-command" }
public enum SetupResult: Encodable, Sendable {
    case setup(SetupStatus), credential(CredentialPresence), permission, error(SetupError)
    case shortcuts(listening: Bool)
    case target(session: String, status: TargetStatus)
    case insertion(session: String, outcome: InsertionOutcome)
    case released(session: String)
    case armed(session: String)
    private enum CodingKeys: String, CodingKey { case type, status, presence, error, listening, session, outcome }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .setup(let status): try values.encode("setup", forKey: .type); try values.encode(status, forKey: .status)
        case .credential(let presence): try values.encode("credential", forKey: .type); try values.encode(presence, forKey: .presence)
        case .permission: try values.encode("permission", forKey: .type)
        case .error(let error): try values.encode("error", forKey: .type); try values.encode(error, forKey: .error)
        case .shortcuts(let listening): try values.encode("shortcuts", forKey: .type); try values.encode(listening, forKey: .listening)
        case .target(let session, let status):
            try values.encode("target", forKey: .type); try values.encode(session, forKey: .session)
            try values.encode(status, forKey: .status)
        case .insertion(let session, let outcome):
            try values.encode("insertion", forKey: .type); try values.encode(session, forKey: .session); try values.encode(outcome, forKey: .outcome)
        case .released(let session): try values.encode("released", forKey: .type); try values.encode(session, forKey: .session)
        case .armed(let session): try values.encode("armed", forKey: .type); try values.encode(session, forKey: .session)
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
