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

// Test-only synthetic capture source: the PCM samples of a 16 kHz mono 16-bit WAV, at most five
// minutes. Any other layout is refused so a fixture is never resampled or reinterpreted.
public enum FixtureWave {
    public static func pcm(_ data: Data) -> Data? {
        let bytes = [UInt8](data)
        func word(_ offset: Int) -> Int { Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 }
        func long(_ offset: Int) -> Int { word(offset) | word(offset + 2) << 16 }
        func tag(_ offset: Int) -> String { String(decoding: bytes[offset..<offset + 4], as: UTF8.self) }
        guard bytes.count >= 12, tag(0) == "RIFF", tag(8) == "WAVE" else { return nil }
        var offset = 12
        var format = false
        while offset + 8 <= bytes.count {
            let size = long(offset + 4)
            let body = offset + 8
            guard body + size <= bytes.count else { return nil }
            if tag(offset) == "fmt " {
                guard size >= 16, word(body) == 1, word(body + 2) == 1, long(body + 4) == 16000, word(body + 14) == 16 else { return nil }
                format = true
            } else if tag(offset) == "data" {
                guard format, size > 0, size % 2 == 0, size <= 9_600_000 else { return nil }
                return data.subdata(in: data.startIndex + body..<data.startIndex + body + size)
            }
            offset = body + size + size % 2
        }
        return nil
    }
}
