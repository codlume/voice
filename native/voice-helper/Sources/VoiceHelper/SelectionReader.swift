import AppKit
import ApplicationServices
import Carbon
import Foundation
import VoiceHelperCore
import os

/// Reads the focused app's selection for a transform run and shelves where to write the result.
/// Owned by the main thread. Every wait is a 10 ms timer hop, never a blocking wait, so the
/// helper keeps answering commands and `transform.end` can cancel the run at any tick.
final class SelectionReader {
    private final class Run {
        let id: String
        var cancelled = false
        init(id: String) { self.id = id }
    }

    private let output: Output
    private let insertion: Insertion
    private let pasteboard: Pasteboard
    private let firedKey: OSAllocatedUnfairLock<Int64?>
    /// Test mode only: timings the smoke script reports. Never the text.
    private let log: ((String) -> Void)?
    private let activeFlag = OSAllocatedUnfairLock(initialState: false)
    private var run: Run?
    private var shelf = SelectionShelf<InsertTarget>()

    init(output: Output, insertion: Insertion, pasteboard: Pasteboard, firedKey: OSAllocatedUnfairLock<Int64?>, log: ((String) -> Void)?) {
        self.output = output
        self.insertion = insertion
        self.pasteboard = pasteboard
        self.firedKey = firedKey
        self.log = log
    }

    /// Read on the tap thread: while true, Escape is consumed and reported as `cancel`.
    var isActive: Bool { activeFlag.withLock { $0 } }

    /// Emits one `selection.result` for `id` unless `end` arrives first.
    func read(id: String) {
        self.run?.cancelled = true
        let run = Run(id: id)
        self.run = run
        activeFlag.withLock { $0 = true }
        guard AXIsProcessTrusted() else { return finish(run, .failed(.failed)) }
        guard !IsSecureEventInputEnabled() else { return finish(run, .failed(.secureInput)) }
        // Voice's own windows never take a transform; the hub disarms the shortcuts, and this
        // covers a press that raced the disarm.
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getppid() else {
            return finish(run, .failed(.noFocusedField))
        }
        awaitRelease(run) { [self] in
            // The target record is made only once the keys are up: its focus reading is dropped
            // when a key press lands during it, and repeats of the held shortcut key count.
            let target = insertion.recordTarget(pid: app.processIdentifier, bundleId: app.bundleIdentifier, host: .read(nil), log: nil)
            awaitFocus(run, of: target) { [self] focus in
                readSelection(run, target: target, element: focus.element?.value)
            }
        }
    }

    /// Idempotent. Drops the shelf for `id`; if `id` is the live run, ends it. A copy already
    /// posted still restores the clipboard when the app answers.
    func end(id: String) {
        shelf.clear(id: id)
        guard let run, run.id == id else { return }
        run.cancelled = true
        self.run = nil
        activeFlag.withLock { $0 = false }
    }

    func take(id: String) -> InsertTarget? {
        shelf.take(id: id)
    }

    private func finish(_ run: Run, _ result: SelectionResult) {
        guard !run.cancelled else { return }
        output.emit(.selectionResult(id: run.id, result: result))
    }

    private func awaitRelease(_ run: Run, then next: @escaping () -> Void) {
        let startedAt = DispatchTime.now()
        poll { [self] in
            if run.cancelled { return true }
            let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
            let keyDown = firedKey.withLock { $0 }.map { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) } ?? false
            switch ReleaseWait.step(flags: flags, keyDown: keyDown, elapsed: elapsed(since: startedAt)) {
            case .wait: return false
            case .giveUp: finish(run, .failed(.keysHeld))
            case .proceed:
                log?("selection keys released after \(Int(elapsed(since: startedAt) * 1000)) ms")
                next()
            }
            return true
        }
    }

    private func awaitFocus(_ run: Run, of target: InsertTarget, then next: @escaping (TargetFocus<FocusElement>) -> Void) {
        let startedAt = DispatchTime.now()
        poll { [self] in
            if run.cancelled { return true }
            switch target.focus {
            case .pending:
                guard elapsed(since: startedAt) >= focusDeadline else { return false }
                finish(run, .failed(.failed))
            case .unavailable: finish(run, .failed(.failed))
            case .captured(let focus): next(focus)
            }
            return true
        }
    }

    private func readSelection(_ run: Run, target: InsertTarget, element: AXUIElement?) {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let answer = readAXSelection(element)
            DispatchQueue.main.async { [self] in
                guard !run.cancelled else { return }
                switch planRead(secureInput: IsSecureEventInputEnabled(), answer: answer) {
                case .fail(let reason):
                    finish(run, .failed(reason))
                case .selected(let text, let origin):
                    target.origin = origin
                    shelf.put(id: run.id, target)
                    finish(run, .selected(text: text, via: .accessibility))
                case .copyFallback:
                    copy(run, target: target)
                }
            }
        }
    }

    private func copy(_ run: Run, target: InsertTarget) {
        let saved = pasteboard.save()
        let wait = CopyWait(startChangeCount: pasteboard.changeCount)
        postCommandC()
        let postedAt = DispatchTime.now()
        poll { [self] in
            switch wait.step(changeCount: pasteboard.changeCount, elapsed: elapsed(since: postedAt)) {
            case .wait:
                return false
            case .timedOut:
                log?("selection copy unanswered after \(Int(elapsed(since: postedAt) * 1000)) ms")
                finish(run, .failed(.noSelection))
                DispatchQueue.main.asyncAfter(deadline: postedAt + CopyWait.lateCheck) { [self] in
                    guard wait.lateRestoreNeeded(changeCount: pasteboard.changeCount) else { return }
                    pasteboard.restoreLate(saved, write: wait.startChangeCount + 1)
                }
            case .changed:
                log?("selection copy answered after \(Int(elapsed(since: postedAt) * 1000)) ms")
                let write = pasteboard.changeCount
                pasteboard.wrote(write, saved: saved)
                let concealed = pasteboard.holdsConcealed
                let text = pasteboard.string ?? ""
                pasteboard.restore(write: write)
                if concealed {
                    finish(run, .failed(.secureInput))
                } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    finish(run, .failed(.noSelection))
                } else if !run.cancelled {
                    target.origin = .copy(inputStamp: focusInputStamp())
                    shelf.put(id: run.id, target)
                    finish(run, .selected(text: text, via: .copy))
                }
            }
            return true
        }
    }

    private func postCommandC() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let key = currentLayoutData().flatMap { PasteKey.keycode(typing: "c", in: $0) } ?? PasteKey.ansiC
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { continue }
            event.flags = .maskCommand
            event.post(tap: .cghidEventTap)
        }
    }

    /// Runs `step` now and then every 10 ms until it returns true.
    private func poll(_ step: @escaping () -> Bool) {
        if step() { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { [self] in poll(step) }
    }
}

/// recordTarget makes two AX reads with `axMessagingTimeout` each; past this the app is hung.
private let focusDeadline: TimeInterval = 2

private func elapsed(since start: DispatchTime) -> TimeInterval {
    TimeInterval(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
}
