import Foundation

FileHandle.standardOutput.write(Data("{\"type\":\"ready\",\"version\":1}\n".utf8))

// Main owns the helper's lifetime: stay alive until it closes stdin.
while readLine() != nil {}
