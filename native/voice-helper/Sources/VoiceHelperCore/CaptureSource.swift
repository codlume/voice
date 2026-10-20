public enum CaptureSource: Equatable, Sendable {
    case microphone
    case fixture(String)
    case disabled

    public static func resolve(environment: [String: String]) -> CaptureSource {
        guard environment["VOICE_HELPER_TEST"] == "1" else { return .microphone }
        if let path = environment["VOICE_HELPER_TEST_AUDIO"], !path.isEmpty { return .fixture(path) }
        return environment["VOICE_HELPER_ALLOW_MICROPHONE"] == "1" ? .microphone : .disabled
    }
}
