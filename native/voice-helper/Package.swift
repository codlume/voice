// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "voice-helper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "voice-helper", targets: ["VoiceHelper"]),
    ],
    targets: [
        .executableTarget(name: "VoiceHelper"),
        .testTarget(name: "VoiceHelperTests", dependencies: ["VoiceHelper"]),
    ]
)
