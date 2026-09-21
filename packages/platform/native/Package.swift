// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VoiceHelper",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "voice-helper", targets: ["VoiceHelper"])],
    targets: [
        .target(name: "VoiceHelperProtocol"),
        .executableTarget(name: "VoiceHelper", dependencies: ["VoiceHelperProtocol"]),
        .testTarget(name: "VoiceHelperTests", dependencies: ["VoiceHelperProtocol"]),
    ]
)
