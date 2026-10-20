import Foundation

public enum HotkeyKey: String, Codable, Sendable { case fn, rightOption, rightCommand }
/// `down`, `up`, and `chord` come from the hold key, `toggle` from a clean tap of the toggle key,
/// and `cancel` from Escape.
public enum HotkeyAction: String, Codable, Sendable { case down, up, chord, cancel, toggle }
public enum PermissionKind: String, Codable, Sendable { case microphone, accessibility }
public enum PermissionState: String, Codable, Sendable { case granted, denied, notDetermined }
public enum CaptureFailure: String, Codable, Sendable { case permission, device, busy, unknown }
public enum CaptureStopReason: String, Codable, Sendable { case deviceChanged, maxDuration }
public enum TranscriptFailure: String, Codable, Sendable { case asrUnavailable, unknown }
public enum InsertMethod: String, Codable, Sendable { case accessibility, paste, none }
public enum InsertFailure: String, Codable, Sendable { case focusChanged, noFocusedField, secureInput, failed }
public enum AsrState: String, Codable, Sendable { case missing, downloading, loading, ready, failed }
public enum LogLevel: String, Codable, Sendable { case info, error }

public enum DictationLanguage: String, Codable, CaseIterable, Sendable {
    case auto, en, bg, hr, cs, da, nl, et, fi, fr, de, el, hu, it, lv, lt, mt, pl, pt, ro, ru, sk, sl, es, sv, uk
}

public struct Microphone: Codable, Equatable, Sendable {
    public let uid: String
    public let name: String

    public init(uid: String, name: String) {
        self.uid = uid
        self.name = name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        uid = try c.decode(String.self, forKey: .uid)
        name = try c.decode(String.self, forKey: .name)
        guard !uid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "microphone UID and name must not be empty"))
        }
    }
}

public enum HelperCommand: Equatable, Sendable {
    case hotkeyConfigure(key: HotkeyKey, toggleKey: HotkeyKey?)
    case microphoneConfigure(microphone: Microphone?)
    /// `detectHost` is main's say on whether the session can use a page host at all.
    case captureStart(id: String, language: DictationLanguage, muteWhileDictating: Bool, microphone: Microphone?, detectHost: Bool)
    case captureStop(id: String)
    case captureCancel(id: String)
    case microphoneTestStart(id: String, microphone: Microphone?)
    case microphoneTestStop(id: String)
    case insert(id: String, text: String, html: String?)
    case permissionsCheck
    case permissionsRequest(kind: PermissionKind)
    case asrPrepare(download: Bool)
    case asrRemove
    case testAudioFile(path: String?)
    /// The next capture reports this target instead of the frontmost app; nil clears a pending one.
    case testTarget(TranscriptTarget?)
    case appsList
    case iconsRender(id: String, paths: [String])
}

/// What the user was dictating into: the frontmost app and, for a browser page, the page host.
/// The whole target is nil when the app is unknown; the host is nil for a non-browser, a page
/// without an http(s) host, or a read that had not finished when the transcript went out.
public struct TranscriptTarget: Equatable, Sendable {
    public let bundleId: String
    public let host: String?

    public init(bundleId: String, host: String?) {
        self.bundleId = bundleId
        self.host = host
    }
}

/// Wire version the helper announces in `ready`. The desktop rejects any other value, and
/// `test-fixtures/helper-protocol.json` pins it for both sides' contract tests.
public let helperProtocolVersion = 12

public enum HelperEvent: Equatable, Sendable {
    case microphonesChanged(devices: [Microphone], defaultUid: String?)
    case microphonesUnavailable(message: String)
    case ready(version: Int)
    case hotkey(action: HotkeyAction)
    case captureStarted(id: String, startMs: Double)
    case captureLevel(id: String, level: Double)
    case captureFailed(id: String, reason: CaptureFailure, message: String)
    case captureCancelled(id: String)
    case captureStopped(id: String, reason: CaptureStopReason)
    case microphoneTestStarted(id: String)
    case microphoneTestLevel(id: String, level: Double)
    case microphoneTestEnded(id: String)
    case microphoneTestFailed(id: String, message: String)
    case transcript(id: String, text: String, audioMs: Double, asrMs: Double, speechMs: Double?, target: TranscriptTarget?)
    case transcriptFailed(id: String, reason: TranscriptFailure, message: String)
    case insertResult(id: String, method: InsertMethod, reason: InsertFailure?)
    case permissions(microphone: PermissionState, accessibility: PermissionState)
    case asrStatus(state: AsrState, message: String?)
    case log(level: LogLevel, message: String)
    case appsListed(apps: [InstalledApp])
    case iconsRendered(id: String, icons: [RenderedIcon])
}

public struct ProtocolError: Error, Equatable, CustomStringConvertible, Sendable {
    public let description: String
    public init(_ description: String) { self.description = description }
}

private enum Key: String, CodingKey {
    case type, key, id, text, kind, download, path, action, muteWhileDictating, language
    case version, startMs, level, reason, message, audioMs, asrMs, speechMs, method, html
    case microphone, accessibility, state, devices, defaultUid, toggleKey, target, bundleId, host, detectHost
    case paths, apps, name, icons, png, modifiedMs, browser
}

extension HelperCommand: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hotkey.configure":
            self = .hotkeyConfigure(key: try c.decode(HotkeyKey.self, forKey: .key),
                                    toggleKey: try c.decode(HotkeyKey?.self, forKey: .toggleKey))
        case "microphone.configure":
            self = .microphoneConfigure(microphone: try c.decode(Microphone?.self, forKey: .microphone))
        case "capture.start":
            self = .captureStart(id: try c.decode(String.self, forKey: .id),
                                 language: try c.decode(DictationLanguage.self, forKey: .language),
                                 muteWhileDictating: try c.decode(Bool.self, forKey: .muteWhileDictating),
                                 microphone: try c.decode(Microphone?.self, forKey: .microphone),
                                 detectHost: try c.decode(Bool.self, forKey: .detectHost))
        case "capture.stop": self = .captureStop(id: try c.decode(String.self, forKey: .id))
        case "capture.cancel": self = .captureCancel(id: try c.decode(String.self, forKey: .id))
        case "microphone.test.start":
            self = .microphoneTestStart(id: try c.decode(String.self, forKey: .id),
                                        microphone: try c.decode(Microphone?.self, forKey: .microphone))
        case "microphone.test.stop": self = .microphoneTestStop(id: try c.decode(String.self, forKey: .id))
        case "insert":
            self = .insert(id: try c.decode(String.self, forKey: .id),
                           text: try c.decode(String.self, forKey: .text),
                           html: try c.decodeIfPresent(String.self, forKey: .html))
        case "permissions.check": self = .permissionsCheck
        case "permissions.request":
            self = .permissionsRequest(kind: try c.decode(PermissionKind.self, forKey: .kind))
        case "asr.prepare": self = .asrPrepare(download: try c.decode(Bool.self, forKey: .download))
        case "asr.remove": self = .asrRemove
        case "test.audioFile": self = .testAudioFile(path: try c.decodeIfPresent(String.self, forKey: .path))
        case "test.target": self = .testTarget(try c.decode(TranscriptTarget?.self, forKey: .target))
        case "apps.list": self = .appsList
        case "icons.render":
            self = .iconsRender(id: try c.decode(String.self, forKey: .id),
                                paths: try c.decode([String].self, forKey: .paths))
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
        case .microphonesChanged(let devices, let defaultUid):
            try c.encode("microphones.changed", forKey: .type)
            try c.encode(devices, forKey: .devices)
            try c.encode(defaultUid, forKey: .defaultUid)
        case .microphonesUnavailable(let message):
            try c.encode("microphones.unavailable", forKey: .type)
            try c.encode(message, forKey: .message)
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
        case .captureStopped(let id, let reason):
            try c.encode("capture.stopped", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(reason, forKey: .reason)
        case .microphoneTestStarted(let id):
            try c.encode("microphone.test.started", forKey: .type)
            try c.encode(id, forKey: .id)
        case .microphoneTestLevel(let id, let level):
            try c.encode("microphone.test.level", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(finite(level), forKey: .level)
        case .microphoneTestEnded(let id):
            try c.encode("microphone.test.ended", forKey: .type)
            try c.encode(id, forKey: .id)
        case .microphoneTestFailed(let id, let message):
            try c.encode("microphone.test.failed", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(message, forKey: .message)
        case .transcript(let id, let text, let audioMs, let asrMs, let speechMs, let target):
            try c.encode("transcript", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
            try c.encode(finite(audioMs), forKey: .audioMs)
            try c.encode(finite(asrMs), forKey: .asrMs)
            try c.encode(speechMs.map(finite), forKey: .speechMs)
            try c.encode(target, forKey: .target)
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
        case .appsListed(let apps):
            try c.encode("apps.listed", forKey: .type)
            try c.encode(apps, forKey: .apps)
        case .iconsRendered(let id, let icons):
            try c.encode("icons.rendered", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(icons, forKey: .icons)
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

extension TranscriptTarget: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        bundleId = try c.decode(String.self, forKey: .bundleId)
        host = try c.decode(String?.self, forKey: .host)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(bundleId, forKey: .bundleId)
        try c.encode(host, forKey: .host)
    }
}

extension InstalledApp: Encodable {
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(bundleId, forKey: .bundleId)
        try c.encode(name, forKey: .name)
        try c.encode(path, forKey: .path)
        try c.encode(finite(modifiedMs), forKey: .modifiedMs)
        try c.encode(browser, forKey: .browser)
    }
}

extension RenderedIcon: Encodable {
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(path, forKey: .path)
        try c.encode(png.base64EncodedString(), forKey: .png)
    }
}

// JSONEncoder refuses NaN and infinity; a bad audio buffer must not break the stream.
private func finite(_ value: Double) -> Double {
    value.isFinite ? value : 0
}
