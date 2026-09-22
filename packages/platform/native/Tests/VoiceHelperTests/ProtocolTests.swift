import Testing
import Foundation
@testable import VoiceHelperProtocol

@Test func handshakeRequiresSupportedVersion() {
    var connection = Connection()
    #expect(connection.receive(#"{"type":"hello","version":1}"#) == .ready)
    #expect(connection.receive(#"{"type":"cancel","version":1}"#) == .cancelled)
    #expect(connection.receive(#"{"type":"shutdown","version":1}"#) == .stopped)
    #expect(connection.receive(#"{"type":"hello","version":1}"#) == .rejected)
}

@Test func invalidMessagesNeverBecomeReady() {
    for payload in [#"{"type":"hello","version":2}"#, #"{"type":"hello","version":1,"capture":true}"#, #"{"type":"capture","version":1}"#, "{}", "invalid"] {
        var connection = Connection()
        #expect(connection.receive(payload) == .rejected)
    }
}

@Test func disconnectEndsConnectionWithoutReplayingIntent() {
    var connection = Connection()
    #expect(connection.receive(#"{"type":"hello","version":1}"#) == .ready)
    connection.disconnect()
    #expect(connection.receive(#"{"type":"cancel","version":1}"#) == .rejected)
}

@Test func setupRejectsMalformedPermissionAndCredentialRequests() throws {
    let invalid = [
        #"{"type":"setup.request","version":true,"id":1,"command":{"type":"credential.remove"}}"#,
        #"{"type":"setup.request","version":1,"id":true,"command":{"type":"credential.remove"}}"#,
        #"{"type":"setup.request","version":1,"id":1.5,"command":{"type":"credential.remove"}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"credential.remove","service":"unrelated"}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"credential.set","key":""}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"permission.request","permission":"screen"}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"capture"}}"#,
    ]
    for line in invalid {
        let object = try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        #expect(SetupRequest(object) == nil)
    }
    let object = try #require(JSONSerialization.jsonObject(with: Data(#"{"type":"setup.request","version":1,"id":8,"command":{"type":"permission.request","permission":"microphone"}}"#.utf8)) as? [String: Any])
    let request = try #require(SetupRequest(object))
    #expect(request.id == 8)
    guard case .requestPermission(.microphone) = request.command else { Issue.record("Expected explicit microphone permission request"); return }
}

@Test func shortcutAndTargetRequestsRequireExactShapes() throws {
    let valid = [
        (#"{"type":"setup.request","version":1,"id":1,"command":{"type":"shortcut.configure","shortcuts":{"hold":"Fn","toggle":"Fn+Space","cancel":"Escape"},"active":true}}"#, "shortcut"),
        (#"{"type":"setup.request","version":1,"id":2,"command":{"type":"target.capture","session":"one"}}"#, "capture"),
        (#"{"type":"setup.request","version":1,"id":3,"command":{"type":"target.insert","session":"one","text":"Hello"}}"#, "insert"),
        (#"{"type":"setup.request","version":1,"id":4,"command":{"type":"target.arm","session":"one"}}"#, "arm"),
        (#"{"type":"setup.request","version":1,"id":5,"command":{"type":"target.release","session":"one"}}"#, "release"),
    ]
    for (line, kind) in valid {
        let object = try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        let request = try #require(SetupRequest(object), "\(kind)")
        switch (kind, request.command) {
        case ("shortcut", .configureShortcuts(let bindings, let active)): #expect(bindings.hold == .fn && active)
        case ("capture", .captureTarget("one")), ("arm", .armTarget("one")), ("release", .releaseTarget("one")): break
        case ("insert", .insertTarget("one", let text)): #expect(text == "Hello")
        default: Issue.record("Unexpected command for \(kind)")
        }
    }
    let invalid = [
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"shortcut.configure","shortcuts":{"hold":"Fn","toggle":"Fn+Space","cancel":"Escape"}}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"shortcut.configure","shortcuts":{"hold":"Fn","toggle":"Fn+Space","cancel":"Escape"},"active":1}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"target.capture"}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"target.capture","session":""}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"target.insert","session":"one","text":""}}"#,
        #"{"type":"setup.request","version":1,"id":1,"command":{"type":"target.insert","session":"one","text":"Hello","app":"anywhere"}}"#,
    ]
    for line in invalid {
        let object = try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        #expect(SetupRequest(object) == nil, "\(line)")
    }
    let encoded = try JSONEncoder().encode(SetupReply(id: 9, result: .insertion(session: "one", outcome: .uncertain)))
    let reply = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(reply["type"] as? String == "setup.result")
    #expect((reply["result"] as? [String: Any])?["outcome"] as? String == "uncertain")
}
