import AppKit
import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

// AppKit also brings in Carbon's `Pasteboard`.
private typealias Pasteboard = VoiceHelper.Pasteboard

/// A `Pasteboard` over a scratch board of its own. The user's clipboard is never read or
/// written, and the synthetic Cmd+C is a callback, so no keystroke is posted.
@MainActor
private final class ScratchClipboard {
    let board = NSPasteboard.withUniqueName()
    private(set) var pasteboard: Pasteboard!
    var onCopyPosted: () -> Void = {}
    /// Runs once, when a copy wait gives up. The helper reads the press counters at that
    /// moment and not before, so the first read marks it without a timer.
    var onCopyDeadline: () -> Void = {}
    private var closed = false

    init() {
        pasteboard = Pasteboard(
            output: Output(fd: open("/dev/null", O_WRONLY)), board: board,
            postCopy: { [unowned self] in onCopyPosted() },
            pressStamp: { [unowned self] in
                let reached = onCopyDeadline
                onCopyDeadline = {}
                reached()
                return PressStamp(counts: [])
            })
    }

    var text: String? { board.string(forType: .string) }

    /// A write by anyone but the helper: the user's own copy, or the target answering Cmd+C.
    func holds(_ text: String) {
        guard !closed else { return }
        board.clearContents()
        board.setString(text, forType: .string)
    }

    /// What `Insertion` does around its Cmd+V, without the keystroke.
    func paste(_ text: String, keepOnClipboard: Bool = false) -> Int {
        pasteboard.write(text: text, html: nil, saved: keepOnClipboard ? nil : pasteboard.save())
    }

    func close() {
        closed = true
        board.releaseGlobally()
    }
}

@Suite @MainActor struct PasteboardTests {
    @Test func aHelperExitingRightAfterAPasteLeavesTheTranscriptUntilItsRestoreIsDue() async {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")
        let pasted = DispatchTime.now()
        _ = clipboard.paste("transcript")

        let atExit = await withCheckedContinuation { exited in
            clipboard.pasteboard.settle { exited.resume(returning: clipboard.text) }
            #expect(clipboard.text == "transcript", "a slow target has not read the paste yet")
        }

        #expect(atExit == "user")
        #expect(elapsed(since: pasted) >= Pasteboard.pasteRestoreDelay)
    }

    @Test func aHelperExitingWithNothingPendingLeavesAtOnce() {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")
        _ = clipboard.paste("kept transcript", keepOnClipboard: true)

        var exited = false
        clipboard.pasteboard.settle { exited = true }

        #expect(exited)
        #expect(clipboard.text == "kept transcript")
    }

    @Test func aCopyAnsweredAfterItsDeadlineIsRestoredBeforeTheHelperExits() async {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")

        let atExit = await withCheckedContinuation { exited in
            clipboard.onCopyDeadline = {
                DispatchQueue.main.async {
                    clipboard.holds("selection")
                    clipboard.pasteboard.settle { exited.resume(returning: clipboard.text) }
                }
            }
            Task { await clipboard.pasteboard.copyFromFocusedApp() }
        }

        #expect(atExit == "user")
    }

    @Test func aHelperExitingWithACopyUnansweredStaysForItsLateAnswer() async {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")
        clipboard.onCopyDeadline = {
            DispatchQueue.main.async { clipboard.holds("selection") }
        }

        var posted = DispatchTime.now()
        let atExit = await withCheckedContinuation { exited in
            clipboard.onCopyPosted = {
                posted = .now()
                DispatchQueue.main.async {
                    clipboard.pasteboard.settle { exited.resume(returning: clipboard.text) }
                }
            }
            Task { await clipboard.pasteboard.copyFromFocusedApp() }
        }

        #expect(elapsed(since: posted) >= CopyWait.lateCheck, "the helper left while the target could still answer the copy")
        #expect(atExit == "user")
    }

    @Test func aCopyIsNotPostedOnceTheHelperIsExiting() async {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")
        var posted = false
        clipboard.onCopyPosted = { posted = true }
        clipboard.pasteboard.settle {}

        let outcome = await clipboard.pasteboard.copyFromFocusedApp()
        #expect(outcome == .nothing)
        #expect(posted == false)
    }

    @Test func aPasteRestoreThatFiresDuringACopyWaitIsNotReadAsTheSelection() async {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")
        let write = clipboard.paste("transcript")
        clipboard.onCopyPosted = {
            DispatchQueue.main.async { clipboard.pasteboard.restore(write: write) }
        }

        let outcome = await clipboard.pasteboard.copyFromFocusedApp()
        #expect(outcome == .nothing)
        #expect(clipboard.text == "user")
    }

    @Test func aPasteWrittenDuringACopyWaitIsNotReadAsTheSelection() async {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")
        clipboard.onCopyPosted = {
            DispatchQueue.main.async { _ = clipboard.paste("transcript") }
        }

        let outcome = await clipboard.pasteboard.copyFromFocusedApp()
        #expect(outcome == .nothing)
    }

    @Test func aKeptTranscriptOutlivesEveryPasteThatRestoresIt() {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")
        _ = clipboard.paste("kept transcript", keepOnClipboard: true)

        for rewrite in ["first rewrite", "second rewrite"] {
            clipboard.pasteboard.restore(write: clipboard.paste(rewrite))
        }

        #expect(clipboard.text == "kept transcript")
        #expect(clipboard.board.types?.contains(NSPasteboard.PasteboardType(concealedPasteboardType)) == true)
    }

    @Test func theCopyKeystrokeIsPostedFromTheMainThread() async {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        clipboard.holds("user")
        var postedOnMain: Bool?
        clipboard.onCopyPosted = {
            postedOnMain = Thread.isMainThread
            clipboard.holds("selection")
        }

        let outcome = await clipboard.pasteboard.copyFromFocusedApp()
        #expect(outcome == .text("selection"))
        #expect(postedOnMain == true)
        #expect(clipboard.text == "user")
    }

    /// Both waits read state that main writes: the target's focus, and the held shortcut key.
    @Test func theSelectionReadersWaitsAreIsolatedToTheMainActor() {
        let clipboard = ScratchClipboard()
        defer { clipboard.close() }
        let output = Output(fd: open("/dev/null", O_WRONLY))
        let reader = SelectionReader(
            output: output, insertion: Insertion(output: output, forcePaste: false, pasteboard: clipboard.pasteboard),
            pasteboard: clipboard.pasteboard, heldShortcutKey: .init(initialState: nil), log: nil)

        let keysReleased: @isolated(any) () async throws -> Bool = reader.keysReleased
        let settledFocus: @isolated(any) (InsertTarget) async throws -> TargetFocus<FocusElement>? = reader.settledFocus(of:)

        #expect(keysReleased.isolation === MainActor.shared)
        #expect(settledFocus.isolation === MainActor.shared)
    }
}
