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
