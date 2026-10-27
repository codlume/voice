import Testing
@testable import VoiceHelperCore

private let composer = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Conversation A")

@Suite struct TargetFocusTests {
    @Test func unchangedFocusAllowsInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.focused(composer), comparingTitle: true) == .unchanged)
    }

    @Test func anotherElementRefusesInsertion() {
        let now = TargetFocus(anchor: .element("composer-b"), window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed)
    }

    @Test func reusedComposerWithChangedTitleRefusesInsertion() {
        let now = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Conversation B")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed)
    }

    @Test func uncomparedTitleSurvivesATickButNotAnotherElementOrWindow() {
        let unreadCount = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "(1) Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(unreadCount), comparingTitle: false) == .unchanged)
        let windowOnly = TargetFocus(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "Conversation A")
        let windowOnlyTicked = TargetFocus(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "(1) Conversation A")
        #expect(CapturedFocus.captured(windowOnly).validate(.focused(windowOnlyTicked), comparingTitle: false) == .unchanged)
        let otherComposer = TargetFocus(anchor: .element("composer-b"), window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(otherComposer), comparingTitle: false) == .changed)
        let otherWindow = TargetFocus(anchor: .element("composer-a"), window: "window-b", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(otherWindow), comparingTitle: false) == .changed)
    }

    @Test func pageURLChangeRefusesInsertionWithoutAPress() {
        let page = TargetFocus(anchor: .windowOnly(pageURL: "https://mail.example/#inbox/abc"), window: "window-a", title: "Inbox (3)")
        for moved in ["https://mail.example/#inbox", "https://other.example/", nil] {
            let now = TargetFocus(anchor: .windowOnly(pageURL: moved), window: "window-a", title: "Inbox (3)")
            #expect(CapturedFocus.captured(page).validate(.focused(now), comparingTitle: false) == .changed)
            #expect(CapturedFocus.captured(now).validate(.focused(page), comparingTitle: false) == .changed)
        }
    }

    @Test func sameURLSurvivesATitleTickButNotATitleChangeAfterAPress() {
        let page = TargetFocus(anchor: .windowOnly(pageURL: "https://mail.example/#inbox"), window: "window-a", title: "Inbox (3)")
        let ticked = TargetFocus(anchor: .windowOnly(pageURL: "https://mail.example/#inbox"), window: "window-a", title: "Inbox (4)")
        #expect(CapturedFocus.captured(page).validate(.focused(ticked), comparingTitle: false) == .unchanged)
        #expect(CapturedFocus.captured(page).validate(.focused(ticked), comparingTitle: true) == .changed)
        #expect(CapturedFocus.captured(page).validate(.focused(page), comparingTitle: true) == .unchanged)
    }

    @Test func anotherWindowRefusesInsertion() {
        let now = TargetFocus(anchor: .element("composer-a"), window: "window-b", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed)
    }

    @Test func windowOnlyIdentityAllowsUnchangedFocus() {
        let focus = TargetFocus(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(focus).validate(.focused(focus), comparingTitle: true) == .unchanged)
        #expect(CapturedFocus.captured(focus).validate(.focused(composer), comparingTitle: true) == .changed)
    }

    @Test func disappearedFocusRefusesInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.nothingFocused, comparingTitle: true) == .changed)
    }

    @Test func busyTargetCannotAuthorizeAutomaticInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.noAnswer, comparingTitle: true) == .unverifiable)
    }

    @Test func pendingOrMissingBaselineCannotAuthorizeAutomaticInsertion() {
        for baseline in [CapturedFocus<String>.pending, .unavailable] {
            #expect(baseline.validate(.focused(composer), comparingTitle: true) == .unverifiable)
        }
    }

    @Test func inputBeforeAsyncBaselineInvalidatesEvenMatchingSnapshots() {
        var baseline = CapturedFocus<String>.pending
        baseline.resolve(first: .focused(composer), second: .focused(composer), inputUnchanged: false)
        #expect(baseline.validate(.focused(composer), comparingTitle: true) == .unverifiable)
    }

    @Test func focusSwitchDuringBaselineInvalidatesCapture() {
        var baseline = CapturedFocus<String>.pending
        let another = TargetFocus(anchor: .element("composer-b"), window: "window-b", title: "Conversation B")
        baseline.resolve(first: .focused(composer), second: .focused(another), inputUnchanged: true)
        #expect(baseline.validate(.focused(another), comparingTitle: true) == .unverifiable)
    }

    @Test func captureTimeoutOrMissingFocusInvalidatesCapture() {
        for failed in [FocusReread<String>.noAnswer, .nothingFocused] {
            var baseline = CapturedFocus<String>.pending
            baseline.resolve(first: failed, second: failed, inputUnchanged: true)
            #expect(baseline.validate(.focused(composer), comparingTitle: true) == .unverifiable)
        }
    }

    @Test func stableBaselineWithNoInterveningInputAllowsInsertion() {
        var baseline = CapturedFocus<String>.pending
        baseline.resolve(first: .focused(composer), second: .focused(composer), inputUnchanged: true)
        #expect(baseline.validate(.focused(composer), comparingTitle: true) == .unchanged)
    }
}
