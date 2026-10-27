import Testing
@testable import VoiceHelperCore

private let composer = TargetFocus(element: "composer-a", window: "window-a", title: "Conversation A")

@Suite struct TargetFocusTests {
    @Test func unchangedFocusAllowsInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.focused(composer), comparingTitle: true) == .unchanged)
    }

    @Test func anotherElementRefusesInsertion() {
        let now = TargetFocus(element: "composer-b", window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed)
    }

    @Test func reusedComposerWithChangedTitleRefusesInsertion() {
        let now = TargetFocus(element: "composer-a", window: "window-a", title: "Conversation B")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed)
    }

    @Test func uncomparedTitleSurvivesATickButNotAnotherElementOrWindow() {
        let unreadCount = TargetFocus(element: "composer-a", window: "window-a", title: "(1) Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(unreadCount), comparingTitle: false) == .unchanged)
        let windowOnly = TargetFocus<String>(element: nil, window: "window-a", title: "Conversation A")
        let windowOnlyTicked = TargetFocus<String>(element: nil, window: "window-a", title: "(1) Conversation A")
        #expect(CapturedFocus.captured(windowOnly).validate(.focused(windowOnlyTicked), comparingTitle: false) == .unchanged)
        let otherComposer = TargetFocus(element: "composer-b", window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(otherComposer), comparingTitle: false) == .changed)
        let otherWindow = TargetFocus(element: "composer-a", window: "window-b", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(otherWindow), comparingTitle: false) == .changed)
    }

    @Test func anotherWindowRefusesInsertion() {
        let now = TargetFocus(element: "composer-a", window: "window-b", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now), comparingTitle: true) == .changed)
    }

    @Test func windowOnlyIdentityAllowsUnchangedFocus() {
        let focus = TargetFocus<String>(element: nil, window: "window-a", title: "Conversation A")
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
        let another = TargetFocus(element: "composer-b", window: "window-b", title: "Conversation B")
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
