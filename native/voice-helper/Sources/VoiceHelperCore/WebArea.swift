public protocol AccessibilityNode {
    var parent: Self? { get }
    var role: String? { get }
}

public let webAreaRole = "AXWebArea"

/// Walks parents from `node` to the first web area. The start node counts, so a focused web area
/// is found after zero hops. The bound caps accessibility round trips in a deep or cyclic tree.
public func webArea<N: AccessibilityNode>(above node: N, maxDepth: Int) -> (node: N?, hops: Int) {
    var current = node
    var hops = 0
    while true {
        if current.role == webAreaRole { return (current, hops) }
        guard hops < maxDepth, let parent = current.parent else { return (nil, hops) }
        current = parent
        hops += 1
    }
}
