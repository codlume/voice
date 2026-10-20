import Foundation
import Testing
@testable import VoiceHelperCore

private indirect enum ContractJSON: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([ContractJSON])
    case object([String: ContractJSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode([ContractJSON].self) { self = .array(value) }
        else { self = .object(try c.decode([String: ContractJSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        }
    }
}

private struct WireCase: Decodable {
    let name: String
    let wire: [String: ContractJSON]
}

private struct RequiredCase: Decodable {
    let name: String
    let wire: [String: ContractJSON]
    let required: [String]
}

private struct EventCase: Decodable {
    let name: String
    let wire: [String: ContractJSON]
    let parsed: ContractJSON
    let required: [String]
}

private struct ParsedCase: Decodable {
    let name: String
    let wire: [String: ContractJSON]
    let parsed: ContractJSON
}

private struct InvalidCase: Decodable {
    let name: String
    let line: String
}

private struct VersionCase: Decodable {
    let version: Int
    let compatible: Bool
}

private struct ProtocolCorpus: Decodable {
    let protocolVersion: Int
    let languages: [String]
    let versions: [VersionCase]
    let commands: [RequiredCase]
    let nativeCommands: [RequiredCase]
    let optionalCommands: [WireCase]
    let invalidCommands: [InvalidCase]
    let events: [EventCase]
    let normalizedEvents: [ParsedCase]
    let invalidEvents: [InvalidCase]
}

private func readCorpus() throws -> ProtocolCorpus {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../..").standardizedFileURL
    let file = root.appendingPathComponent("test-fixtures/helper-protocol.json")
    return try JSONDecoder().decode(ProtocolCorpus.self, from: Data(contentsOf: file))
}

private func line(_ wire: [String: ContractJSON]) throws -> String {
    String(decoding: try JSONEncoder().encode(wire), as: UTF8.self)
}

private func commandCases() -> [String: HelperCommand] {
    let microphone = Microphone(uid: "usb", name: "Synthetic USB")
    return [
        "hotkey.configure": .hotkeyConfigure(key: .fn, toggleKey: nil),
        "hotkey.configure.toggle": .hotkeyConfigure(key: .rightOption, toggleKey: .rightCommand),
        "microphone.configure": .microphoneConfigure(microphone: microphone),
        "microphone.configure.default": .microphoneConfigure(microphone: nil),
        "capture.start": .captureStart(id: "s1", language: .en, muteWhileDictating: false, microphone: nil, detectHost: true),
        "capture.start.pinned": .captureStart(id: "s1", language: .pl, muteWhileDictating: true, microphone: microphone, detectHost: false),
        "capture.stop": .captureStop(id: "s1"),
        "capture.cancel": .captureCancel(id: "s1"),
        "microphone.test.start": .microphoneTestStart(id: "t1", microphone: nil),
        "microphone.test.start.pinned": .microphoneTestStart(id: "t1", microphone: microphone),
        "microphone.test.stop": .microphoneTestStop(id: "t1"),
        "insert": .insert(id: "s1", text: "Zażółć /tmp/synthetic\nAda 42", html: nil),
        "insert.html": .insert(id: "s1", text: "Hi Ada", html: "Hi <strong>Ada</strong>"),
        "permissions.check": .permissionsCheck,
        "permissions.request": .permissionsRequest(kind: .accessibility),
        "permissions.request.microphone": .permissionsRequest(kind: .microphone),
        "asr.prepare": .asrPrepare(download: true),
        "asr.prepare.cached": .asrPrepare(download: false),
        "asr.remove": .asrRemove,
        "test.target": .testTarget(TranscriptTarget(bundleId: "com.apple.safari", host: "mail.example.com")),
        "test.target.app": .testTarget(TranscriptTarget(bundleId: "com.apple.textedit", host: nil)),
        "test.target.clear": .testTarget(nil),
        "apps.list": .appsList,
        "icons.render": .iconsRender(id: "icons-1", paths: ["/Applications/Synthetic.app"]),
        "icons.render.empty": .iconsRender(id: "icons-1", paths: []),
        "test.audioFile": .testAudioFile(path: "/tmp/synthetic.wav"),
        "test.audioFile.clear": .testAudioFile(path: nil),
    ]
}

private func eventCases() -> [String: HelperEvent] {
    let microphone = Microphone(uid: "usb", name: "Synthetic USB")
    return [
        "microphones.changed": .microphonesChanged(devices: [microphone], defaultUid: "usb"),
        "microphones.changed.empty": .microphonesChanged(devices: [], defaultUid: nil),
        "microphones.unavailable": .microphonesUnavailable(message: "Synthetic device unavailable"),
        "ready": .ready(version: helperProtocolVersion),
        "hotkey": .hotkey(action: .down),
        "hotkey.up": .hotkey(action: .up),
        "hotkey.chord": .hotkey(action: .chord),
        "hotkey.cancel": .hotkey(action: .cancel),
        "hotkey.toggle": .hotkey(action: .toggle),
        "capture.started": .captureStarted(id: "s1", startMs: 12.5),
        "capture.level": .captureLevel(id: "s1", level: 0.4),
        "capture.level.clamped": .captureLevel(id: "s1", level: 2),
        "capture.level.nonfinite": .captureLevel(id: "s1", level: .nan),
        "capture.failed": .captureFailed(id: "s1", reason: .device, message: "Synthetic device gone"),
        "capture.cancelled": .captureCancelled(id: "s1"),
        "capture.stopped": .captureStopped(id: "s1", reason: .deviceChanged),
        "capture.stopped.duration": .captureStopped(id: "s1", reason: .maxDuration),
        "microphone.test.started": .microphoneTestStarted(id: "t1"),
        "microphone.test.level": .microphoneTestLevel(id: "t1", level: 0.25),
        "microphone.test.ended": .microphoneTestEnded(id: "t1"),
        "microphone.test.failed": .microphoneTestFailed(id: "t1", message: "Synthetic test failed"),
        "transcript": .transcript(id: "s1", text: "Zażółć /tmp/synthetic\nAda 42", audioMs: 1000, asrMs: 80, speechMs: 640,
                                  target: TranscriptTarget(bundleId: "com.apple.Safari", host: "MAIL.EXAMPLE.COM")),
        "transcript.empty": .transcript(id: "s1", text: "", audioMs: 40, asrMs: 0, speechMs: nil, target: nil),
        "transcript.app": .transcript(id: "s1", text: "Synthetic text", audioMs: 500, asrMs: 20, speechMs: 300,
                                      target: TranscriptTarget(bundleId: "com.apple.TextEdit", host: nil)),
        "transcript.failed": .transcriptFailed(id: "s1", reason: .asrUnavailable, message: "Synthetic ASR failure"),
        "insert.result": .insertResult(id: "s1", method: .none, reason: .focusChanged),
        "insert.result.paste": .insertResult(id: "s1", method: .paste, reason: nil),
        "insert.result.accessibility": .insertResult(id: "s1", method: .accessibility, reason: .failed),
        "permissions": .permissions(microphone: .granted, accessibility: .notDetermined),
        "permissions.denied": .permissions(microphone: .denied, accessibility: .granted),
        "asr.status": .asrStatus(state: .failed, message: "Synthetic model failure"),
        "asr.status.ready": .asrStatus(state: .ready, message: nil),
        "log": .log(level: .info, message: "Synthetic protocol log"),
        "log.error": .log(level: .error, message: "Synthetic protocol error"),
        "apps.listed": .appsListed(apps: [InstalledApp(bundleId: "com.example.synthetic", name: "Synthetic", path: "/Applications/Synthetic.app", modifiedMs: 1_760_000_000_123, browser: false)]),
        "apps.listed.empty": .appsListed(apps: []),
        "icons.rendered": .iconsRendered(id: "icons-1", icons: [RenderedIcon(path: "/Applications/Synthetic.app", png: Data([0x89, 0x50, 0x4E, 0x47, 0xFF]))]),
        "icons.rendered.empty": .iconsRendered(id: "icons-1", icons: []),
    ]
}

private func commandType(_ command: HelperCommand) -> String {
    switch command {
    case .hotkeyConfigure: "hotkey.configure"
    case .microphoneConfigure: "microphone.configure"
    case .captureStart: "capture.start"
    case .captureStop: "capture.stop"
    case .captureCancel: "capture.cancel"
    case .microphoneTestStart: "microphone.test.start"
    case .microphoneTestStop: "microphone.test.stop"
    case .insert: "insert"
    case .permissionsCheck: "permissions.check"
    case .permissionsRequest: "permissions.request"
    case .asrPrepare: "asr.prepare"
    case .asrRemove: "asr.remove"
    case .testAudioFile: "test.audioFile"
    case .testTarget: "test.target"
    case .appsList: "apps.list"
    case .iconsRender: "icons.render"
    }
}

private func eventType(_ event: HelperEvent) -> String {
    switch event {
    case .microphonesChanged: "microphones.changed"
    case .microphonesUnavailable: "microphones.unavailable"
    case .ready: "ready"
    case .hotkey: "hotkey"
    case .captureStarted: "capture.started"
    case .captureLevel: "capture.level"
    case .captureFailed: "capture.failed"
    case .captureCancelled: "capture.cancelled"
    case .captureStopped: "capture.stopped"
    case .microphoneTestStarted: "microphone.test.started"
    case .microphoneTestLevel: "microphone.test.level"
    case .microphoneTestEnded: "microphone.test.ended"
    case .microphoneTestFailed: "microphone.test.failed"
    case .transcript: "transcript"
    case .transcriptFailed: "transcript.failed"
    case .insertResult: "insert.result"
    case .permissions: "permissions"
    case .asrStatus: "asr.status"
    case .log: "log"
    case .appsListed: "apps.listed"
    case .iconsRendered: "icons.rendered"
    }
}

@Suite struct HelperProtocolContractTests {
    @Test func coversEveryVariantAndLanguage() throws {
        let corpus = try readCorpus()
        let commands = commandCases()
        let events = eventCases()
        let commandFixtures = corpus.commands + corpus.nativeCommands
        #expect(Set(commandFixtures.map(\.name)) == Set(commands.keys))
        #expect(Set(corpus.events.map(\.name)) == Set(events.keys))
        #expect(corpus.languages.sorted() == DictationLanguage.allCases.map(\.rawValue).sorted())
        for names in [commandFixtures.map(\.name), corpus.events.map(\.name), corpus.normalizedEvents.map(\.name),
                      corpus.invalidCommands.map(\.name), corpus.invalidEvents.map(\.name), corpus.optionalCommands.map(\.name)] {
            #expect(Set(names).count == names.count)
        }
    }

    @Test func decodesTypeScriptCommandWires() throws {
        let corpus = try readCorpus()
        let expected = commandCases()
        for fixture in corpus.commands + corpus.nativeCommands {
            let command = try #require(expected[fixture.name])
            #expect(fixture.wire["type"] == .string(commandType(command)))
            #expect(HelperCommand.decode(line: try line(fixture.wire)) == .success(command), Comment(rawValue: fixture.name))
        }
    }

    @Test func rejectsMissingAndMistypedCommandFields() throws {
        let corpus = try readCorpus()
        for fixture in corpus.commands + corpus.nativeCommands {
            #expect(fixture.required.contains("type"))
            for field in fixture.required {
                #expect(fixture.wire[field] != nil)
                var missing = fixture.wire
                missing.removeValue(forKey: field)
                #expect(throws: ProtocolError.self) { try HelperCommand.decode(line: line(missing)).get() }
                var mistyped = fixture.wire
                mistyped[field] = .object(["invalid": .bool(true)])
                #expect(throws: ProtocolError.self) { try HelperCommand.decode(line: line(mistyped)).get() }
            }
        }
        for fixture in corpus.invalidCommands {
            #expect(throws: ProtocolError.self, Comment(rawValue: fixture.name)) {
                try HelperCommand.decode(line: fixture.line).get()
            }
        }
    }

    @Test func normalizesOptionalCommandFields() throws {
        let corpus = try readCorpus()
        let expected: [String: HelperCommand] = [
            "insert.html.missing": .insert(id: "s1", text: "Synthetic text", html: nil),
            "test.audioFile.missing": .testAudioFile(path: nil),
        ]
        #expect(Set(corpus.optionalCommands.map(\.name)) == Set(expected.keys))
        for fixture in corpus.optionalCommands {
            #expect(HelperCommand.decode(line: try line(fixture.wire)) == .success(try #require(expected[fixture.name])))
        }
    }

    @Test func decodesEverySharedLanguage() throws {
        let corpus = try readCorpus()
        let capture = try #require(corpus.commands.first { $0.name == "capture.start" })
        for language in DictationLanguage.allCases {
            var wire = capture.wire
            wire["language"] = .string(language.rawValue)
            #expect(HelperCommand.decode(line: try line(wire)) == .success(.captureStart(
                id: "s1", language: language, muteWhileDictating: false, microphone: nil, detectHost: true)))
        }
    }

    @Test func serializesConcreteEventsForTypeScript() throws {
        let corpus = try readCorpus()
        let events = eventCases()
        for fixture in corpus.events {
            let event = try #require(events[fixture.name])
            #expect(fixture.wire["type"] == .string(eventType(event)))
            let line = event.encodeLine()
            #expect(!line.contains("\n"))
            let wire = try JSONDecoder().decode([String: ContractJSON].self, from: Data(line.utf8))
            #expect(wire == fixture.wire, Comment(rawValue: fixture.name))
        }
    }

    @Test func sharesReadyVersionExpectations() throws {
        let corpus = try readCorpus()
        let ready = try #require(corpus.events.first { $0.name == "ready" })
        #expect(corpus.protocolVersion == helperProtocolVersion, "bump the shared fixture together with helperProtocolVersion")
        #expect(ready.wire["version"] == .number(Double(corpus.protocolVersion)))
        #expect(corpus.versions.contains { $0.compatible })
        #expect(corpus.versions.contains { !$0.compatible })
        for fixture in corpus.versions {
            #expect(fixture.compatible == (fixture.version == corpus.protocolVersion))
            let line = HelperEvent.ready(version: fixture.version).encodeLine()
            let wire = try JSONDecoder().decode([String: ContractJSON].self, from: Data(line.utf8))
            #expect(wire == ["type": .string("ready"), "version": .number(Double(fixture.version))])
        }
    }
}
