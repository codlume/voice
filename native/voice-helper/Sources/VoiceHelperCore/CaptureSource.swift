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
    /// An empty `system` path records the meeting as if system audio were unavailable.
    case fixture(mic: String, system: String, speed: Double)
    case disabled

    public static func resolve(environment: [String: String]) -> MeetingAudioSource {
        guard environment["VOICE_HELPER_TEST"] == "1" else { return .live }
        guard let mic = environment["VOICE_HELPER_TEST_MEETING_MIC"], !mic.isEmpty else { return .disabled }
        let speed = environment["VOICE_HELPER_TEST_MEETING_SPEED"].flatMap(Double.init).flatMap { $0 >= 1 && $0 <= 64 ? $0 : nil } ?? 1
        return .fixture(mic: mic, system: environment["VOICE_HELPER_TEST_MEETING_SYSTEM"] ?? "", speed: speed)
    }
}
