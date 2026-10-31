public enum CaptureSource: Equatable, Sendable {
    case microphone
    case fixture(String)
    case disabled

    public static func resolve(environment: [String: String]) -> CaptureSource {
        guard environment["VOICE_HELPER_TEST"] == "1" else { return .microphone }
        if let path = environment["VOICE_HELPER_TEST_AUDIO"], !path.isEmpty { return .fixture(path) }
        return .disabled
    }
}

/// Where meeting audio comes from. Test mode never opens the microphone or a system tap: it plays
/// fixture files, `speed` times faster than real time, or refuses to record.
public enum MeetingAudioSource: Equatable, Sendable {
    case live
    /// An empty `system` path records the meeting as if system audio were unavailable. The file at
    /// `output`, read as each leg starts, says where the fixture's other side played: "headphones",
    /// or speakers when it says anything else or does not exist.
    case fixture(mic: String, system: String, speed: Double, output: String)
    case disabled

    public static func resolve(environment: [String: String]) -> MeetingAudioSource {
        guard environment["VOICE_HELPER_TEST"] == "1" else { return .live }
        guard let mic = environment["VOICE_HELPER_TEST_MEETING_MIC"], !mic.isEmpty else { return .disabled }
        let speed = environment["VOICE_HELPER_TEST_MEETING_SPEED"].flatMap(Double.init).flatMap { $0 >= 1 && $0 <= 64 ? $0 : nil } ?? 1
        return .fixture(mic: mic, system: environment["VOICE_HELPER_TEST_MEETING_SYSTEM"] ?? "", speed: speed,
                        output: environment["VOICE_HELPER_TEST_MEETING_OUTPUT"] ?? "")
    }
}

/// Why a meeting source stopped mid-leg: the user took the permission away, or the device
/// stopped delivering audio.
public enum MeetingLossReason: String, Codable, Sendable { case permission, device }

public struct AudioLoss: Equatable, Sendable {
    public let source: MeetingSource
    public let reason: MeetingLossReason

    public init(source: MeetingSource, reason: MeetingLossReason) {
        self.source = source
        self.reason = reason
    }
}

/// What a recording leg checks every few seconds, so a revoked permission or a dead microphone
/// pauses the meeting instead of recording silence that looks like a quiet room. System audio
/// legitimately goes quiet, so only its permission counts; the microphone always delivers.
public enum MeetingWatch {
    public static let micStallMs = 5000.0

    /// `msSinceMicAudio` is nil while the microphone reopens after a device change.
    public static func loss(micAllowed: Bool, systemRecording: Bool, systemAllowed: Bool, msSinceMicAudio: Double?) -> AudioLoss? {
        if !micAllowed { return AudioLoss(source: .mic, reason: .permission) }
        if systemRecording, !systemAllowed { return AudioLoss(source: .system, reason: .permission) }
        if let msSinceMicAudio, msSinceMicAudio >= micStallMs { return AudioLoss(source: .mic, reason: .device) }
        return nil
    }
}
