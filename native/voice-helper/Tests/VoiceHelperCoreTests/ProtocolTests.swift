import Foundation
import Testing
@testable import VoiceHelperCore

private func json(_ line: String) throws -> [String: Any] {
    let object = try JSONSerialization.jsonObject(with: Data(line.utf8))
    return try #require(object as? [String: Any])
}

@Test func decodesEveryCommand() throws {
    let cases: [(String, HelperCommand)] = [
        (#"{"type":"hotkey.configure","key":"rightOption"}"#, .hotkeyConfigure(key: .rightOption)),
        (#"{"type":"capture.start","id":"s1"}"#, .captureStart(id: "s1")),
        (#"{"type":"capture.stop","id":"s1"}"#, .captureStop(id: "s1")),
        (#"{"type":"capture.cancel","id":"s1"}"#, .captureCancel(id: "s1")),
        (#"{"type":"insert","id":"s1","text":"hi there"}"#, .insert(id: "s1", text: "hi there")),
        (#"{"type":"permissions.check"}"#, .permissionsCheck),
        (#"{"type":"permissions.request","kind":"accessibility"}"#, .permissionsRequest(kind: .accessibility)),
        (#"{"type":"asr.prepare","download":true}"#, .asrPrepare(download: true)),
        (#"{"type":"test.audioFile","path":"/tmp/a.wav"}"#, .testAudioFile(path: "/tmp/a.wav")),
        (#"{"type":"test.audioFile","path":null}"#, .testAudioFile(path: nil)),
        (#"{"type":"test.hotkey","action":"cancel"}"#, .testHotkey(action: .cancel)),
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
}

private func unknownDescription(_ result: Result<HelperCommand, ProtocolError>) throws -> String {
    guard case .failure(let error) = result else {
        throw ProtocolError("expected a decode failure")
    }
    return error.description
}

@Test func encodesEveryEventWithContractTypeStrings() throws {
    let cases: [(HelperEvent, [String: Any])] = [
        (.ready(version: 1), ["type": "ready", "version": 1]),
        (.hotkey(action: .down), ["type": "hotkey", "action": "down"]),
        (.captureStarted(id: "s", startMs: 12.5), ["type": "capture.started", "id": "s", "startMs": 12.5]),
        (.captureLevel(id: "s", level: 0.4), ["type": "capture.level", "id": "s", "level": 0.4]),
        (.captureFailed(id: "s", reason: .device, message: "gone"),
         ["type": "capture.failed", "id": "s", "reason": "device", "message": "gone"]),
        (.captureCancelled(id: "s"), ["type": "capture.cancelled", "id": "s"]),
        (.transcript(id: "s", text: "hello", audioMs: 1000, asrMs: 80),
         ["type": "transcript", "id": "s", "text": "hello", "audioMs": 1000, "asrMs": 80]),
        (.transcriptFailed(id: "s", reason: .asrUnavailable, message: "no model"),
         ["type": "transcript.failed", "id": "s", "reason": "asrUnavailable", "message": "no model"]),
        (.insertResult(id: "s", method: .none, reason: .focusChanged),
         ["type": "insert.result", "id": "s", "method": "none", "reason": "focusChanged"]),
        (.permissions(microphone: .granted, accessibility: .notDetermined),
         ["type": "permissions", "microphone": "granted", "accessibility": "notDetermined"]),
        (.asrStatus(state: .failed, message: "boom"), ["type": "asr.status", "state": "failed", "message": "boom"]),
        (.log(level: .error, message: "bad"), ["type": "log", "level": "error", "message": "bad"]),
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
    let line = HelperEvent.transcript(id: "s", text: "zażółć /tmp/x", audioMs: 0, asrMs: 0).encodeLine()
    #expect(line.contains("/tmp/x"))
    #expect(try json(line)["text"] as? String == "zażółć /tmp/x")
}
