import Foundation
import Testing
@testable import VoiceHelperCore

private func json(_ line: String) throws -> [String: Any] {
    let object = try JSONSerialization.jsonObject(with: Data(line.utf8))
    return try #require(object as? [String: Any])
}

@Test func decodesEveryCommand() throws {
    let cases: [(String, HelperCommand)] = [
        (#"{"type":"hotkey.configure","key":"rightOption","toggleKey":null,"transforms":[]}"#,
         .hotkeyConfigure(key: .rightOption, toggleKey: nil, transforms: [])),
        (#"{"type":"hotkey.configure","key":"fn","toggleKey":"rightCommand","transforms":[]}"#,
         .hotkeyConfigure(key: .fn, toggleKey: .rightCommand, transforms: [])),
        (#"{"type":"hotkey.configure","key":"fn","toggleKey":null,"transforms":[{"id":"polish","keycode":18,"modifiers":["option"]},{"id":"c1","keycode":40,"modifiers":["control","option","shift","command"]}]}"#,
         .hotkeyConfigure(key: .fn, toggleKey: nil, transforms: [
             TransformShortcut(id: "polish", keycode: 18, modifiers: [.option]),
             TransformShortcut(id: "c1", keycode: 40, modifiers: [.control, .option, .shift, .command]),
         ])),
        (#"{"type":"selection.read","id":"r1"}"#, .selectionRead(id: "r1")),
        (#"{"type":"transform.end","id":"r1"}"#, .transformEnd(id: "r1")),
        (#"{"type":"capture.start","microphone":null,"id":"s1","language":"en","outputVolumeScale":null,"detectHost":true}"#,
         .captureStart(id: "s1", language: .en, outputVolumeScale: nil, microphone: nil, detectHost: true, hotkeyUptimeMs: nil)),
        (#"{"type":"capture.start","microphone":null,"id":"s1","language":"en","outputVolumeScale":null,"detectHost":false}"#,
         .captureStart(id: "s1", language: .en, outputVolumeScale: nil, microphone: nil, detectHost: false, hotkeyUptimeMs: nil)),
        (#"{"type":"capture.start","microphone":null,"id":"s1","language":"en","outputVolumeScale":null,"detectHost":true,"hotkeyUptimeMs":1234.5}"#,
         .captureStart(id: "s1", language: .en, outputVolumeScale: nil, microphone: nil, detectHost: true, hotkeyUptimeMs: 1234.5)),
        (#"{"type":"capture.start","microphone":null,"id":"s1","language":"en","outputVolumeScale":null,"detectHost":true,"hotkeyUptimeMs":null}"#,
         .captureStart(id: "s1", language: .en, outputVolumeScale: nil, microphone: nil, detectHost: true, hotkeyUptimeMs: nil)),
        (#"{"type":"capture.stop","id":"s1"}"#, .captureStop(id: "s1", hotkeyUptimeMs: nil)),
        (#"{"type":"capture.stop","id":"s1","hotkeyUptimeMs":2345.5}"#, .captureStop(id: "s1", hotkeyUptimeMs: 2345.5)),
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
        (#"{"type":"icons.render","id":"7","paths":["/Applications/Slack.app","/System/Applications/Mail.app"]}"#,
         .iconsRender(id: "7", paths: ["/Applications/Slack.app", "/System/Applications/Mail.app"])),
        (#"{"type":"icons.render","id":"8","paths":[]}"#, .iconsRender(id: "8", paths: [])),
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

    let withoutTransforms = HelperCommand.decode(line: #"{"type":"hotkey.configure","key":"fn","toggleKey":null}"#)
    #expect(try unknownDescription(withoutTransforms).contains("missing field \"transforms\""))

    let badModifier = HelperCommand.decode(line: #"{"type":"hotkey.configure","key":"fn","toggleKey":null,"transforms":[{"id":"p","keycode":18,"modifiers":["fn"]}]}"#)
    #expect(throws: ProtocolError.self) { try badModifier.get() }

    let keycodeless = HelperCommand.decode(line: #"{"type":"hotkey.configure","key":"fn","toggleKey":null,"transforms":[{"id":"p","modifiers":["option"]}]}"#)
    #expect(try unknownDescription(keycodeless).contains("missing field \"keycode\""))

    for modifiers in ["[]", #"["shift"]"#] {
        let swallowsTyping = HelperCommand.decode(line: #"{"type":"hotkey.configure","key":"fn","toggleKey":null,"transforms":[{"id":"p","keycode":18,"modifiers":"# + modifiers + "}]}")
        #expect(try unknownDescription(swallowsTyping).contains("field \"modifiers\": a transform shortcut needs a modifier other than shift"))
    }

    let readWithoutId = HelperCommand.decode(line: #"{"type":"selection.read"}"#)
    #expect(try unknownDescription(readWithoutId).contains("missing field \"id\""))

    let invalid = HelperCommand.decode(line: "not json")
    #expect(try unknownDescription(invalid).contains("invalid JSON"))

    let withoutDetectHost = HelperCommand.decode(line: #"{"type":"capture.start","microphone":null,"id":"s1","language":"en","outputVolumeScale":null}"#)
    #expect(try unknownDescription(withoutDetectHost).contains("missing field \"detectHost\""))

    let hostless = HelperCommand.decode(line: #"{"type":"test.target","target":{"bundleId":"com.apple.Safari"}}"#)
    #expect(try unknownDescription(hostless).contains("missing field \"host\""))

    let appless = HelperCommand.decode(line: #"{"type":"test.target","target":{"bundleId":null,"host":null}}"#)
    #expect(try unknownDescription(appless).contains("field \"bundleId\" has the wrong type"))
    let idless = HelperCommand.decode(line: #"{"type":"icons.render","paths":[]}"#)
    #expect(try unknownDescription(idless).contains("missing field \"id\""))

    let pathless = HelperCommand.decode(line: #"{"type":"icons.render","id":"1"}"#)
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
        (.ready(version: 13), ["type": "ready", "version": 13]),
        (.hotkey(action: .down, uptimeMs: 1234.5), ["type": "hotkey", "action": "down", "uptimeMs": 1234.5]),
        (.hotkey(action: .chord, uptimeMs: 1), ["type": "hotkey", "action": "chord", "uptimeMs": 1]),
        (.hotkey(action: .cancel, uptimeMs: 1), ["type": "hotkey", "action": "cancel", "uptimeMs": 1]),
        (.hotkey(action: .toggle, uptimeMs: .nan), ["type": "hotkey", "action": "toggle", "uptimeMs": 0]),
        (.transform(transformId: "polish"), ["type": "transform", "transformId": "polish"]),
        (.selectionResult(id: "r", result: .selected(text: "zażółć", via: .accessibility)),
         ["type": "selection.result", "id": "r", "outcome": "selected", "text": "zażółć", "via": "accessibility"]),
        (.selectionResult(id: "r", result: .selected(text: "x", via: .copy)),
         ["type": "selection.result", "id": "r", "outcome": "selected", "text": "x", "via": "copy"]),
        (.selectionResult(id: "r", result: .failed(.noSelection)),
         ["type": "selection.result", "id": "r", "outcome": "failed", "reason": "noSelection"]),
        (.selectionResult(id: "r", result: .failed(.keysHeld)),
         ["type": "selection.result", "id": "r", "outcome": "failed", "reason": "keysHeld"]),
        (.captureStarted(id: "s", startMs: 12.5, relayMs: 3.25, asrState: .warm),
         ["type": "capture.started", "id": "s", "startMs": 12.5, "relayMs": 3.25, "asrState": "warm"]),
        (.captureStarted(id: "s", startMs: 12.5, relayMs: nil, asrState: .cold),
         ["type": "capture.started", "id": "s", "startMs": 12.5, "relayMs": NSNull(), "asrState": "cold"]),
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
        (.transcript(Transcript(id: "s", text: "hello", audioMs: 1000, asrMs: 80, speechMs: 640, relayMs: 4.5,
                                target: TranscriptTarget(bundleId: "com.apple.Safari", host: "mail.google.com"))),
         ["type": "transcript", "id": "s", "text": "hello", "audioMs": 1000, "asrMs": 80, "speechMs": 640, "relayMs": 4.5,
          "target": ["bundleId": "com.apple.Safari", "host": "mail.google.com"]]),
        (.transcript(Transcript(id: "s", text: "hello", audioMs: 1000, asrMs: 80, speechMs: 640, relayMs: nil,
                                target: TranscriptTarget(bundleId: "com.apple.TextEdit", host: nil))),
         ["type": "transcript", "id": "s", "text": "hello", "audioMs": 1000, "asrMs": 80, "speechMs": 640, "relayMs": NSNull(),
          "target": ["bundleId": "com.apple.TextEdit", "host": NSNull()]]),
        (.transcript(Transcript(id: "s", text: "", audioMs: 50, asrMs: 0, speechMs: nil, relayMs: nil, target: nil)),
         ["type": "transcript", "id": "s", "text": "", "audioMs": 50, "asrMs": 0, "speechMs": NSNull(), "relayMs": NSNull(), "target": NSNull()]),
        (.transcriptFailed(id: "s", reason: .asrUnavailable, message: "no model"),
         ["type": "transcript.failed", "id": "s", "reason": "asrUnavailable", "message": "no model"]),
        (.insertResult(id: "s", outcome: .refused(.focusChanged)),
         ["type": "insert.result", "id": "s", "method": "none", "reason": "focusChanged"]),
        (.insertResult(id: "r", outcome: .refused(.selectionChanged)),
         ["type": "insert.result", "id": "r", "method": "none", "reason": "selectionChanged"]),
        (.insertResult(id: "s", outcome: .accessibility(.late)),
         ["type": "insert.result", "id": "s", "method": "accessibility", "route": "late"]),
        (.insertResult(id: "s", outcome: .paste(.pasteOnlyApp, clipboardSaveMs: 1.5)),
         ["type": "insert.result", "id": "s", "method": "paste", "route": "pasteOnlyApp", "clipboardSaveMs": 1.5]),
        (.insertResult(id: "s", outcome: .paste(.html, clipboardSaveMs: .nan)),
         ["type": "insert.result", "id": "s", "method": "paste", "route": "html", "clipboardSaveMs": 0]),
        (.permissions(microphone: .granted, accessibility: .notDetermined, systemAudio: .unavailable),
         ["type": "permissions", "microphone": "granted", "accessibility": "notDetermined", "systemAudio": "unavailable"]),
        (.meetingSegment(id: "m", source: .system, startMs: .nan, endMs: 2, text: "hi"),
         ["type": "meeting.segment", "id": "m", "source": "system", "startMs": 0, "endMs": 2, "text": "hi"]),
        (.asrStatus(state: .failed, message: "boom"), ["type": "asr.status", "state": "failed", "message": "boom"]),
        (.log(level: .error, message: "bad"), ["type": "log", "level": "error", "message": "bad"]),
        (.appsListed(apps: [InstalledApp(bundleId: "com.tinyspeck.slackmacgap", name: "Slack", path: "/Applications/Slack.app", modifiedMs: 1_760_000_000_123, browser: false),
                            InstalledApp(bundleId: "com.google.Chrome", name: "Google Chrome", path: "/Applications/Google Chrome.app", modifiedMs: 1, browser: true)]),
         ["type": "apps.listed", "apps": [["bundleId": "com.tinyspeck.slackmacgap", "name": "Slack", "path": "/Applications/Slack.app", "modifiedMs": 1_760_000_000_123, "browser": false],
                                          ["bundleId": "com.google.Chrome", "name": "Google Chrome", "path": "/Applications/Google Chrome.app", "modifiedMs": 1, "browser": true]]]),
        (.appsListed(apps: []), ["type": "apps.listed", "apps": [Any]()]),
        (.iconsRendered(id: "7", icons: [RenderedIcon(path: "/Applications/Slack.app", png: Data([0x89, 0x50, 0x4E, 0x47, 0xFF]))]),
         ["type": "icons.rendered", "id": "7", "icons": [["path": "/Applications/Slack.app", "png": "iVBOR/8="]]]),
        (.iconsRendered(id: "8", icons: []), ["type": "icons.rendered", "id": "8", "icons": [Any]()]),
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
}

@Test func insertResultCarriesOnlyItsMethodsFields() throws {
    let paste = try json(HelperEvent.insertResult(id: "s", outcome: .paste(.html, clipboardSaveMs: 1)).encodeLine())
    #expect(Set(paste.keys) == ["type", "id", "method", "route", "clipboardSaveMs"])
    let accessibility = try json(HelperEvent.insertResult(id: "s", outcome: .accessibility(.direct)).encodeLine())
    #expect(Set(accessibility.keys) == ["type", "id", "method", "route"])
    let refused = try json(HelperEvent.insertResult(id: "s", outcome: .refused(.failed)).encodeLine())
    #expect(Set(refused.keys) == ["type", "id", "method", "reason"])
}

@Test func keepsFilePathsAndUnicodeReadable() throws {
    let line = HelperEvent.transcript(Transcript(id: "s", text: "zażółć /tmp/x", audioMs: 0, asrMs: 0, speechMs: nil, relayMs: nil, target: nil)).encodeLine()
    #expect(line.contains("/tmp/x"))
    #expect(try json(line)["text"] as? String == "zażółć /tmp/x")
}

@Test func captureStartRequiresAnOutputVolumeScaleFromZeroToBelowOne() {
    for (wire, scale) in [("null", nil), ("0", 0), ("0.3", 0.3)] as [(String, Float?)] {
        #expect(HelperCommand.decode(line: #"{"type":"capture.start","microphone":null,"id":"s","language":"en","outputVolumeScale":\#(wire),"detectHost":true}"#)
            == .success(.captureStart(id: "s", language: .en, outputVolumeScale: scale, microphone: nil, detectHost: true, hotkeyUptimeMs: nil)))
    }
    for line in [
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","outputVolumeScale":"0.1","detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","outputVolumeScale":true,"detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","outputVolumeScale":-0.1,"detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","outputVolumeScale":1,"detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","outputVolumeScale":1.1,"detectHost":true}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"en","muteWhileDictating":true,"detectHost":true}"#,
    ] {
        if case .success = HelperCommand.decode(line: line) { Issue.record("accepted malformed output volume scale: \(line)") }
    }
}

@Test(arguments: DictationLanguage.allCases)
func captureStartPreservesEveryLanguage(language: DictationLanguage) {
    let line = #"{"type":"capture.start","microphone":null,"id":"s","language":"\#(language.rawValue)","outputVolumeScale":null,"detectHost":true}"#
    #expect(HelperCommand.decode(line: line)
        == .success(.captureStart(id: "s", language: language, outputVolumeScale: nil, microphone: nil, detectHost: true, hotkeyUptimeMs: nil)))
}

@Test func captureStartRequiresAValidLanguage() throws {
    for line in [
        #"{"type":"capture.start","microphone":null,"id":"s","outputVolumeScale":null}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":null,"outputVolumeScale":null}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":true,"outputVolumeScale":null}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"unknown","outputVolumeScale":null}"#,
        #"{"type":"capture.start","microphone":null,"id":"s","language":"","outputVolumeScale":null}"#,
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
    #expect(HelperCommand.decode(line: #"{"type":"capture.start","id":"s","language":"en","outputVolumeScale":null,"microphone":{"uid":"usb","name":"USB Microphone"},"detectHost":true}"#)
        == .success(.captureStart(id: "s", language: .en, outputVolumeScale: nil, microphone: microphone, detectHost: true, hotkeyUptimeMs: nil)))
    for line in [
        #"{"type":"capture.start","id":"s","language":"en","outputVolumeScale":null}"#,
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
