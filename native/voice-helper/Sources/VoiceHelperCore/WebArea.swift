public protocol AccessibilityNode {
    var parent: Self? { get }
    var role: String? { get }
    var url: String? { get }
    /// At most `limit` children, so a wide node never materializes more than the search can visit.
    func children(limit: Int) -> [Self]
}

private let webAreaRole = "AXWebArea"
private let windowRole = "AXWindow"

/// The outermost web area is the document whose URL is in the address bar. An iframe (an editor
/// frame at about:blank, a third-party widget) is a web area of its own below it, so the walk
/// keeps going to the window, or to the top of the ancestry, and reports the last one seen.
/// `giveUp` is asked before every node access, so a deadline can end the walk between two
/// accessibility round trips. A walk that the deadline or `maxDepth` ends before the window
/// reports nothing rather than an inner frame.
public func outermostWebArea<N: AccessibilityNode>(above node: N, maxDepth: Int, giveUp: () -> Bool) -> (node: N?, hops: Int) {
    var current = node
    var hops = 0
    var found: (node: N?, hops: Int)?
    while !giveUp() {
        let role = current.role
        if role == webAreaRole { found = (current, hops) }
        if role == windowRole { return found ?? (nil, hops) }
        if hops == maxDepth || giveUp() { return (nil, hops) }
        guard let parent = current.parent else { return found ?? (nil, hops) }
        current = parent
        hops += 1
    }
    return (nil, hops)
}

public func pageNode<N: AccessibilityNode>(
    below node: N, maxDepth: Int, maxNodes: Int, giveUp: () -> Bool
) -> (node: N?, visited: Int) {
    var visited = 0
    func search(_ current: N, depth: Int) -> N? {
        guard visited < maxNodes, !giveUp() else { return nil }
        visited += 1
        if current.url != nil { return current }
        guard depth < maxDepth, visited < maxNodes, !giveUp() else { return nil }
        for child in current.children(limit: maxNodes - visited) {
            if let found = search(child, depth: depth + 1) { return found }
            if visited >= maxNodes || giveUp() { return nil }
        }
        return nil
    }
    return (search(node, depth: 0), visited)
}
