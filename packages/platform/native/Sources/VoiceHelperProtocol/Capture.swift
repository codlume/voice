import Foundation

public struct CaptureRequest: Sendable {
    public let type: String
    public let session: String
    public let attempt: String
    public let device: String?
    public init?(_ object: [String: Any]) {
        guard let type = object["type"] as? String,
              ["capture.start", "capture.stop", "capture.cancel"].contains(type),
              let session = object["session"] as? String, !session.isEmpty, session.count <= 64,
              let attempt = object["attempt"] as? String, !attempt.isEmpty, attempt.count <= 64,
              Set(object.keys) == Set(type == "capture.start" ? ["type", "session", "attempt", "device"] : ["type", "session", "attempt"]) else { return nil }
        if type == "capture.start", !(object["device"] is NSNull), !(object["device"] is String) { return nil }
        self.type = type; self.session = session; self.attempt = attempt
        self.device = object["device"] as? String
    }
}
