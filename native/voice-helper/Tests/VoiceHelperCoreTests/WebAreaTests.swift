import Testing
@testable import VoiceHelperCore

private struct Chain: AccessibilityNode {
    let roles: [String?]
    var index = 0

    var role: String? { roles[index] }
    var children: [Chain] { [] }
    var url: String? { nil }
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

private final class Tree: AccessibilityNode, Equatable {
    let name: String
    let url: String?
    let children: [Tree]

    init(_ name: String, url: String? = nil, _ children: [Tree] = []) {
        self.name = name
        self.url = url
        self.children = children
    }

    var parent: Tree? { nil }
    var role: String? { nil }
    static func == (lhs: Tree, rhs: Tree) -> Bool { lhs === rhs }
}

@Suite struct PageNodeTests {
    @Test func findsTheFirstNodeWithAUrlInDocumentOrder() {
        let page = Tree("content", url: "https://example.com/")
        let window = Tree("window", [
            Tree("toolbar", [Tree("back"), Tree("forward"), Tree("omnibox")]),
            Tree("tabs", [Tree("tab")]),
            page,
            Tree("other", url: "https://other.example/"),
        ])
        let found = pageNode(below: window, maxDepth: 3, maxNodes: 64)
        #expect(found.node == page)
        #expect(found.visited == 8)
    }

    @Test func doesNotDescendPastTheBound() {
        let page = Tree("content", url: "https://example.com/")
        let deep = Tree("window", [Tree("a", [Tree("b", [page])])])
        #expect(pageNode(below: deep, maxDepth: 2, maxNodes: 64).node == nil)
        #expect(pageNode(below: deep, maxDepth: 3, maxNodes: 64).node == page)
    }

    @Test func reportsNothingForAWindowWithoutAPage() {
        let found = pageNode(below: Tree("window", [Tree("toolbar", [Tree("back")])]), maxDepth: 3, maxNodes: 64)
        #expect(found.node == nil)
        #expect(found.visited == 3)
    }

    @Test func stopsAfterTheNodeBudgetEvenWhenAPageIsStillAhead() {
        let page = Tree("content", url: "https://example.com/")
        let wide = Tree("window", (1...10).map { Tree("toolbar \($0)") } + [page])
        let capped = pageNode(below: wide, maxDepth: 3, maxNodes: 6)
        #expect(capped.node == nil)
        #expect(capped.visited == 6)
        #expect(pageNode(below: wide, maxDepth: 3, maxNodes: 64).node == page)
    }
}
