import Testing
@testable import VoiceHelperCore

private let composer = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Conversation A")
private let otherComposer = TargetFocus(anchor: .element("composer-b"), window: "window-a", title: "Conversation A")

/// A target app that answers each focus read from a script and counts what the snapshot asked.
private final class ScriptedApp {
    private var answers: [FocusReread<String>]
    private let pageURL: String?
    private(set) var reads = 0
    private(set) var pauses = 0
    var pressed = false
    var duringPause: (ScriptedApp) -> Void = { _ in }

    init(_ answers: [FocusReread<String>], pageURL: String? = nil) {
        self.answers = answers
        self.pageURL = pageURL
    }

    func takeSnapshot() -> (focus: CapturedFocus<String>, attempt: Int) {
        FocusSnapshot<String>(
            read: {
                self.reads += 1
                guard !self.answers.isEmpty else {
                    Issue.record("read \(self.reads) is past the script")
                    return .noAnswer
                }
                return self.answers.removeFirst()
            },
            inputUnchanged: { !self.pressed },
            frontmost: { true },
            pageURL: { _ in self.pageURL },
            pause: {
                self.pauses += 1
                self.duringPause(self)
            }
        ).take()
    }
}

@Suite struct FocusSnapshotTests {
    @Test func twoAgreeingReadsAreCapturedWithoutARetry() {
        let app = ScriptedApp([.focused(composer), .focused(composer)])
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .captured(composer))
        #expect(snapshot.attempt == 1)
        #expect(app.pauses == 0)
    }

    @Test func aTargetThatStopsAnsweringIsCapturedOnTheRetry() {
        let app = ScriptedApp([.focused(composer), .noAnswer, .focused(composer), .focused(composer)])
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .captured(composer))
        #expect(snapshot.attempt == 2)
        #expect(app.pauses == 1)
    }

    @Test func aFieldThatAppearsOnTheSamePageIsCapturedOnTheRetry() {
        let url = "https://mail.example/#inbox"
        let page = TargetFocus<String>(anchor: .windowOnly(pageURL: url), window: "window-a", title: "Inbox (3)")
        let field = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Inbox (3)")
        let app = ScriptedApp([.focused(page), .focused(field), .focused(field), .focused(field)], pageURL: url)
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .captured(field))
        #expect(snapshot.attempt == 2)
    }

    @Test func aRetryThatFindsAnotherFieldGivesNoBaselineAndStopsReading() {
        let app = ScriptedApp([
            .focused(composer), .noAnswer, .focused(otherComposer), .focused(otherComposer), .focused(composer), .focused(composer),
        ])
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .unavailable(.focusMoved))
        #expect(snapshot.attempt == 2)
        #expect(app.reads == 4)
    }

    @Test func aTargetThatKeepsTimingOutGivesUpAfterThreeAttempts() {
        let app = ScriptedApp(Array(repeating: [.focused(composer), .noAnswer], count: 4).flatMap { $0 })
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .unavailable(.noAnswer))
        #expect(snapshot.attempt == 3)
        #expect(app.reads == 6)
        #expect(app.pauses == 2)
    }

    @Test func aPressWhileWaitingToRetryGivesNoBaseline() {
        let app = ScriptedApp([.focused(composer), .noAnswer, .focused(composer), .focused(composer)])
        app.duringPause = { $0.pressed = true }
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .unavailable(.inputMoved))
        #expect(snapshot.attempt == 2)
        #expect(app.reads == 2)
    }
}
