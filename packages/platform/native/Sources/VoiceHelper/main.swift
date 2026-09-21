import Foundation
import VoiceHelperProtocol

var connection = Connection()
let setup = SetupService()
var ready = false
while let line = readLine() {
    if ready, line.utf8.count <= 16384,
       let data = line.data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       object["type"] as? String == "setup.request" {
        let result = setup.receive(object)
        let reply: [String: Any] = ["type": "setup.result", "version": 1, "id": object["id"] ?? 0, "result": result]
        if let encoded = try? JSONSerialization.data(withJSONObject: reply) {
            FileHandle.standardOutput.write(encoded + Data("\n".utf8))
        }
        continue
    }
    let reply = connection.receive(line)
    if reply == .ready { ready = true }
    let output = "{\"type\":\"\(reply.rawValue)\",\"version\":1,\"capture\":\"unavailable\"}\n"
    FileHandle.standardOutput.write(Data(output.utf8))
    if reply == .stopped { break }
}
connection.disconnect()
