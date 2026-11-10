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
    var cancelled = false
    var duringPause: (ScriptedApp) -> Void = { _ in }
    var duringFrontmost: (ScriptedApp) -> Void = { _ in }

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
            frontmost: {
                self.duringFrontmost(self)
                return true
            },
            cancelled: { self.cancelled },
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

    @Test func aFieldThatAppearsWhereNoURLWasSeenGivesNoBaseline() {
        let app = TargetFocus<String>(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "Inbox (3)")
        let field = TargetFocus(anchor: .element("composer-a"), window: "window-a", title: "Inbox (3)")
        let scripted = ScriptedApp([.focused(app), .focused(field)])
        let snapshot = scripted.takeSnapshot()
        #expect(snapshot.focus == .unavailable(.readsDisagree))
        #expect(snapshot.attempt == 1)
        #expect(scripted.pauses == 0)
    }

    @Test func aFirstReadThatTimesOutIsNotRetried() {
        let app = ScriptedApp([.noAnswer, .focused(otherComposer), .focused(otherComposer)])
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .unavailable(.noAnswer))
        #expect(snapshot.attempt == 1)
        #expect(app.reads == 1)
        #expect(app.pauses == 0)
    }

    @Test func aFieldFocusedAfterAnEmptyFirstReadIsNotRetried() {
        let app = ScriptedApp([.nothingFocused, .focused(otherComposer), .focused(otherComposer), .focused(otherComposer)])
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .unavailable(.readsDisagree))
        #expect(snapshot.attempt == 1)
        #expect(app.reads == 2)
        #expect(app.pauses == 0)
    }

    @Test func aWindowOnlyFirstReadWithNoURLIsNotRetried() {
        let window = TargetFocus<String>(anchor: .windowOnly(pageURL: nil), window: "window-a", title: "Page B")
        let app = ScriptedApp([.focused(window), .noAnswer, .focused(window), .focused(window)])
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .unavailable(.noAnswer))
        #expect(snapshot.attempt == 1)
        #expect(app.reads == 2)
        #expect(app.pauses == 0)
    }

    @Test func aPressWhileWaitingForTheFrontmostAppGivesNoBaseline() {
        let app = ScriptedApp([.focused(composer), .focused(composer)])
        app.duringFrontmost = { $0.pressed = true }
        #expect(app.takeSnapshot().focus == .unavailable(.inputMoved))
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

    @Test func aSessionCancelledWhileWaitingToRetryStopsReading() {
        let app = ScriptedApp([.focused(composer), .noAnswer, .focused(composer), .focused(composer)])
        app.duringPause = { $0.cancelled = true }
        let snapshot = app.takeSnapshot()
        #expect(snapshot.focus == .unavailable(.cancelled))
        #expect(app.reads == 2)
    }

    @Test func aSessionCancelledBeforeTheFirstReadReadsNothing() {
        let app = ScriptedApp([.focused(composer), .focused(composer)])
        app.cancelled = true
        #expect(app.takeSnapshot().focus == .unavailable(.cancelled))
        #expect(app.reads == 0)
    }
}
