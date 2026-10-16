public protocol AccessibilityNode {
    var parent: Self? { get }
    var children: [Self] { get }
    var role: String? { get }
    var url: String? { get }
}

private let webAreaRole = "AXWebArea"

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

public func pageNode<N: AccessibilityNode>(below node: N, maxDepth: Int, maxNodes: Int) -> (node: N?, visited: Int) {
    var visited = 0
    func search(_ current: N, depth: Int) -> N? {
        guard visited < maxNodes else { return nil }
        visited += 1
        if current.url != nil { return current }
        guard depth < maxDepth else { return nil }
        for child in current.children {
            if let found = search(child, depth: depth + 1) { return found }
        }
        return nil
    }
    return (search(node, depth: 0), visited)
}
