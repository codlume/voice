// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "voice-helper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "voice-helper", targets: ["VoiceHelper"]),
        .executable(name: "fnpost", targets: ["FnPost"]),
        .library(name: "VoiceHelperCore", targets: ["VoiceHelperCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.4"),
    ],
    targets: [
        .target(name: "VoiceHelperCore"),
        .executableTarget(
            name: "VoiceHelper",
            dependencies: [
                "VoiceHelperCore",
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            // AVAudioEngine taps and the CGEventTap C callback are not expressible
            // under strict concurrency; the pure core stays in Swift 6 mode.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(name: "FnPost"),
        .testTarget(name: "VoiceHelperCoreTests", dependencies: ["VoiceHelperCore"]),
    ]
)
