/// Apps, by bundle id, whose `AXSelectedText` write reported success and still showed no change
/// on the late re-read. Chromium and Electron answer that way, so later insertions into them paste
/// at once instead of paying the write and the wait. A write that landed by the re-read was slow,
/// not ignored, so it is not kept. It lives in memory only, since an app may fix this in its next
/// release.
public struct PasteOnlyApps: Equatable, Sendable {
    private var bundleIds: Set<String> = []

    public init() {}

    public func contains(_ bundleId: String?) -> Bool {
        bundleId.map(bundleIds.contains) ?? false
    }

    public mutating func record(_ bundleId: String?, lateVerdict: AXWriteVerdict) {
        guard lateVerdict == .unchanged, let bundleId else { return }
        bundleIds.insert(bundleId)
    }
}
