import AppKit
import Foundation
import VoiceHelperCore

final class InstalledApps {
    private let output: Output
    private let queue = DispatchQueue(label: "voice.installed-apps", qos: .utility)

    init(output: Output) {
        self.output = output
    }

    func list() {
        queue.async { [output] in
            output.emit(.appsListed(apps: scanInstalledApps()))
        }
    }

    func renderIcons(id: String, paths: [String]) {
        queue.async { [output] in
            let icons = paths.compactMap { path in
                autoreleasepool { renderIcon(path: path).map { RenderedIcon(path: path, png: $0) } }
            }
            output.emit(.iconsRendered(id: id, icons: icons))
        }
    }
}

private func scanInstalledApps() -> [InstalledApp] {
    let roots = ["/Applications", "/System/Applications", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
    return roots.flatMap { root in
        sortedEntries(root).flatMap { path -> [String] in
            if path.hasSuffix(".app") { return [path] }
            return isDirectory(path) ? sortedEntries(path).filter { $0.hasSuffix(".app") } : []
        }
        .compactMap(readInstalledApp)
    }
}

private func sortedEntries(_ directory: String) -> [String] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []
    return names.filter { !$0.hasPrefix(".") }.sorted().map { (directory as NSString).appendingPathComponent($0) }
}

private func isDirectory(_ path: String) -> Bool {
    var directory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
}

// Bundle(url:) caches each bundle for the life of the process, so an app updated or replaced
// after launch would keep its old name; reading the plist directly stays fresh.
private func readInstalledApp(path: String) -> InstalledApp? {
    let plist = URL(fileURLWithPath: path).appendingPathComponent("Contents/Info.plist")
    guard let data = try? Data(contentsOf: plist),
          let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
        return nil
    }
    return installedApp(info: info, path: path, modifiedMs: modifiedMs(path: path, plist: plist.path), isBrowser: isBrowser)
}

// Replacing a bundle changes the directory's date and an update rewrites its Info.plist, so the
// later of the two tells main a cached icon may be stale.
private func modifiedMs(path: String, plist: String) -> Double {
    let dates = [path, plist].compactMap { try? FileManager.default.attributesOfItem(atPath: $0)[.modificationDate] as? Date }
    return (dates.max()?.timeIntervalSince1970 ?? 0) * 1000
}

private let iconPixels = 64

private func renderIcon(path: String) -> Data? {
    guard FileManager.default.fileExists(atPath: path),
          let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: iconPixels, pixelsHigh: iconPixels,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: rep) else {
        return nil
    }
    let icon = NSWorkspace.shared.icon(forFile: path)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    icon.draw(in: NSRect(x: 0, y: 0, width: iconPixels, height: iconPixels))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}
