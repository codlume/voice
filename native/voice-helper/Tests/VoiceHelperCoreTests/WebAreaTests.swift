import Testing
@testable import VoiceHelperCore

/// A chain of roles from the focused element upward; index 0 is the start node.
private struct Chain: AccessibilityNode {
    let roles: [String?]
    var index = 0

    var role: String? { roles[index] }
    var parent: Chain? {
        index + 1 < roles.count ? Chain(roles: roles, index: index + 1) : nil
    }
}

@Suite struct WebAreaTests {
    @Test func stopsAtTheFirstWebArea() {
        let chain = Chain(roles: ["AXTextField", "AXGroup", "AXWebArea", "AXGroup", "AXWebArea", "AXWindow"])
        let found = webArea(above: chain, maxDepth: 40)
        #expect(found.node?.index == 2)
        #expect(found.hops == 2)
    }

    @Test func aFocusedWebAreaCountsWithoutHopping() {
        let found = webArea(above: Chain(roles: ["AXWebArea", "AXWindow"]), maxDepth: 40)
        #expect(found.node?.index == 0)
        #expect(found.hops == 0)
    }

    @Test func givesUpAtTheDepthBound() {
        let chain = Chain(roles: Array(repeating: "AXGroup", count: 5) + ["AXWebArea"])
        let bounded = webArea(above: chain, maxDepth: 4)
        #expect(bounded.node == nil)
        #expect(bounded.hops == 4)
        #expect(webArea(above: chain, maxDepth: 5).node?.index == 5)
    }

    @Test func runsOutOfParentsBeforeTheBound() {
        let chain = Chain(roles: ["AXTextArea", nil, "AXWindow"])
        let found = webArea(above: chain, maxDepth: 40)
        #expect(found.node == nil)
        #expect(found.hops == 2)
    }
}
