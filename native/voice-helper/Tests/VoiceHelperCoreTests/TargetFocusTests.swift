import Testing
@testable import VoiceHelperCore

private let composer = TargetFocus(element: "composer-a", window: "window-a", title: "Conversation A")

@Suite struct TargetFocusTests {
    @Test func unchangedFocusAllowsInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.focused(composer)) == .unchanged)
    }

    @Test func anotherElementRefusesInsertion() {
        let now = TargetFocus(element: "composer-b", window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now)) == .changed)
    }

    @Test func reusedComposerWithChangedTitleRefusesInsertion() {
        let now = TargetFocus(element: "composer-a", window: "window-a", title: "Conversation B")
        #expect(CapturedFocus.captured(composer).validate(.focused(now)) == .changed)
    }

    @Test func anotherWindowRefusesInsertion() {
        let now = TargetFocus(element: "composer-a", window: "window-b", title: "Conversation A")
        #expect(CapturedFocus.captured(composer).validate(.focused(now)) == .changed)
    }

    @Test func windowOnlyIdentityAllowsUnchangedFocus() {
        let focus = TargetFocus<String>(element: nil, window: "window-a", title: "Conversation A")
        #expect(CapturedFocus.captured(focus).validate(.focused(focus)) == .unchanged)
        #expect(CapturedFocus.captured(focus).validate(.focused(composer)) == .changed)
    }

    @Test func disappearedFocusRefusesInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.nothingFocused) == .changed)
    }

    @Test func busyTargetCannotAuthorizeAutomaticInsertion() {
        #expect(CapturedFocus.captured(composer).validate(.noAnswer) == .unverifiable)
    }

    @Test func pendingOrMissingBaselineCannotAuthorizeAutomaticInsertion() {
        for baseline in [CapturedFocus<String>.pending, .unavailable] {
            #expect(baseline.validate(.focused(composer)) == .unverifiable)
        }
    }

    @Test func inputBeforeAsyncBaselineInvalidatesEvenMatchingSnapshots() {
        var baseline = CapturedFocus<String>.pending
        baseline.resolve(first: .focused(composer), second: .focused(composer), inputUnchanged: false)
        #expect(baseline.validate(.focused(composer)) == .unverifiable)
    }

    @Test func focusSwitchDuringBaselineInvalidatesCapture() {
        var baseline = CapturedFocus<String>.pending
        let another = TargetFocus(element: "composer-b", window: "window-b", title: "Conversation B")
        baseline.resolve(first: .focused(composer), second: .focused(another), inputUnchanged: true)
        #expect(baseline.validate(.focused(another)) == .unverifiable)
    }

    @Test func captureTimeoutOrMissingFocusInvalidatesCapture() {
        for failed in [FocusReread<String>.noAnswer, .nothingFocused] {
            var baseline = CapturedFocus<String>.pending
            baseline.resolve(first: failed, second: failed, inputUnchanged: true)
            #expect(baseline.validate(.focused(composer)) == .unverifiable)
        }
    }

    @Test func stableBaselineWithNoInterveningInputAllowsInsertion() {
        var baseline = CapturedFocus<String>.pending
        baseline.resolve(first: .focused(composer), second: .focused(composer), inputUnchanged: true)
        #expect(baseline.validate(.focused(composer)) == .unchanged)
    }
}
