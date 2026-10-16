import ApplicationServices
import Foundation
import VoiceHelperCore

private let browserBundleIds: Set<String> = [
    "com.apple.Safari", "com.apple.SafariTechnologyPreview",
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
    "org.chromium.Chromium", "net.imput.helium",
    "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac",
    "org.mozilla.firefox", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
]

/// Measured walks reach the window in 10 to 11 hops; the bound only stops a runaway ancestry.
private let webAreaMaxDepth = 64
private let windowSearchMaxDepth = 3
private let windowSearchMaxNodes = 64
/// Warm reads measured under 50 ms, so a read still running after this has met a stalled browser.
private let hostReadBudget: TimeInterval = 1

func isBrowser(_ bundleId: String?) -> Bool {
    bundleId.map(browserBundleIds.contains) ?? false
}

func readPageHost(
    of target: InsertTarget, from focus: TargetFocus<FocusElement>, inputUnchanged: () -> Bool, log: ((String) -> Void)?
) {
    dispatchPrecondition(condition: .notOnQueue(.main))
    let started = DispatchTime.now()
    let deadline = started + hostReadBudget
    let giveUp = { DispatchTime.now() >= deadline || target.host.withLock { $0 != .pending } }
    let (host, outcome) = browserPageHost(focus, giveUp: giveUp)
    let unchanged = inputUnchanged()
    target.host.withLock { $0.publish(host, inputUnchanged: unchanged) }
    let elapsed = Int(started.millisecondsToNow().rounded())
    DispatchQueue.main.async { log?("target host read: \(outcome) in \(elapsed) ms") }
}

private func browserPageHost(_ focus: TargetFocus<FocusElement>, giveUp: () -> Bool) -> (host: String?, outcome: String) {
    if let element = focus.element {
        let walk = outermostWebArea(above: AXNode(element.value), maxDepth: webAreaMaxDepth, giveUp: giveUp)
        guard let area = walk.node else {
            return (nil, "\(giveUp() ? "gave up" : "no web area") after \(walk.hops) hops")
        }
        return host(of: area, "after \(walk.hops) hops")
    }
    // Chromium reports no focused element until an assistive client switches its web accessibility
    // on, but the view hosting the page still answers for the URL, so this finds the page without
    // turning that tree on.
    let window = AXNode(focus.window.value)
    let search = pageNode(below: window, maxDepth: windowSearchMaxDepth, maxNodes: windowSearchMaxNodes, giveUp: giveUp)
    guard let page = search.node else {
        return (nil, "\(giveUp() ? "gave up" : "no page below the window") after \(search.visited) nodes")
    }
    return host(of: page, "below the window after \(search.visited) nodes")
}

private func host(of page: AXNode, _ location: String) -> (host: String?, outcome: String) {
    guard let url = page.url, let host = pageHost(url) else { return (nil, "not http(s) \(location)") }
    return (host, "found \(location)")
}

private struct AXNode: AccessibilityNode {
    let value: AXUIElement

    init(_ value: AXUIElement) {
        self.value = value
        AXUIElementSetMessagingTimeout(value, axMessagingTimeout)
    }

    var parent: AXNode? { element(kAXParentAttribute) }
    var role: String? { attribute(kAXRoleAttribute) as? String }

    var url: String? {
        guard let value = attribute(kAXURLAttribute) else { return nil }
        return (value as? URL)?.absoluteString ?? value as? String
    }

    func children(limit: Int) -> [AXNode] {
        var values: CFArray?
        guard limit > 0,
            AXUIElementCopyAttributeValues(value, kAXChildrenAttribute as CFString, 0, limit, &values) == .success
        else { return [] }
        return ((values as? [AXUIElement]) ?? []).map(AXNode.init)
    }

    func element(_ name: String) -> AXNode? {
        guard let value = attribute(name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return AXNode(value as! AXUIElement)
    }

    private func attribute(_ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(value, name as CFString, &result) == .success else { return nil }
        return result
    }
}

func isBrowser(_ bundleId: String) -> Bool {
    browserBundleIds.contains(bundleId)
}
