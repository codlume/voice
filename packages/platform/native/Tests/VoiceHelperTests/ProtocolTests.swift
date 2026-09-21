import Testing
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
