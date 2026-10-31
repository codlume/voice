import Foundation

public enum HotkeyKey: String, Codable, Sendable { case fn, rightOption, rightCommand }
/// `down`, `up`, and `chord` come from the hold key, `toggle` from a clean tap of the toggle key,
/// and `cancel` from Escape.
public enum HotkeyAction: String, Codable, Sendable { case down, up, chord, cancel, toggle }
public enum PermissionKind: String, Codable, Sendable { case microphone, accessibility, systemAudio }
public enum PermissionState: String, Codable, Sendable { case granted, denied, notDetermined }
/// System Audio Recording is `unavailable` below macOS 14.4, where Voice records no system audio.
public enum SystemAudioPermission: String, Codable, Sendable { case granted, denied, notDetermined, unavailable }
public enum MeetingSource: String, Codable, Sendable { case mic, system }
/// How a meeting leg's source started: recording, or left out because the Mac cannot record it
/// or the user has not allowed it.
public enum MeetingSourceState: String, Codable, Sendable { case active, unavailable, denied }
public enum CaptureFailure: String, Codable, Sendable { case permission, device, busy, unknown }
public enum CaptureStopReason: String, Codable, Sendable { case deviceChanged, maxDuration }
public enum TranscriptFailure: String, Codable, Sendable { case asrUnavailable, unknown }
/// Which accessibility branch inserted: a write seen at once, or one whose effect showed only
/// on the re-read.
public enum AccessibilityRoute: String, Codable, Sendable { case direct, late }
/// Why the insertion pasted: formatted text, an app this launch already saw swallow a write, a
/// write the re-read still did not show, no focused element to write to, a refused write, or
/// test mode forcing it.
public enum PasteRoute: String, Codable, Sendable { case html, pasteOnlyApp, unchanged, noElement, writeFailed, forced }
public enum InsertFailure: String, Codable, Sendable { case focusChanged, noFocusedField, secureInput, selectionChanged, failed }
public enum SelectionVia: String, Codable, Sendable { case accessibility, copy }
public enum SelectionFailure: String, Codable, Sendable { case noSelection, secureInput, noFocusedField, keysHeld, failed }
public enum Modifier: String, Codable, Sendable { case control, option, shift, command }
public enum AsrState: String, Codable, Sendable { case missing, downloading, loading, ready, failed }
/// The speech model as a session starts. `warm` and `cold` are both loaded; a cold model has
/// not decoded for a while and may pay a reload on this session's decode.
public enum AsrSessionState: String, Codable, Sendable { case warm, cold, loading, downloading, missing, failed }
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

public struct TransformShortcut: Equatable, Sendable {
    public let id: String
    public let keycode: Int64
    public let modifiers: [Modifier]

    public init(id: String, keycode: Int64, modifiers: [Modifier]) {
        self.id = id
        self.keycode = keycode
        self.modifiers = modifiers
    }
}

public enum SelectionResult: Equatable, Sendable {
    case selected(text: String, via: SelectionVia)
    case failed(SelectionFailure)
}

/// On the wire the branch is `method` (`accessibility`, `paste`, `none`) and the rest its fields.
public enum InsertOutcome: Equatable, Sendable {
    case accessibility(AccessibilityRoute)
    /// `clipboardSaveMs` is how long saving the user's clipboard took before Cmd+V.
    case paste(PasteRoute, clipboardSaveMs: Double)
    case refused(InsertFailure)
}

/// `relayMs` is the release's hop through main: hotkey event out, `capture.stop` back. Nil when
/// the helper ended the capture itself or no hotkey released it.
public struct Transcript: Equatable, Sendable {
    public let id: String
    public let text: String
    public let audioMs: Double
    public let asrMs: Double
    public let speechMs: Double?
    public let relayMs: Double?
    public let target: TranscriptTarget?

    public init(id: String, text: String, audioMs: Double, asrMs: Double, speechMs: Double?, relayMs: Double?, target: TranscriptTarget?) {
        self.id = id
        self.text = text
        self.audioMs = audioMs
        self.asrMs = asrMs
        self.speechMs = speechMs
        self.relayMs = relayMs
        self.target = target
    }
}

public enum HelperCommand: Equatable, Sendable {
    case hotkeyConfigure(key: HotkeyKey, toggleKey: HotkeyKey?, transforms: [TransformShortcut])
    case microphoneConfigure(microphone: Microphone?)
    /// `outputVolumeScale` is the fraction of each output's level to keep while capturing, at least 0
    /// and below 1; 0 mutes and nil leaves outputs alone. `detectHost` is main's say on whether the
    /// session can use a page host at all. `hotkeyUptimeMs` echoes the `uptimeMs` of the hotkey
    /// event this command answers; nil when no hotkey caused it (a fixture-driven test).
    case captureStart(id: String, language: DictationLanguage, outputVolumeScale: Float?, microphone: Microphone?, detectHost: Bool,
                      hotkeyUptimeMs: Double?)
    case captureStop(id: String, hotkeyUptimeMs: Double?)
    case captureCancel(id: String)
    case microphoneTestStart(id: String, microphone: Microphone?)
    case microphoneTestStop(id: String)
    case insert(id: String, text: String, html: String?)
    case selectionRead(id: String)
    /// Ends the run; idempotent, an unknown id is ignored.
    case transformEnd(id: String)
    case permissionsCheck
    case permissionsRequest(kind: PermissionKind)
    case asrPrepare(download: Bool)
    case asrRemove
    case testAudioFile(path: String?)
    /// The next capture reports this target instead of the frontmost app; nil clears a pending one.
    case testTarget(TranscriptTarget?)
    case appsList
    case iconsRender(id: String, paths: [String])
    /// Records one leg into `dir`, appending to the meeting's `mic.pcm` and `system.pcm`, and
    /// transcribes them as they grow. `baseMs` is the meeting time at the files' first byte;
    /// `fromMs` is how far each source's transcript already reaches, in meeting time.
    case meetingStart(id: String, dir: String, baseMs: Double, fromMs: MeetingCursor, language: DictationLanguage, microphone: Microphone?)
    /// Ends the leg and keeps transcribing what was recorded; `meeting.drained` follows. Idempotent.
    case meetingStop(id: String)
    /// Ends the leg and drops the transcription, for a meeting being deleted. Idempotent.
    case meetingCancel(id: String)
    /// Transcribes whatever of the files the transcript does not reach yet, without recording.
    case meetingTranscribe(id: String, dir: String, baseMs: Double, fromMs: MeetingCursor, language: DictationLanguage)
}

/// Meeting time, per source, that a transcript already covers.
public struct MeetingCursor: Equatable, Sendable {
    public let mic: Double
    public let system: Double

    public init(mic: Double, system: Double) {
        self.mic = mic
        self.system = system
    }

    public subscript(source: MeetingSource) -> Double {
        switch source {
        case .mic: mic
        case .system: system
        }
    }
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
public let helperProtocolVersion = 16

public enum HelperEvent: Equatable, Sendable {
    case microphonesChanged(devices: [Microphone], defaultUid: String?)
    case microphonesUnavailable(message: String)
    case ready(version: Int)
    /// `uptimeMs` is the tap's monotonic clock at the key event. Main echoes it on the command it
    /// answers with, so the helper measures the round trip without keeping the event around.
    case hotkey(action: HotkeyAction, uptimeMs: Double)
    case transform(transformId: String)
    case selectionResult(id: String, result: SelectionResult)
    /// `startMs` runs from the hotkey event that started the session, or from `capture.start`
    /// when none did (a fixture-driven test), to the first audio. `relayMs` is the part of it
    /// spent going through main: hotkey event out, `capture.start` back. Nil without a hotkey.
    case captureStarted(id: String, startMs: Double, relayMs: Double?, asrState: AsrSessionState)
    case captureLevel(id: String, level: Double)
    case captureFailed(id: String, reason: CaptureFailure, message: String)
    case captureCancelled(id: String)
    case captureStopped(id: String, reason: CaptureStopReason)
    case microphoneTestStarted(id: String)
    case microphoneTestLevel(id: String, level: Double)
    case microphoneTestEnded(id: String)
    case microphoneTestFailed(id: String, message: String)
    case transcript(Transcript)
    case transcriptFailed(id: String, reason: TranscriptFailure, message: String)
    case insertResult(id: String, outcome: InsertOutcome)
    case permissions(microphone: PermissionState, accessibility: PermissionState, systemAudio: SystemAudioPermission)
    case asrStatus(state: AsrState, message: String?)
    case log(level: LogLevel, message: String)
    case appsListed(apps: [InstalledApp])
    case iconsRendered(id: String, icons: [RenderedIcon])
    case meetingStarted(id: String, mic: MeetingSourceState, system: MeetingSourceState)
    /// The leg could not start, or capture died mid-leg; what was recorded stays on disk.
    case meetingFailed(id: String, message: String)
    /// A final transcript segment, in meeting time.
    case meetingSegment(id: String, source: MeetingSource, startMs: Double, endMs: Double, text: String)
    /// Capture is stopped and everything recorded is transcribed, or `failure` says why the rest
    /// could not be; the audio stays on disk either way.
    case meetingDrained(id: String, failure: String?)
}

public struct ProtocolError: Error, Equatable, CustomStringConvertible, Sendable {
    public let description: String
    public init(_ description: String) { self.description = description }
}

private enum Key: String, CodingKey {
    case type, key, id, text, kind, download, path, action, outputVolumeScale, language
    case version, startMs, relayMs, level, reason, message, audioMs, asrMs, speechMs, method, html
    case microphone, accessibility, state, devices, defaultUid, toggleKey, target, bundleId, host, detectHost
    case paths, apps, name, icons, png, modifiedMs, browser
    case transforms, transformId, keycode, modifiers, outcome, via, route, clipboardSaveMs
    case uptimeMs, hotkeyUptimeMs, asrState
    case systemAudio, dir, baseMs, fromMs, mic, system, source, endMs, failure
}

extension HelperCommand: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hotkey.configure":
            self = .hotkeyConfigure(key: try c.decode(HotkeyKey.self, forKey: .key),
                                    toggleKey: try c.decode(HotkeyKey?.self, forKey: .toggleKey),
                                    transforms: try c.decode([TransformShortcut].self, forKey: .transforms))
        case "microphone.configure":
            self = .microphoneConfigure(microphone: try c.decode(Microphone?.self, forKey: .microphone))
        case "capture.start":
            let id = try c.decode(String.self, forKey: .id)
            let language = try c.decode(DictationLanguage.self, forKey: .language)
            let outputVolumeScale = try c.decode(Float?.self, forKey: .outputVolumeScale)
            if let outputVolumeScale, !(0..<1).contains(outputVolumeScale) {
                throw DecodingError.dataCorruptedError(forKey: .outputVolumeScale, in: c, debugDescription: "outputVolumeScale must be at least 0 and below 1")
            }
            self = .captureStart(id: id, language: language, outputVolumeScale: outputVolumeScale,
                                 microphone: try c.decode(Microphone?.self, forKey: .microphone),
                                 detectHost: try c.decode(Bool.self, forKey: .detectHost),
                                 hotkeyUptimeMs: try c.decodeIfPresent(Double.self, forKey: .hotkeyUptimeMs))
        case "capture.stop":
            self = .captureStop(id: try c.decode(String.self, forKey: .id),
                                hotkeyUptimeMs: try c.decodeIfPresent(Double.self, forKey: .hotkeyUptimeMs))
        case "capture.cancel": self = .captureCancel(id: try c.decode(String.self, forKey: .id))
        case "microphone.test.start":
            self = .microphoneTestStart(id: try c.decode(String.self, forKey: .id),
                                        microphone: try c.decode(Microphone?.self, forKey: .microphone))
        case "microphone.test.stop": self = .microphoneTestStop(id: try c.decode(String.self, forKey: .id))
        case "insert":
            self = .insert(id: try c.decode(String.self, forKey: .id),
                           text: try c.decode(String.self, forKey: .text),
                           html: try c.decodeIfPresent(String.self, forKey: .html))
        case "selection.read": self = .selectionRead(id: try c.decode(String.self, forKey: .id))
        case "transform.end": self = .transformEnd(id: try c.decode(String.self, forKey: .id))
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
        case "meeting.start":
            self = .meetingStart(id: try c.decode(String.self, forKey: .id), dir: try c.decode(String.self, forKey: .dir),
                                 baseMs: try c.decode(Double.self, forKey: .baseMs), fromMs: try c.decode(MeetingCursor.self, forKey: .fromMs),
                                 language: try c.decode(DictationLanguage.self, forKey: .language),
                                 microphone: try c.decode(Microphone?.self, forKey: .microphone))
        case "meeting.stop": self = .meetingStop(id: try c.decode(String.self, forKey: .id))
        case "meeting.cancel": self = .meetingCancel(id: try c.decode(String.self, forKey: .id))
        case "meeting.transcribe":
            self = .meetingTranscribe(id: try c.decode(String.self, forKey: .id), dir: try c.decode(String.self, forKey: .dir),
                                      baseMs: try c.decode(Double.self, forKey: .baseMs), fromMs: try c.decode(MeetingCursor.self, forKey: .fromMs),
                                      language: try c.decode(DictationLanguage.self, forKey: .language))
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
        case .hotkey(let action, let uptimeMs):
            try c.encode("hotkey", forKey: .type)
            try c.encode(action, forKey: .action)
            try c.encode(finite(uptimeMs), forKey: .uptimeMs)
        case .transform(let transformId):
            try c.encode("transform", forKey: .type)
            try c.encode(transformId, forKey: .transformId)
        case .selectionResult(let id, let result):
            try c.encode("selection.result", forKey: .type)
            try c.encode(id, forKey: .id)
            switch result {
            case .selected(let text, let via):
                try c.encode("selected", forKey: .outcome)
                try c.encode(text, forKey: .text)
                try c.encode(via, forKey: .via)
            case .failed(let reason):
                try c.encode("failed", forKey: .outcome)
                try c.encode(reason, forKey: .reason)
            }
        case .captureStarted(let id, let startMs, let relayMs, let asrState):
            try c.encode("capture.started", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(finite(startMs), forKey: .startMs)
            try c.encode(relayMs.map(finite), forKey: .relayMs)
            try c.encode(asrState, forKey: .asrState)
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
        case .transcript(let transcript):
            try c.encode("transcript", forKey: .type)
            try c.encode(transcript.id, forKey: .id)
            try c.encode(transcript.text, forKey: .text)
            try c.encode(finite(transcript.audioMs), forKey: .audioMs)
            try c.encode(finite(transcript.asrMs), forKey: .asrMs)
            try c.encode(transcript.speechMs.map(finite), forKey: .speechMs)
            try c.encode(transcript.relayMs.map(finite), forKey: .relayMs)
            try c.encode(transcript.target, forKey: .target)
        case .transcriptFailed(let id, let reason, let message):
            try c.encode("transcript.failed", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(reason, forKey: .reason)
            try c.encode(message, forKey: .message)
        case .insertResult(let id, let outcome):
            try c.encode("insert.result", forKey: .type)
            try c.encode(id, forKey: .id)
            switch outcome {
            case .accessibility(let route):
                try c.encode("accessibility", forKey: .method)
                try c.encode(route, forKey: .route)
            case .paste(let route, let clipboardSaveMs):
                try c.encode("paste", forKey: .method)
                try c.encode(route, forKey: .route)
                try c.encode(finite(clipboardSaveMs), forKey: .clipboardSaveMs)
            case .refused(let reason):
                try c.encode("none", forKey: .method)
                try c.encode(reason, forKey: .reason)
            }
        case .permissions(let microphone, let accessibility, let systemAudio):
            try c.encode("permissions", forKey: .type)
            try c.encode(microphone, forKey: .microphone)
            try c.encode(accessibility, forKey: .accessibility)
            try c.encode(systemAudio, forKey: .systemAudio)
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
        case .meetingStarted(let id, let mic, let system):
            try c.encode("meeting.started", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(mic, forKey: .mic)
            try c.encode(system, forKey: .system)
        case .meetingFailed(let id, let message):
            try c.encode("meeting.failed", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(message, forKey: .message)
        case .meetingSegment(let id, let source, let startMs, let endMs, let text):
            try c.encode("meeting.segment", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(source, forKey: .source)
            try c.encode(finite(startMs), forKey: .startMs)
            try c.encode(finite(endMs), forKey: .endMs)
            try c.encode(text, forKey: .text)
        case .meetingDrained(let id, let failure):
            try c.encode("meeting.drained", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(failure, forKey: .failure)
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

extension TransformShortcut: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        id = try c.decode(String.self, forKey: .id)
        keycode = try c.decode(Int64.self, forKey: .keycode)
        modifiers = try c.decode([Modifier].self, forKey: .modifiers)
        // The event tap swallows a matching press system-wide, so a shortcut Shift alone (or
        // nothing) modifies would eat plain typing in every app.
        guard modifiers.contains(where: { $0 != .shift }) else {
            throw DecodingError.dataCorruptedError(
                forKey: .modifiers, in: c, debugDescription: "a transform shortcut needs a modifier other than shift")
        }
    }
}

extension MeetingCursor: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        mic = try c.decode(Double.self, forKey: .mic)
        system = try c.decode(Double.self, forKey: .system)
        guard mic.isFinite, system.isFinite, mic >= 0, system >= 0 else {
            throw DecodingError.dataCorruptedError(forKey: .mic, in: c, debugDescription: "cursor times must be finite and not negative")
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
