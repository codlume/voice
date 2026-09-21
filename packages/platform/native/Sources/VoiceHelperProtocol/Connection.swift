import Foundation
import CoreFoundation

public enum Reply: String, Sendable {
    case ready, cancelled, stopped, rejected
}

// This foundation has no capture command or microphone dependency.
public struct Connection {
    private enum State { case waiting, ready, stopped }
    private var state = State.waiting

    public init() {}

    public mutating func receive(_ line: String) -> Reply {
        guard state != .stopped,
              let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["type", "version"]),
              let version = object["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              version == 1,
              let type = object["type"] as? String else { return .rejected }
        switch (state, type) {
        case (.waiting, "hello"):
            state = .ready
            return .ready
        case (.ready, "cancel"):
            return .cancelled
        case (_, "shutdown"):
            state = .stopped
            return .stopped
        default:
            return .rejected
        }
    }

    public mutating func disconnect() { state = .stopped }
}
