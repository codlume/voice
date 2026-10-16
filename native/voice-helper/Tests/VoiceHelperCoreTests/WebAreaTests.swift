import Testing
@testable import VoiceHelperCore

private func never() -> Bool { false }

/// Gives up after `after` checks, the way a deadline passes between two accessibility requests.
private func expiring(after checks: Int) -> () -> Bool {
    var remaining = checks
    return {
        remaining -= 1
        return remaining < 0
    }
}

private struct Chain: AccessibilityNode {
    let roles: [String?]
    var index = 0

    var role: String? { roles[index] }
    var url: String? { nil }
    var parent: Chain? {
        index + 1 < roles.count ? Chain(roles: roles, index: index + 1) : nil
    }

    func children(limit: Int) -> [Chain] { [] }
}

@Suite struct WebAreaTests {
    @Test func reportsTheOutermostWebAreaAboveAFocusedIframe() {
        let chain = Chain(roles: ["AXTextField", "AXGroup", "AXWebArea", "AXGroup", "AXWebArea", "AXWindow"])
        let found = outermostWebArea(above: chain, maxDepth: 40, giveUp: never)
        #expect(found.node?.index == 4)
        #expect(found.hops == 4)
    }

    @Test func aFocusedWebAreaCountsWithoutHopping() {
        let found = outermostWebArea(above: Chain(roles: ["AXWebArea", "AXWindow"]), maxDepth: 40, giveUp: never)
        #expect(found.node?.index == 0)
        #expect(found.hops == 0)
    }

    @Test func givesUpAtTheDepthBound() {
        let chain = Chain(roles: Array(repeating: "AXGroup", count: 5) + ["AXWebArea"])
        let bounded = outermostWebArea(above: chain, maxDepth: 4, giveUp: never)
        #expect(bounded.node == nil)
        #expect(bounded.hops == 4)
        #expect(outermostWebArea(above: chain, maxDepth: 5, giveUp: never).node?.index == 5)
    }

    @Test func keepsTheWebAreaSeenWhenTheBoundStopsTheWalk() {
        let chain = Chain(roles: ["AXTextField", "AXWebArea", "AXGroup", "AXGroup", "AXWebArea", "AXWindow"])
        let found = outermostWebArea(above: chain, maxDepth: 2, giveUp: never)
        #expect(found.node?.index == 1)
        #expect(found.hops == 1)
    }

    @Test func runsOutOfParentsBeforeTheBound() {
        let chain = Chain(roles: ["AXTextArea", nil, "AXWindow"])
        let found = outermostWebArea(above: chain, maxDepth: 40, giveUp: never)
        #expect(found.node == nil)
        #expect(found.hops == 2)
    }

    @Test func givesUpWhenTheDeadlinePassesMidWalk() {
        let chain = Chain(roles: ["AXTextField", "AXGroup", "AXGroup", "AXWebArea"])
        let found = outermostWebArea(above: chain, maxDepth: 40, giveUp: expiring(after: 3))
        #expect(found.node == nil)
        #expect(found.hops < 3)
    }

    @Test func dropsAnInnerWebAreaWhenTheDeadlinePassesBeforeTheWindow() {
        let chain = Chain(roles: ["AXTextField", "AXWebArea", "AXGroup", "AXGroup", "AXWebArea", "AXWindow"])
        let found = outermostWebArea(above: chain, maxDepth: 40, giveUp: expiring(after: 4))
        #expect(found.node == nil)
        #expect(found.hops == 2)
    }
}

private final class Materialized {
    var count = 0
}

/// A window tree as Chromium exposes it: toolbars without URLs, one view that carries the page URL.
private final class Tree: AccessibilityNode, Equatable {
    let name: String
    let url: String?
    let kids: [Tree]
    let materialized: Materialized

    init(_ name: String, url: String? = nil, _ kids: [Tree] = [], materialized: Materialized = Materialized()) {
        self.name = name
        self.url = url
        self.kids = kids
        self.materialized = materialized
    }

    var parent: Tree? { nil }
    var role: String? { nil }

    func children(limit: Int) -> [Tree] {
        let fetched = Array(kids.prefix(limit))
        materialized.count += fetched.count
        return fetched
    }

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
        let found = pageNode(below: window, maxDepth: 3, maxNodes: 64, giveUp: never)
        #expect(found.node == page)
        #expect(found.visited == 8)
    }

    @Test func doesNotDescendPastTheBound() {
        let page = Tree("content", url: "https://example.com/")
        let deep = Tree("window", [Tree("a", [Tree("b", [page])])])
        #expect(pageNode(below: deep, maxDepth: 2, maxNodes: 64, giveUp: never).node == nil)
        #expect(pageNode(below: deep, maxDepth: 3, maxNodes: 64, giveUp: never).node == page)
    }

    @Test func reportsNothingForAWindowWithoutAPage() {
        let found = pageNode(below: Tree("window", [Tree("toolbar", [Tree("back")])]), maxDepth: 3, maxNodes: 64, giveUp: never)
        #expect(found.node == nil)
        #expect(found.visited == 3)
    }

    @Test func fetchesNoMoreChildrenThanTheNodeBudgetCanVisit() {
        let materialized = Materialized()
        let page = Tree("content", url: "https://example.com/", materialized: materialized)
        let wide = Tree("window", (1...100_000).map { Tree("toolbar \($0)", materialized: materialized) } + [page], materialized: materialized)
        let capped = pageNode(below: wide, maxDepth: 3, maxNodes: 6, giveUp: never)
        #expect(capped.node == nil)
        #expect(capped.visited == 6)
        #expect(materialized.count == 5)
    }

    @Test func stopsIteratingSiblingsOnceTheBudgetIsSpent() {
        let materialized = Materialized()
        let siblings = (1...4).map { Tree("group \($0)", [Tree("leaf \($0)", materialized: materialized)], materialized: materialized) }
        let window = Tree("window", siblings, materialized: materialized)
        let capped = pageNode(below: window, maxDepth: 3, maxNodes: 4, giveUp: never)
        #expect(capped.node == nil)
        #expect(capped.visited == 4)
        #expect(materialized.count == 4, "three top-level groups and the first leaf; the second group's leaf is never fetched")
    }

    @Test func givesUpWhenTheDeadlinePassesMidSearch() {
        let page = Tree("content", url: "https://example.com/")
        let window = Tree("window", [Tree("toolbar", [Tree("back"), Tree("forward")]), page])
        let found = pageNode(below: window, maxDepth: 3, maxNodes: 64, giveUp: expiring(after: 2))
        #expect(found.node == nil)
        #expect(found.visited < 3)
    }
}
