import Testing
@testable import VoiceHelperCore

private let composer = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Conversation A")

/// The page URL search costs the insert up to 100 ms on main, so only the tests about an
/// accessibility switch supply one.
private extension CapturedFocus where Element == String {
    func validate(_ current: FocusReread<String>, comparingTitle: Bool) -> FocusValidation {
        validate(current, comparingTitle: comparingTitle, pageURL: { _ in
            Issue.record("the page URL was read")
            return nil
        })
    }
}

@Suite struct TargetFocusTests {
    @Test func unchangedFocusAllowsInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.focused(composer), comparingTitle: true) == .unchanged)
    }

    @Test func anotherElementRefusesInsertion() {
        let now = TargetFocus(anchor: .element("composer-b"), window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed(.element))
    }

    @Test func reusedComposerWithChangedTitleRefusesInsertion() {
        let now = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Conversation B")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed(.title))
    }

    @Test func uncomparedTitleSurvivesATickButNotAnotherElementOrWindow() {
        let unreadCount = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "(1) Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(unreadCount), comparingTitle: false) == .unchanged)
        let windowOnly = TargetFocus(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "Conversation A")
        let windowOnlyTicked = TargetFocus(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "(1) Conversation A")
        #expect(CapturedFocus.captured(windowOnly).validate(.focused(windowOnlyTicked), comparingTitle: false) == .unchanged)
        let otherComposer = TargetFocus(anchor: .element("composer-b"), window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(otherComposer), comparingTitle: false) == .changed(.element))
        let otherWindow = TargetFocus(anchor: .element("composer-a"), window: "window-b", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(otherWindow), comparingTitle: false) == .changed(.window))
    }

    @Test func pageURLChangeRefusesInsertionWithoutAPress() {
        let page = TargetFocus(anchor: .windowOnly(pageURL: "https://mail.example/#inbox/abc"), window: "window-a", title: "Inbox (3)")
        for moved in ["https://mail.example/#inbox", "https://other.example/", nil] {
            let now = TargetFocus(anchor: .windowOnly(pageURL: moved), window: "window-a", title: "Inbox (3)")
            #expect(CapturedFocus.captured(page).validate(.focused(now), comparingTitle: false) == .changed(.pageURL))
            #expect(CapturedFocus.captured(now).validate(.focused(page), comparingTitle: false) == .changed(.pageURL))
        }
    }

    @Test func sameURLSurvivesATitleTickButNotATitleChangeAfterAPress() {
        let page = TargetFocus(anchor: .windowOnly(pageURL: "https://mail.example/#inbox"), window: "window-a", title: "Inbox (3)")
        let ticked = TargetFocus(anchor: .windowOnly(pageURL: "https://mail.example/#inbox"), window: "window-a", title: "Inbox (4)")
        #expect(CapturedFocus.captured(page).validate(.focused(ticked), comparingTitle: false) == .unchanged)
        #expect(CapturedFocus.captured(page).validate(.focused(ticked), comparingTitle: true) == .changed(.title))
        #expect(CapturedFocus.captured(page).validate(.focused(page), comparingTitle: true) == .unchanged)
    }

    @Test func anotherWindowRefusesInsertion() {
        let now = TargetFocus(anchor: .element("composer-a"), window: "window-b", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed(.window))
    }

    @Test func windowOnlyIdentityAllowsUnchangedFocus() {
        let focus = TargetFocus(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(focus).validate(.focused(focus), comparingTitle: true) == .unchanged)
    }

    @Test func accessibilitySwitchingOnMidSessionKeepsAWindowOnlyTarget() {
        let now = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Inbox (4)")
        let pages = ["window-a": "https://mail.example/#inbox"]
        let page = TargetFocus<String>(anchor: .windowOnly(pageURL: pages["window-a"]), window: "window-a", title: "Inbox (3)")
        #expect(CapturedFocus.captured(page).validate(.focused(now), comparingTitle: false, pageURL: { pages[$0] }) == .unchanged)
        // Electron shows no page URL until the switch, and one appearing after it is not a navigation.
        let app = TargetFocus<String>(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "Inbox (3)")
        #expect(CapturedFocus.captured(app).validate(.focused(now), comparingTitle: false) == .unchanged)
    }

    @Test func accessibilitySwitchingOnStillRefusesAnotherPageWindowOrTitle() {
        let url = "https://mail.example/#inbox"
        let page = CapturedFocus.captured(TargetFocus<String>(anchor: .windowOnly(pageURL: url), window: "window-a", title: "Inbox (3)"))
        let now = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Inbox (3)")
        for moved in ["https://mail.example/#sent", nil] {
            #expect(page.validate(.focused(now), comparingTitle: true, pageURL: { _ in moved }) == .changed(.pageURL))
        }
        let otherWindow = TargetFocus(anchor: .element("composer-a"), window: "window-b", title: "Inbox (3)")
        #expect(page.validate(.focused(otherWindow), comparingTitle: false) == .changed(.window))
        let retitled = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Sent")
        #expect(page.validate(.focused(retitled), comparingTitle: true) == .changed(.title))
    }

    @Test func accessibilitySwitchingOffMidSessionRefusesInsertion() {
        let now = TargetFocus<String>(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed(.anchorKind))
    }

    @Test func disappearedFocusRefusesInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.nothingFocused, comparingTitle: true) == .changed(.nothingFocused))
    }

    @Test func busyTargetCannotAuthorizeAutomaticInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.noAnswer, comparingTitle: true) == .unverifiable)
    }

    @Test func pendingOrMissingBaselineCannotAuthorizeAutomaticInsertion() {
        for baseline in [CapturedFocus<String>.pending, .unavailable(.noAnswer)] {
            #expect(baseline.validate(.focused(composer), comparingTitle: true) == .unverifiable)
        }
    }

    @Test func baselineThatCannotBeTrustedNamesWhy() {
        let another = TargetFocus(anchor: .element("composer-b"), window: "window-b", title: "Conversation B")
        let cases: [(first: FocusReread<String>, second: FocusReread<String>, inputUnchanged: Bool, frontmost: Bool, loss: FocusLoss)] = [
            (.focused(composer), .focused(composer), false, true, .inputMoved),
            (.noAnswer, .noAnswer, false, false, .inputMoved),
            (.focused(composer), .focused(composer), true, false, .notFrontmost),
            (.noAnswer, .noAnswer, true, false, .notFrontmost),
            (.noAnswer, .noAnswer, true, true, .noAnswer),
            (.focused(composer), .noAnswer, true, true, .noAnswer),
            (.nothingFocused, .nothingFocused, true, true, .nothingFocused),
            (.focused(composer), .focused(another), true, true, .readsDisagree),
            (.nothingFocused, .focused(composer), true, true, .readsDisagree),
        ]
        for (first, second, inputUnchanged, frontmost, loss) in cases {
            var baseline = CapturedFocus<String>.pending
            baseline.resolve(first: first, second: second, inputUnchanged: inputUnchanged, frontmost: frontmost)
            #expect(baseline == .unavailable(loss))
            #expect(baseline.validate(.focused(composer), comparingTitle: true) == .unverifiable)
        }
    }

    @Test func onlyABusyAppOrDisagreeingReadsAreWorthReadingAgain() {
        for loss in [FocusLoss.noAnswer, .readsDisagree] {
            #expect(loss.isTransient)
        }
        for loss in [FocusLoss.noApp, .untrusted, .inputMoved, .notFrontmost, .nothingFocused] {
            #expect(!loss.isTransient)
        }
    }

    @Test func stableBaselineWithNoInterveningInputAllowsInsertion() {
        var baseline = CapturedFocus<String>.pending
        baseline.resolve(first: .focused(composer), second: .focused(composer), inputUnchanged: true, frontmost: true)
        #expect(baseline.validate(.focused(composer), comparingTitle: true) == .unchanged)
    }
}
