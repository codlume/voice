import AppKit
import ApplicationServices
import Foundation
import VoiceHelperCore

private let browserBundleIds: Set<String> = [
    "com.apple.Safari", "com.apple.SafariTechnologyPreview",
    "com.google.Chrome", "com.google.Chrome.canary", "org.chromium.Chromium", "net.imput.helium",
    "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac",
    "org.mozilla.firefox", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
]

private let webAreaMaxDepth = 25
private let windowSearchMaxDepth = 3
private let windowSearchMaxNodes = 64
/// Warm reads finish in under 50 ms and a fresh Chrome in about 25 ms, so a read still running
/// after this has met a stalled browser and must not keep sending it requests after the session.
private let hostReadBudget: TimeInterval = 1

func readPageHost(of target: InsertTarget, log: ((String) -> Void)?) {
    guard let pid = target.pid, let bundleId = target.bundleId, browserBundleIds.contains(bundleId),
        AXIsProcessTrusted()
    else {
        target.host = .read(nil)
        return
    }
    let started = DispatchTime.now()
    let deadline = started + hostReadBudget
    DispatchQueue.global(qos: .utility).async {
        let (host, outcome) = browserPageHost(pid: pid, deadline: deadline)
        let elapsed = Int(started.millisecondsToNow().rounded())
        DispatchQueue.main.async {
            target.host = .read(host)
            log?("target host read: \(outcome) in \(elapsed) ms")
        }
    }
}

private func browserPageHost(pid: pid_t, deadline: DispatchTime) -> (host: String?, outcome: String) {
    let expired = { DispatchTime.now() >= deadline }
    let app = AXNode(AXUIElementCreateApplication(pid))
    guard !expired() else { return (nil, "gave up at the deadline") }
    if let focused = app.element(kAXFocusedUIElementAttribute) {
        let walk = webArea(above: focused, maxDepth: webAreaMaxDepth, giveUp: expired)
        guard let area = walk.node else {
            return (nil, "\(expired() ? "gave up at the deadline" : "no web area") after \(walk.hops) hops")
        }
        return host(of: area, "after \(walk.hops) hops")
    }
    // Chromium reports no focused element until an assistive client switches its web accessibility
    // on, but the view hosting the page still answers for the URL, so this finds the page without
    // turning that tree on.
    guard !expired(), let window = app.element(kAXFocusedWindowAttribute) else { return (nil, "no focused window") }
    let search = pageNode(below: window, maxDepth: windowSearchMaxDepth, maxNodes: windowSearchMaxNodes, giveUp: expired)
    guard let page = search.node else {
        return (nil, "\(expired() ? "gave up at the deadline" : "no page below the window") after \(search.visited) nodes")
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
