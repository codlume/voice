import Foundation

public struct InstalledApp: Equatable, Sendable {
    public let bundleId: String
    public let name: String
    public let path: String
    public let modifiedMs: Double

    public init(bundleId: String, name: String, path: String, modifiedMs: Double) {
        self.bundleId = bundleId
        self.name = name
        self.path = path
        self.modifiedMs = modifiedMs
    }
}

public struct RenderedIcon: Equatable, Sendable {
    public let path: String
    public let png: Data

    public init(path: String, png: Data) {
        self.path = path
        self.png = png
    }
}

public func installedApp(info: [String: Any], path: String, modifiedMs: Double) -> InstalledApp? {
    guard let bundleId = nonBlank(info["CFBundleIdentifier"]) else { return nil }
    let fileName = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
    guard let name = nonBlank(info["CFBundleDisplayName"]) ?? nonBlank(info["CFBundleName"]) ?? nonBlank(fileName) else {
        return nil
    }
    return InstalledApp(bundleId: bundleId, name: name, path: path, modifiedMs: modifiedMs)
}

// Some bundles pad their names with invisible format characters; WhatsApp's display name
// starts with a left-to-right mark (U+200E).
private let padding = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)

private func nonBlank(_ value: Any?) -> String? {
    guard let trimmed = (value as? String)?.trimmingCharacters(in: padding), !trimmed.isEmpty else {
        return nil
    }
    return trimmed
}
