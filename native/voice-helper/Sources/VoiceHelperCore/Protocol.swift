import Foundation

public enum HotkeyKey: String, Codable, Sendable { case fn, rightOption, rightCommand }
public enum HotkeyAction: String, Codable, Sendable { case down, up, cancel }
public enum PermissionKind: String, Codable, Sendable { case microphone, accessibility }
public enum PermissionState: String, Codable, Sendable { case granted, denied, notDetermined }
public enum CaptureFailure: String, Codable, Sendable { case permission, device, unknown }
public enum TranscriptFailure: String, Codable, Sendable { case asrUnavailable, unknown }
public enum InsertMethod: String, Codable, Sendable { case accessibility, paste, none }
public enum InsertFailure: String, Codable, Sendable { case focusChanged, noFocusedField, secureInput, failed }
public enum AsrState: String, Codable, Sendable { case missing, downloading, loading, ready, failed }
public enum LogLevel: String, Codable, Sendable { case info, error }

public enum HelperCommand: Equatable, Sendable {
    case hotkeyConfigure(key: HotkeyKey)
    case captureStart(id: String)
    case captureStop(id: String)
    case captureCancel(id: String)
    case insert(id: String, text: String)
    case permissionsCheck
    case permissionsRequest(kind: PermissionKind)
    case asrPrepare(download: Bool)
    case testAudioFile(path: String?)
    case testHotkey(action: HotkeyAction)
}

public enum HelperEvent: Equatable, Sendable {
    case ready(version: Int)
    case hotkey(action: HotkeyAction)
    case captureStarted(id: String, startMs: Double)
    case captureLevel(id: String, level: Double)
    case captureFailed(id: String, reason: CaptureFailure, message: String)
    case captureCancelled(id: String)
    case transcript(id: String, text: String, audioMs: Double, asrMs: Double)
    case transcriptFailed(id: String, reason: TranscriptFailure, message: String)
    case insertResult(id: String, method: InsertMethod, reason: InsertFailure?)
    case permissions(microphone: PermissionState, accessibility: PermissionState)
    case asrStatus(state: AsrState, message: String?)
    case log(level: LogLevel, message: String)
}

public struct ProtocolError: Error, Equatable, CustomStringConvertible, Sendable {
    public let description: String
    public init(_ description: String) { self.description = description }
}

private enum Key: String, CodingKey {
    case type, key, id, text, kind, download, path, action
    case version, startMs, level, reason, message, audioMs, asrMs, method
    case microphone, accessibility, state
}

extension HelperCommand: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hotkey.configure": self = .hotkeyConfigure(key: try c.decode(HotkeyKey.self, forKey: .key))
        case "capture.start": self = .captureStart(id: try c.decode(String.self, forKey: .id))
        case "capture.stop": self = .captureStop(id: try c.decode(String.self, forKey: .id))
        case "capture.cancel": self = .captureCancel(id: try c.decode(String.self, forKey: .id))
        case "insert":
            self = .insert(id: try c.decode(String.self, forKey: .id), text: try c.decode(String.self, forKey: .text))
        case "permissions.check": self = .permissionsCheck
        case "permissions.request":
            self = .permissionsRequest(kind: try c.decode(PermissionKind.self, forKey: .kind))
        case "asr.prepare": self = .asrPrepare(download: try c.decode(Bool.self, forKey: .download))
        case "test.audioFile": self = .testAudioFile(path: try c.decodeIfPresent(String.self, forKey: .path))
        case "test.hotkey": self = .testHotkey(action: try c.decode(HotkeyAction.self, forKey: .action))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown command type \"\(type)\"")
        }
    }

    public static func decode(line: String) -> Result<HelperCommand, ProtocolError> {
        do {
            return .success(try JSONDecoder().decode(HelperCommand.self, from: Data(line.utf8)))
        } catch let error as DecodingError {
            return .failure(ProtocolError(describe(error)))
        } catch {
            return .failure(ProtocolError("\(error)"))
        }
    }

    private static func describe(_ error: DecodingError) -> String {
        switch error {
        case .keyNotFound(let key, _): return "missing field \"\(key.stringValue)\""
        case .typeMismatch(_, let context), .valueNotFound(_, let context):
            let field = context.codingPath.last?.stringValue ?? "value"
            return "field \"\(field)\" has the wrong type"
        case .dataCorrupted(let context):
            if let field = context.codingPath.last?.stringValue {
                return "field \"\(field)\": \(context.debugDescription)"
            }
            return "invalid JSON: \(context.debugDescription)"
        @unknown default: return "\(error)"
        }
    }
}

extension HelperEvent: Encodable {
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .ready(let version):
            try c.encode("ready", forKey: .type)
            try c.encode(version, forKey: .version)
        case .hotkey(let action):
            try c.encode("hotkey", forKey: .type)
            try c.encode(action, forKey: .action)
        case .captureStarted(let id, let startMs):
            try c.encode("capture.started", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(finite(startMs), forKey: .startMs)
        case .captureLevel(let id, let level):
            try c.encode("capture.level", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(finite(level), forKey: .level)
        case .captureFailed(let id, let reason, let message):
            try c.encode("capture.failed", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(reason, forKey: .reason)
            try c.encode(message, forKey: .message)
        case .captureCancelled(let id):
            try c.encode("capture.cancelled", forKey: .type)
            try c.encode(id, forKey: .id)
        case .transcript(let id, let text, let audioMs, let asrMs):
            try c.encode("transcript", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
            try c.encode(finite(audioMs), forKey: .audioMs)
            try c.encode(finite(asrMs), forKey: .asrMs)
        case .transcriptFailed(let id, let reason, let message):
            try c.encode("transcript.failed", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(reason, forKey: .reason)
            try c.encode(message, forKey: .message)
        case .insertResult(let id, let method, let reason):
            try c.encode("insert.result", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(method, forKey: .method)
            if method == .none { try c.encodeIfPresent(reason, forKey: .reason) }
        case .permissions(let microphone, let accessibility):
            try c.encode("permissions", forKey: .type)
            try c.encode(microphone, forKey: .microphone)
            try c.encode(accessibility, forKey: .accessibility)
        case .asrStatus(let state, let message):
            try c.encode("asr.status", forKey: .type)
            try c.encode(state, forKey: .state)
            try c.encodeIfPresent(message, forKey: .message)
        case .log(let level, let message):
            try c.encode("log", forKey: .type)
            try c.encode(level, forKey: .level)
            try c.encode(message, forKey: .message)
        }
    }

    public func encodeLine() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        do {
            return String(decoding: try encoder.encode(self), as: UTF8.self)
        } catch {
            return #"{"type":"log","level":"error","message":"event encoding failed"}"#
        }
    }
}

// JSONEncoder refuses NaN and infinity; a bad audio buffer must not break the stream.
private func finite(_ value: Double) -> Double {
    value.isFinite ? value : 0
}
