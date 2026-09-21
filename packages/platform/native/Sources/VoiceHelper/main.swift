import Foundation
import VoiceHelperProtocol

var connection = Connection()
let setup = SetupService()
let outputLock = NSLock()
@Sendable func output(_ data: Data) {
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}
let fixture = ProcessInfo.processInfo.environment["VOICE_TEST_CAPTURE"] == "synthetic" && ProcessInfo.processInfo.environment["VOICE_TEST_KEYCHAIN_SERVICE"]?.hasPrefix("com.codlume.voice.test.") == true
let capture = CaptureService(fixture: fixture, emit: output)
var ready = false
while let line = readLine() {
    if ready, line.utf8.count <= 16384,
       let data = line.data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        if let request = CaptureRequest(object) { capture.receive(request); continue }
        if object["type"] as? String == "credential.read", Set(object.keys) == Set(["type", "id"]), let id = object["id"] as? Int {
            let key = fixture ? "synthetic-fixture-key" : setup.readKey()
            let reply: [String: Any] = ["type": "credential.secret", "id": id, "key": key as Any? ?? NSNull()]
            if let data = try? JSONSerialization.data(withJSONObject: reply) { output(data) }
            continue
        }
    }
    if ready, line.utf8.count <= 16384,
       let data = line.data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       object["type"] as? String == "setup.request" {
        let request = SetupRequest(object)
        let result = request.map { setup.receive($0.command) } ?? .error(.invalidCommand)
        // Only valid numeric identities are reflected back into the reply.
        let id = request?.id ?? (object["id"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 0
        let reply = SetupReply(id: id, result: result)
        if let encoded = try? JSONEncoder().encode(reply) {
            output(encoded)
        }
        continue
    }
    let reply = connection.receive(line)
    if reply == .ready { ready = true }
    let replyLine = "{\"type\":\"\(reply.rawValue)\",\"version\":1,\"capture\":\"unavailable\"}\n"
    output(Data(replyLine.dropLast().utf8))
    if reply == .stopped { break }
}
capture.disconnect()
connection.disconnect()
