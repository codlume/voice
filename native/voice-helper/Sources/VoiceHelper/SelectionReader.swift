import AppKit
import ApplicationServices
import Carbon
import Foundation
import VoiceHelperCore
import os

/// Reads the focused app's selection for a transform run and shelves where to write the result.
/// Owned by the main actor. Every wait is a 10 ms sleep, never a blocking wait, so the helper
/// keeps answering commands and `transform.end` can cancel the run at any tick.
final class SelectionReader {
    private let output: Output
    private let insertion: Insertion
    private let pasteboard: Pasteboard
    private let firedKey: OSAllocatedUnfairLock<Int64?>
    /// Test mode only: timings the smoke script reports. Never the text.
    private let log: ((String) -> Void)?
    private let activeFlag = OSAllocatedUnfairLock(initialState: false)
    private var run: (id: String, task: Task<Void, Never>)?
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
        run?.task.cancel()
        activeFlag.withLock { $0 = true }
        run = (id, Task { @MainActor [self] in
            // A cancelled run throws out of its next wait and emits nothing.
            guard let result = try? await perform(id: id) else { return }
            output.emit(.selectionResult(id: id, result: result))
        })
    }

    /// Idempotent. Drops the shelf for `id`; if `id` is the live run, ends it. A copy already
    /// posted still restores the clipboard when the app answers.
    func end(id: String) {
        shelf.clear(id: id)
        guard let run, run.id == id else { return }
        run.task.cancel()
        self.run = nil
        activeFlag.withLock { $0 = false }
    }

    func take(id: String) -> InsertTarget? {
        shelf.take(id: id)
    }

    @MainActor
    private func perform(id: String) async throws -> SelectionResult {
        guard AXIsProcessTrusted() else { return .failed(.failed) }
        guard !IsSecureEventInputEnabled() else { return .failed(.secureInput) }
        // Voice's own windows never take a transform; the hub disarms the shortcuts, and this
        // covers a press that raced the disarm.
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getppid() else {
            return .failed(.noFocusedField)
        }
        guard try await keysReleased() else { return .failed(.keysHeld) }
        // The target record is made only once the keys are up: its focus reading is dropped
        // when a key press lands during it, and repeats of the held shortcut key count.
        let target = insertion.recordTarget(pid: app.processIdentifier, bundleId: app.bundleIdentifier, host: .read(nil), log: nil)
        guard let focus = try await settledFocus(of: target) else { return .failed(.failed) }
        let element = focus.element?.value
        let answer = await Task.detached(priority: .userInitiated) { readAXSelection(element) }.value
        try Task.checkCancellation()
        switch planRead(secureInput: IsSecureEventInputEnabled(), answer: answer) {
        case .fail(let reason):
            return .failed(reason)
        case .selected(let text, let origin):
            target.origin = origin
            shelf.put(id: id, target)
            return .selected(text: text, via: .accessibility)
        case .copyFallback:
            return try await copySelection(id: id, into: target)
        }
    }

    @MainActor
    private func copySelection(id: String, into target: InsertTarget) async throws -> SelectionResult {
        let postedAt = DispatchTime.now()
        let outcome = await pasteboard.copyFromFocusedApp()
        let ms = Int(elapsed(since: postedAt) * 1000)
        if case .nothing = outcome {
            log?("selection copy unanswered after \(ms) ms")
        } else {
            log?("selection copy answered after \(ms) ms")
        }
        try Task.checkCancellation()
        switch outcome {
        case .nothing:
            return .failed(.noSelection)
        case .concealed:
            return .failed(.secureInput)
        case .text(let text):
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .failed(.noSelection) }
            target.origin = .copy(inputStamp: focusInputStamp())
            shelf.put(id: id, target)
            return .selected(text: text, via: .copy)
        }
    }

    /// False at `ReleaseWait.deadline`, while the shortcut's key or a modifier is still down.
    private func keysReleased() async throws -> Bool {
        let startedAt = DispatchTime.now()
        while true {
            let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
            let keyDown = firedKey.withLock { $0 }.map { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) } ?? false
            switch ReleaseWait.step(flags: flags, keyDown: keyDown, elapsed: elapsed(since: startedAt)) {
            case .proceed:
                log?("selection keys released after \(Int(elapsed(since: startedAt) * 1000)) ms")
                return true
            case .giveUp:
                return false
            case .wait:
                try await Task.sleep(for: .milliseconds(10))
            }
        }
    }

    /// Nil when the focus reading was dropped or the app did not answer by `focusDeadline`.
    private func settledFocus(of target: InsertTarget) async throws -> TargetFocus<FocusElement>? {
        let startedAt = DispatchTime.now()
        while true {
            switch target.focus {
            case .captured(let focus): return focus
            case .unavailable: return nil
            case .pending:
                guard elapsed(since: startedAt) < focusDeadline else { return nil }
                try await Task.sleep(for: .milliseconds(10))
            }
        }
    }
}

/// recordTarget makes two AX reads with `axMessagingTimeout` each; past this the app is hung.
private let focusDeadline: TimeInterval = 2
