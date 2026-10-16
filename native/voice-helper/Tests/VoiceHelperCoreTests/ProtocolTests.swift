import Foundation
import Testing
@testable import VoiceHelperCore

private func json(_ line: String) throws -> [String: Any] {
    let object = try JSONSerialization.jsonObject(with: Data(line.utf8))
    return try #require(object as? [String: Any])
}

@Test func decodesEveryCommand() throws {
    let cases: [(String, HelperCommand)] = [
        (#"{"type":"hotkey.configure","key":"rightOption","toggleKey":null}"#, .hotkeyConfigure(key: .rightOption, toggleKey: nil)),
        (#"{"type":"hotkey.configure","key":"fn","toggleKey":"rightCommand"}"#, .hotkeyConfigure(key: .fn, toggleKey: .rightCommand)),
        (#"{"type":"capture.start","microphone":null,"id":"s1","language":"en","muteWhileDictating":false,"detectHost":true}"#,
         .captureStart(id: "s1", language: .en, muteWhileDictating: false, microphone: nil, detectHost: true)),
        (#"{"type":"capture.start","microphone":null,"id":"s1","language":"en","muteWhileDictating":false,"detectHost":false}"#,
         .captureStart(id: "s1", language: .en, muteWhileDictating: false, microphone: nil, detectHost: false)),
        (#"{"type":"capture.stop","id":"s1"}"#, .captureStop(id: "s1")),
        (#"{"type":"capture.cancel","id":"s1"}"#, .captureCancel(id: "s1")),
        (#"{"type":"microphone.test.start","id":"t1","microphone":null}"#, .microphoneTestStart(id: "t1", microphone: nil)),
        (#"{"type":"microphone.test.start","id":"t1","microphone":{"uid":"usb","name":"USB"}}"#,
         .microphoneTestStart(id: "t1", microphone: Microphone(uid: "usb", name: "USB"))),
        (#"{"type":"microphone.test.stop","id":"t1"}"#, .microphoneTestStop(id: "t1")),
        (#"{"type":"insert","id":"s1","text":"hi there","html":null}"#,
         .insert(id: "s1", text: "hi there", html: nil)),
        (#"{"type":"insert","id":"s1","text":"Hi Ana","html":"Hi <strong>Ana</strong>"}"#,
         .insert(id: "s1", text: "Hi Ana", html: "Hi <strong>Ana</strong>")),
        (#"{"type":"permissions.check"}"#, .permissionsCheck),
        (#"{"type":"permissions.request","kind":"accessibility"}"#, .permissionsRequest(kind: .accessibility)),
        (#"{"type":"asr.prepare","download":true}"#, .asrPrepare(download: true)),
        (#"{"type":"asr.remove"}"#, .asrRemove),
        (#"{"type":"test.audioFile","path":"/tmp/a.wav"}"#, .testAudioFile(path: "/tmp/a.wav")),
        (#"{"type":"test.audioFile","path":null}"#, .testAudioFile(path: nil)),
        (#"{"type":"test.target","target":{"bundleId":"com.apple.Safari","host":"mail.google.com"}}"#,
         .testTarget(TranscriptTarget(bundleId: "com.apple.Safari", host: "mail.google.com"))),
        (#"{"type":"test.target","target":{"bundleId":"com.apple.TextEdit","host":null}}"#,
         .testTarget(TranscriptTarget(bundleId: "com.apple.TextEdit", host: nil))),
        (#"{"type":"test.target","target":null}"#, .testTarget(nil)),
        (#"{"type":"apps.list"}"#, .appsList),
        (#"{"type":"icons.render","paths":["/Applications/Slack.app","/System/Applications/Mail.app"]}"#,
         .iconsRender(paths: ["/Applications/Slack.app", "/System/Applications/Mail.app"])),
        (#"{"type":"icons.render","paths":[]}"#, .iconsRender(paths: [])),
    ]
    for (line, expected) in cases {
        #expect(HelperCommand.decode(line: line) == .success(expected), Comment(rawValue: line))
    }
}

@Test func rejectsUnknownTypeMissingFieldsAndBadJson() throws {
    let unknown = HelperCommand.decode(line: #"{"type":"bogus"}"#)
    #expect(throws: ProtocolError.self) { try unknown.get() }
    #expect(try unknownDescription(unknown).contains("unknown command type \"bogus\""))

    let missing = HelperCommand.decode(line: #"{"type":"capture.start"}"#)
    #expect(try unknownDescription(missing).contains("missing field \"id\""))

    let badEnum = HelperCommand.decode(line: #"{"type":"hotkey.configure","key":"leftShift"}"#)
    #expect(try unknownDescription(badEnum).contains("field \"key\""))

    let invalid = HelperCommand.decode(line: "not json")
    #expect(try unknownDescription(invalid).contains("invalid JSON"))

    let withoutDetectHost = HelperCommand.decode(line: #"{"type":"capture.start","microphone":null,"id":"s1","language":"en","muteWhileDictating":false}"#)
    #expect(try unknownDescription(withoutDetectHost).contains("missing field \"detectHost\""))

    let hostless = HelperCommand.decode(line: #"{"type":"test.target","target":{"bundleId":"com.apple.Safari"}}"#)
    #expect(try unknownDescription(hostless).contains("missing field \"host\""))

    let appless = HelperCommand.decode(line: #"{"type":"test.target","target":{"bundleId":null,"host":null}}"#)
    #expect(try unknownDescription(appless).contains("field \"bundleId\" has the wrong type"))
    let pathless = HelperCommand.decode(line: #"{"type":"icons.render"}"#)
    #expect(try unknownDescription(pathless).contains("missing field \"paths\""))
}

private func unknownDescription(_ result: Result<HelperCommand, ProtocolError>) throws -> String {
    guard case .failure(let error) = result else {
        throw ProtocolError("expected a decode failure")
    }
    return error.description
}

@Test func encodesEveryEventWithContractTypeStrings() throws {
    let cases: [(HelperEvent, [String: Any])] = [
        (.ready(version: 12), ["type": "ready", "version": 12]),
        (.hotkey(action: .down), ["type": "hotkey", "action": "down"]),
        (.hotkey(action: .chord), ["type": "hotkey", "action": "chord"]),
        (.hotkey(action: .cancel), ["type": "hotkey", "action": "cancel"]),
        (.hotkey(action: .toggle), ["type": "hotkey", "action": "toggle"]),
        (.captureStarted(id: "s", startMs: 12.5), ["type": "capture.started", "id": "s", "startMs": 12.5]),
        (.captureLevel(id: "s", level: 0.4), ["type": "capture.level", "id": "s", "level": 0.4]),
        (.captureFailed(id: "s", reason: .device, message: "gone"),
         ["type": "capture.failed", "id": "s", "reason": "device", "message": "gone"]),
        (.captureFailed(id: "s2", reason: .busy, message: "busy"),
         ["type": "capture.failed", "id": "s2", "reason": "busy", "message": "busy"]),
        (.captureCancelled(id: "s"), ["type": "capture.cancelled", "id": "s"]),
        (.captureStopped(id: "s", reason: .deviceChanged), ["type": "capture.stopped", "id": "s", "reason": "deviceChanged"]),
        (.captureStopped(id: "s", reason: .maxDuration), ["type": "capture.stopped", "id": "s", "reason": "maxDuration"]),
        (.microphoneTestStarted(id: "t"), ["type": "microphone.test.started", "id": "t"]),
        (.microphoneTestLevel(id: "t", level: 0.25), ["type": "microphone.test.level", "id": "t", "level": 0.25]),
        (.microphoneTestLevel(id: "t", level: .nan), ["type": "microphone.test.level", "id": "t", "level": 0]),
        (.microphoneTestEnded(id: "t"), ["type": "microphone.test.ended", "id": "t"]),
        (.microphoneTestFailed(id: "t", message: "Finish dictating, then test again."),
         ["type": "microphone.test.failed", "id": "t", "message": "Finish dictating, then test again."]),
        (.transcript(id: "s", text: "hello", audioMs: 1000, asrMs: 80, speechMs: 640,
                     target: TranscriptTarget(bundleId: "com.apple.Safari", host: "mail.google.com")),
         ["type": "transcript", "id": "s", "text": "hello", "audioMs": 1000, "asrMs": 80, "speechMs": 640,
          "target": ["bundleId": "com.apple.Safari", "host": "mail.google.com"]]),
        (.transcript(id: "s", text: "hello", audioMs: 1000, asrMs: 80, speechMs: 640,
                     target: TranscriptTarget(bundleId: "com.apple.TextEdit", host: nil)),
         ["type": "transcript", "id": "s", "text": "hello", "audioMs": 1000, "asrMs": 80, "speechMs": 640,
          "target": ["bundleId": "com.apple.TextEdit", "host": NSNull()]]),
        (.transcript(id: "s", text: "", audioMs: 50, asrMs: 0, speechMs: nil, target: nil),
         ["type": "transcript", "id": "s", "text": "", "audioMs": 50, "asrMs": 0, "speechMs": NSNull(), "target": NSNull()]),
        (.transcriptFailed(id: "s", reason: .asrUnavailable, message: "no model"),
         ["type": "transcript.failed", "id": "s", "reason": "asrUnavailable", "message": "no model"]),
        (.insertResult(id: "s", method: .none, reason: .focusChanged),
         ["type": "insert.result", "id": "s", "method": "none", "reason": "focusChanged"]),
        (.permissions(microphone: .granted, accessibility: .notDetermined),
         ["type": "permissions", "microphone": "granted", "accessibility": "notDetermined"]),
        (.asrStatus(state: .failed, message: "boom"), ["type": "asr.status", "state": "failed", "message": "boom"]),
        (.log(level: .error, message: "bad"), ["type": "log", "level": "error", "message": "bad"]),
        (.appsListed(apps: [InstalledApp(bundleId: "com.tinyspeck.slackmacgap", name: "Slack", path: "/Applications/Slack.app")]),
         ["type": "apps.listed", "apps": [["bundleId": "com.tinyspeck.slackmacgap", "name": "Slack", "path": "/Applications/Slack.app"]]]),
        (.appsListed(apps: []), ["type": "apps.listed", "apps": [Any]()]),
        (.iconsRendered(icons: [RenderedIcon(path: "/Applications/Slack.app", png: Data([0x89, 0x50, 0x4E, 0x47, 0xFF]))]),
         ["type": "icons.rendered", "icons": [["path": "/Applications/Slack.app", "png": "iVBOR/8="]]]),
        (.iconsRendered(icons: []), ["type": "icons.rendered", "icons": [Any]()]),
    ]
    for (event, expected) in cases {
        let line = event.encodeLine()
        #expect(!line.contains("\n"), Comment(rawValue: line))
        let actual = try json(line)
        #expect(NSDictionary(dictionary: actual) == NSDictionary(dictionary: expected), Comment(rawValue: line))
    }
}

@Test func omitsOptionalFieldsWhenAbsent() throws {
    #expect(try json(HelperEvent.asrStatus(state: .ready, message: nil).encodeLine())["message"] == nil)
    #expect(try json(HelperEvent.insertResult(id: "s", method: .paste, reason: nil).encodeLine())["reason"] == nil)
    #expect(try json(HelperEvent.insertResult(id: "s", method: .accessibility, reason: .failed).encodeLine())["reason"] == nil)
}

@Test func keepsFilePathsAndUnicodeReadable() throws {
    let line = HelperEvent.transcript(id: "s", text: "zażółć /tmp/x", audioMs: 0, asrMs: 0, speechMs: nil, target: nil).encodeLine()
    #expect(line.contains("/tmp/x"))
    #expect(try json(line)["text"] as? String == "zażółć /tmp/x")
}

@Test func captureStartRequiresAnExplicitBooleanMutePreference() {
    #expect(HelperCommand.decode(line: #"{"type":"capture.start","microphone":null,"id":"s","language":"en","muteWhileDictating":true,"detectHost":true}"#)
        == .success(.captureStart(id: "s", language: .en, muteWhileDictating: true, microphone: nil, detectHost: true)))
    for line in [
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","muteWhileDictating":"true","detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","muteWhileDictating":1,"detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","muteWhileDictating":null,"detectHost":true}"#,
    ] {
        if case .success = HelperCommand.decode(line: line) { Issue.record("accepted malformed mute preference") }
    }
}

@Test(arguments: DictationLanguage.allCases)
func captureStartPreservesEveryLanguage(language: DictationLanguage) {
    let line = #"{"type":"capture.start","microphone":null,"id":"s","language":"\#(language.rawValue)","muteWhileDictating":false,"detectHost":true}"#
    #expect(HelperCommand.decode(line: line)
        == .success(.captureStart(id: "s", language: language, muteWhileDictating: false, microphone: nil, detectHost: true)))
}

@Test func captureStartRequiresAValidLanguage() throws {
    for line in [
        #"{"type":"capture.start","microphone":null,"id":"s","muteWhileDictating":false}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":null,"muteWhileDictating":false}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":true,"muteWhileDictating":false}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"unknown","muteWhileDictating":false}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"","muteWhileDictating":false}"#,
    ] {
        let result = HelperCommand.decode(line: line)
        #expect(throws: ProtocolError.self) { try result.get() }
        #expect(try unknownDescription(result).contains("\"language\""))
    }
}

@Test func microphoneCommands() {
    let microphone = Microphone(uid: "usb", name: "USB Microphone")
    #expect(HelperCommand.decode(line: #"{"type":"microphone.configure","microphone":{"uid":"usb","name":"USB Microphone"}}"#)
        == .success(.microphoneConfigure(microphone: microphone)))
    #expect(HelperCommand.decode(line: #"{"type":"microphone.configure","microphone":null}"#)
        == .success(.microphoneConfigure(microphone: nil)))
    #expect(HelperCommand.decode(line: #"{"type":"capture.start","id":"s","language":"en","muteWhileDictating":false,"microphone":{"uid":"usb","name":"USB Microphone"},"detectHost":true}"#)
        == .success(.captureStart(id: "s", language: .en, muteWhileDictating: false, microphone: microphone, detectHost: true)))
    for line in [
        #"{"type":"capture.start","id":"s","language":"en","muteWhileDictating":false}"#,
        #"{"type":"microphone.configure"}"#,
        #"{"type":"microphone.configure","microphone":"usb"}"#,
        #"{"type":"microphone.configure","microphone":{"uid":"","name":"USB"}}"#,
        #"{"type":"microphone.configure","microphone":{"uid":"usb"}}"#,
        #"{"type":"microphone.test.start","id":"t"}"#,
        #"{"type":"microphone.test.start","microphone":null}"#,
        #"{"type":"microphone.test.stop"}"#,
    ] {
        guard case .failure = HelperCommand.decode(line: line) else {
            Issue.record("accepted an invalid microphone command: \(line)")
            continue
        }
    }
}

@Test func microphoneEvents() throws {
    let event = HelperEvent.microphonesChanged(devices: [Microphone(uid: "usb", name: "USB")], defaultUid: "usb")
    let data = try #require(event.encodeLine().data(using: .utf8))
    let decoded = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(decoded["type"] as? String == "microphones.changed")
    #expect(decoded["defaultUid"] as? String == "usb")
    #expect(decoded["devices"] as? [[String: String]] == [["uid": "usb", "name": "USB"]])
    let empty = HelperEvent.microphonesChanged(devices: [], defaultUid: nil).encodeLine()
    #expect(empty.contains(#""defaultUid":null"#))
}
