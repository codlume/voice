import Foundation
import VoiceHelperProtocol

var connection = Connection()
while let line = readLine() {
    let reply = connection.receive(line)
    let output = "{\"type\":\"\(reply.rawValue)\",\"version\":1,\"capture\":\"unavailable\"}\n"
    FileHandle.standardOutput.write(Data(output.utf8))
    if reply == .stopped { break }
}
connection.disconnect()
