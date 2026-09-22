import Foundation
import VoiceHelperProtocol

let outputLock = NSLock()
@Sendable func output(_ data: Data) {
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}
let fixture = ProcessInfo.processInfo.environment["VOICE_TEST_CAPTURE"] == "synthetic" && ProcessInfo.processInfo.environment["VOICE_TEST_KEYCHAIN_SERVICE"]?.hasPrefix("com.codlume.voice.test.") == true
let setup = SetupService()
let shortcuts = ShortcutService(emit: output)
let targets = TargetService(emit: output)
shortcuts.onInput = { targets.userInput() }
let capture = CaptureService(fixture: fixture, emit: output)

// The main thread runs the run loop that services the event tap and accessibility observers.
// Commands arrive on a reader thread and hop to the main actor; capture keeps its own queue.
RunLoop.main.add(Port(), forMode: .default)
let reader = Thread { [capture] in
    var connection = Connection()
    var ready = false
    while let line = readLine() {
        // Only insertion requests may carry a long transcript; every other line stays small.
        if ready, line.utf8.count <= 600_000,
           let data = line.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           line.utf8.count <= 16384 || object["type"] as? String == "setup.request" {
            if let request = CaptureRequest(object) { capture.receive(request); continue }
            if object["type"] as? String == "credential.read", Set(object.keys) == Set(["type", "id"]), let id = object["id"] as? Int {
                let key = fixture ? "synthetic-fixture-key" : DispatchQueue.main.sync { MainActor.assumeIsolated { setup.readKey() } }
                let reply: [String: Any] = ["type": "credential.secret", "id": id, "key": key as Any? ?? NSNull()]
                if let data = try? JSONSerialization.data(withJSONObject: reply) { output(data) }
                continue
            }
            if fixture, object["type"] as? String == "pointer.simulate" {
                let simulated = SimulatedPointer(object)
                let consumed = DispatchQueue.main.sync { MainActor.assumeIsolated { simulated.flatMap { shortcuts.simulate($0) } } }
                let reply: [String: Any] = ["type": "pointer.simulated", "consumed": consumed as Any? ?? NSNull()]
                if let data = try? JSONSerialization.data(withJSONObject: reply) { output(data) }
                continue
            }
            if fixture, object["type"] as? String == "shortcut.simulate" {
                let simulated = SimulatedKey(object)
                let consumed = DispatchQueue.main.sync { MainActor.assumeIsolated { simulated.flatMap { shortcuts.simulate($0) } } }
                let reply: [String: Any] = ["type": "shortcut.simulated", "consumed": consumed as Any? ?? NSNull()]
                if let data = try? JSONSerialization.data(withJSONObject: reply) { output(data) }
                continue
            }
            if object["type"] as? String == "setup.request" {
                let request = SetupRequest(object)
                // Target work stays off the main thread; shortcut and setup work needs the main actor.
                let result = request.map { request in
                    targets.receive(request.command) ?? DispatchQueue.main.sync {
                        MainActor.assumeIsolated {
                            if case .configureShortcuts(let bindings, let active, let bar) = request.command {
                                return SetupResult.shortcuts(listening: shortcuts.configure(bindings, active: active, bar: bar))
                            }
                            return setup.receive(request.command)
                        }
                    }
                } ?? .error(.invalidCommand)
                // Only valid numeric identities are reflected back into the reply.
                let id = request?.id ?? (object["id"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 0
                if let encoded = try? JSONEncoder().encode(SetupReply(id: id, result: result)) { output(encoded) }
                continue
            }
        }
        let reply = connection.receive(line)
        if reply == .ready { ready = true }
        let replyLine = "{\"type\":\"\(reply.rawValue)\",\"version\":1,\"capture\":\"unavailable\"}"
        output(Data(replyLine.utf8))
        if reply == .stopped { break }
    }
    capture.disconnect()
    connection.disconnect()
    targets.shutdown()
    DispatchQueue.main.async {
        MainActor.assumeIsolated { shortcuts.uninstall() }
        CFRunLoopStop(CFRunLoopGetMain())
    }
}
reader.start()
CFRunLoopRun()
