import AppKit
import ApplicationServices
import Carbon
import Foundation
import VoiceHelperCore
import os

final class SelectionReader {
    private let output: Output
    private let insertion: Insertion
    private let pasteboard: Pasteboard
    private let heldShortcutKey: OSAllocatedUnfairLock<Int64?>
    private let log: ((String) -> Void)?
    private let activeFlag = OSAllocatedUnfairLock(initialState: false)
    private var run: (id: String, task: Task<Void, Never>)?
    private var shelf = SelectionShelf<InsertTarget>()

    init(output: Output, insertion: Insertion, pasteboard: Pasteboard, heldShortcutKey: OSAllocatedUnfairLock<Int64?>, log: ((String) -> Void)?) {
        self.output = output
        self.insertion = insertion
        self.pasteboard = pasteboard
        self.heldShortcutKey = heldShortcutKey
        self.log = log
    }

    var isActive: Bool { activeFlag.withLock { $0 } }

    func read(id: String) {
        run?.task.cancel()
        activeFlag.withLock { $0 = true }
        run = (id, Task { @MainActor [self] in
            guard let result = try? await perform(id: id) else { return }
            output.emit(.selectionResult(id: id, result: result))
        })
    }

    func end(id: String) {
        shelf.clear(id: id)
        guard let run, run.id == id else { return }
        run.task.cancel()
        self.run = nil
        activeFlag.withLock { $0 = false }
        heldShortcutKey.withLock { $0 = nil }
    }

    func take(id: String) -> InsertTarget? {
        shelf.take(id: id)
    }

    @MainActor
    private func perform(id: String) async throws -> SelectionResult {
        guard AXIsProcessTrusted() else { return .failed(.failed) }
        guard !IsSecureEventInputEnabled() else { return .failed(.secureInput) }
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getppid() else {
            return .failed(.noFocusedField)
        }
        guard try await keysReleased() else { return .failed(.keysHeld) }
        let target = insertion.recordTarget(pid: app.processIdentifier, bundleId: app.bundleIdentifier, host: .read(nil), log: nil)
        guard let focus = try await settledFocus(of: target) else { return .failed(.failed) }
        let element = focus.anchor.element?.value
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
        switch outcome {
        case .nothing: log?("selection copy unanswered after \(ms) ms")
        case .lineOfEmptySelection: log?("selection copy answered after \(ms) ms with the caret's line; nothing selected")
        case .text, .concealed: log?("selection copy answered after \(ms) ms")
        }
        try Task.checkCancellation()
        switch outcome {
        case .nothing, .lineOfEmptySelection:
            return .failed(.noSelection)
        case .concealed:
            return .failed(.secureInput)
        case .text(let text):
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .failed(.noSelection) }
            target.origin = .copy(pressStamp: focusInputStamp())
            shelf.put(id: id, target)
            return .selected(text: text, via: .copy)
        }
    }

    private func keysReleased() async throws -> Bool {
        let startedAt = DispatchTime.now()
        while true {
            let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
            let keyDown = heldShortcutKey.withLock { $0 }.map { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) } ?? false
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

let focusDeadline: TimeInterval = 2

/// The longest a read can take before it answers; main's read watchdog must outlast it.
let selectionReadMaxDuration = ReleaseWait.deadline + focusDeadline + 3 * TimeInterval(axMessagingTimeout)
    + CopyWait.deadline
