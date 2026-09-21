// swift-tools-version: 6.0
import PackageDescription
import Foundation

let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "VoiceHelper",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "voice-helper", targets: ["VoiceHelper"])],
    targets: [
        .target(name: "VoiceHelperProtocol"),
        .executableTarget(name: "VoiceHelper", dependencies: ["VoiceHelperProtocol"], linkerSettings: [
            .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
        ]),
        .testTarget(name: "VoiceHelperTests", dependencies: ["VoiceHelperProtocol"]),
    ]
)
