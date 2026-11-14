import Testing
@testable import VoiceHelperCore

private let target: Int32 = 501
private let otherApp: Int32 = 777
private let checked = PressStamp(counts: [10, 4, 0, 0])
private let pressedSince = PressStamp(counts: [11, 4, 0, 0])

private func destination(
    presses: PressStamp = checked, frontmostPid: Int32? = target, secureInput: Bool = false
) -> KeystrokeDestination {
    KeystrokeDestination(presses: presses, frontmostPid: frontmostPid, secureInput: secureInput)
}

/// A paste whose clipboard save takes long enough for `duringSave` to happen.
private func paste(duringSave: (inout KeystrokeDestination) -> Void) -> (attempt: PasteAttempt<Int>, steps: [String]) {
    var now = destination()
    var steps: [String] = []
    let attempt = pasteKeystroke(
        save: {
            steps.append("save")
            duringSave(&now)
            return "user clipboard"
        },
        refusal: { now.refusal(target: target, checked: checked) },
        write: { saved in
            steps.append("write over \(saved)")
            return 8
        },
        post: { steps.append("post") })
    return (attempt, steps)
}

@Suite struct PasteKeystrokeTests {
    @Test func aTargetStillInFrontWithNoPressSinceTheCheckGetsTheKeystroke() {
        #expect(destination().refusal(target: target, checked: checked) == nil)
    }

    @Test func anotherAppInFrontGetsNoKeystroke() {
        #expect(destination(frontmostPid: otherApp).refusal(target: target, checked: checked) == .notFrontmost)
        #expect(destination(frontmostPid: nil).refusal(target: target, checked: checked) == .notFrontmost)
    }

    @Test func aPressSinceTheCheckRefusesWhileTheTargetStillReadsAsFrontmost() {
        #expect(destination(presses: pressedSince).refusal(target: target, checked: checked) == .inputMoved)
    }

    @Test func secureInputTurnedOnSinceTheCheckRefuses() {
        #expect(destination(secureInput: true).refusal(target: target, checked: checked) == .secureInput)
    }

    @Test func aSessionWithNoTargetAppGetsNoKeystroke() {
        #expect(destination(frontmostPid: nil).refusal(target: nil, checked: checked) == .notFrontmost)
    }

    @Test func aMovedTargetReportsFocusChangedAndSecureInputReportsItself() {
        #expect(KeystrokeRefusal.notFrontmost.failure == .focusChanged)
        #expect(KeystrokeRefusal.inputMoved.failure == .focusChanged)
        #expect(KeystrokeRefusal.secureInput.failure == .secureInput)
    }

    @Test func anAppSwitchDuringTheClipboardSaveSendsNoKeystrokeAndLeavesTheClipboardAlone() {
        let (attempt, steps) = paste { $0 = destination(frontmostPid: otherApp) }
        #expect(steps == ["save"])
        #expect(attempt == .refused(.notFrontmost))
    }

    @Test func aPressDuringTheClipboardSaveSendsNoKeystrokeAndLeavesTheClipboardAlone() {
        let (attempt, steps) = paste { $0 = destination(presses: pressedSince) }
        #expect(steps == ["save"])
        #expect(attempt == .refused(.inputMoved))
    }

    @Test func anUnmovedTargetGetsTheSavedClipboardWrittenOverThenOneKeystroke() {
        let (attempt, steps) = paste { _ in }
        #expect(steps == ["save", "write over user clipboard", "post"])
        #expect(attempt == .posted(8))
    }
}
