public protocol AccessibilityNode {
    var parent: Self? { get }
    var role: String? { get }
    var url: String? { get }
    /// At most `limit` children, so a wide node never materializes more than the search can visit.
    func children(limit: Int) -> [Self]
}

private let webAreaRole = "AXWebArea"

/// `giveUp` is asked before every node access, so a deadline can end the walk between two
/// accessibility round trips.
public func webArea<N: AccessibilityNode>(above node: N, maxDepth: Int, giveUp: () -> Bool) -> (node: N?, hops: Int) {
    var current = node
    var hops = 0
    while !giveUp() {
        if current.role == webAreaRole { return (current, hops) }
        guard hops < maxDepth, !giveUp(), let parent = current.parent else { return (nil, hops) }
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
