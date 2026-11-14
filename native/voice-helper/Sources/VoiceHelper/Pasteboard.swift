import AppKit
import VoiceHelperCore

enum CopyOutcome: Equatable {
    case text(String)
    case concealed
    /// Monaco answered with the caret's line because nothing was selected.
    case lineOfEmptySelection
    case nothing
}

final class Pasteboard {
    typealias Item = [(NSPasteboard.PasteboardType, Data)]
    typealias Saved = SavedClipboard<Item>

    /// How long a paste's text stays on the clipboard before the user's contents go back. A slow
    /// target (Electron under load, a remote desktop) can read the pasteboard well after the
    /// keystroke, and nothing can observe that read.
    static let pasteRestoreDelay: TimeInterval = 1.0

    /// A synthetic Cmd+C whose answer, if it still comes, has to be taken off the clipboard.
    private final class PendingCopy {
        var wait: CopyWait
        let saved: Saved
        /// The press counters when the wait timed out. Nil while the answer is still awaited.
        var deadlineStamp: PressStamp?

        init(wait: CopyWait, saved: Saved) {
            self.wait = wait
            self.saved = saved
        }
    }

    private let pasteboard: NSPasteboard
    private let output: Output
    private let postCopy: () -> Void
    private let pressStamp: () -> PressStamp
    private var tracker = ClipboardRestore<Saved>()
    private var copy: PendingCopy?
    /// When the last paste restore or late copy check asked for so far will have run.
    private var quietAt = DispatchTime.now()
    private var exiting = false

    init(
        output: Output, board: NSPasteboard = .general,
        postCopy: @escaping () -> Void = { postCommand(typing: "c", fallback: PasteKey.ansiC) },
        pressStamp: @escaping () -> PressStamp = focusInputStamp
    ) {
        self.output = output
        pasteboard = board
        self.postCopy = postCopy
        self.pressStamp = pressStamp
    }

    func save() -> Saved {
        tracker.contentsToSave(changeCount: pasteboard.changeCount) {
            let items = pasteboard.pasteboardItems ?? []
            return SavedClipboard(types: items.flatMap { $0.types.map(\.rawValue) }) {
                items.map { item in
                    item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
                }
            }
        }
    }

    /// Nil `saved` keeps the text on the clipboard: no restore follows, and any earlier paste's
    /// pending restore backs off. The markers stay so clipboard managers still skip the item.
    func write(text: String, html: String?, saved: Saved?) -> Int {
        // Host-only keeps Universal Clipboard from offering the transcript to the user's other devices.
        pasteboard.prepareForNewContents(with: .currentHostOnly)
        // Without the charset, readers decode the HTML as Latin-1 and garble non-ASCII text.
        let entries: [(NSPasteboard.PasteboardType, String)] = (html.map { [(.html, "<meta charset=\"utf-8\">" + $0)] } ?? []) + [
            (.string, text),
            (NSPasteboard.PasteboardType("org.nspasteboard.TransientType"), text),
            (NSPasteboard.PasteboardType(concealedPasteboardType), text),
        ]
        let item = NSPasteboardItem()
        for (type, value) in entries { item.setString(value, forType: type) }
        pasteboard.writeObjects([item])
        let write = pasteboard.changeCount
        if let saved {
            tracker.wrote(write, saved: saved)
            quietAt = max(quietAt, .now() + Self.pasteRestoreDelay)
        } else {
            tracker.kept(write, contents: .keptTranscript([entries.map { ($0, Data($1.utf8)) }]))
        }
        copy?.wait.absorb(ownChange: write)
        return write
    }

    func restore(write: Int) {
        switch tracker.restore(write: write, changeCount: pasteboard.changeCount) {
        case .restore(let saved): put(saved)
        case .superseded: output.log(.info, "clipboard superseded by a later paste; not restoring previous contents")
        case .changed: output.log(.info, "clipboard changed by someone else during paste; not restoring previous contents")
        }
    }

    @MainActor
    func copyFromFocusedApp() async -> CopyOutcome {
        // An exiting helper would leave before it could take the answer off the clipboard.
        guard !exiting else { return .nothing }
        resolveCopy()
        let pending = PendingCopy(wait: CopyWait(startChangeCount: pasteboard.changeCount), saved: save())
        copy = pending
        postCopy()
        let postedAt = DispatchTime.now()
        quietAt = max(quietAt, postedAt + CopyWait.lateCheck)
        let watchThatOutlivesCancellation = Task { @MainActor [self] () -> CopyOutcome in
            while copy === pending {
                switch pending.wait.step(changeCount: pasteboard.changeCount, elapsed: elapsed(since: postedAt)) {
                case .wait:
                    try? await Task.sleep(for: .milliseconds(10))
                case .timedOut:
                    pending.deadlineStamp = pressStamp()
                    DispatchQueue.main.asyncAfter(deadline: postedAt + CopyWait.lateCheck) { [self] in
                        if copy === pending { resolveCopy() }
                    }
                    return .nothing
                case .changed:
                    copy = nil
                    let write = pasteboard.changeCount
                    tracker.wrote(write, saved: pending.saved)
                    let concealed = (pasteboard.types ?? []).contains(NSPasteboard.PasteboardType(concealedPasteboardType))
                    let emptySelection = pasteboard.data(forType: NSPasteboard.PasteboardType(chromiumWebCustomDataType))
                        .map(isMonacoEmptySelectionCopy) ?? false
                    let text = pasteboard.string(forType: .string) ?? ""
                    if case .restore(let saved) = tracker.restore(write: write, changeCount: pasteboard.changeCount) {
                        put(saved)
                    } else {
                        output.log(.info, "clipboard changed during copy; not restoring previous contents")
                    }
                    if concealed { return .concealed }
                    return emptySelection ? .lineOfEmptySelection : .text(text)
                }
            }
            // The helper is exiting or a newer copy began, and that took over the restore.
            return .nothing
        }
        return await watchThatOutlivesCancellation.value
    }

    /// For a helper that is exiting. Runs `done` once the clipboard is the user's again. A paste
    /// restore or late copy check that is not yet due is waited for, because until then the
    /// target may still read the transcript or answer the copy.
    func settle(then done: @escaping () -> Void) {
        exiting = true
        guard tracker.hasPending || copy != nil, quietAt > .now() else {
            flush()
            return done()
        }
        // Checked again when due: a paste that was already on its way in can ask for more time.
        DispatchQueue.main.asyncAfter(deadline: quietAt) { [self] in settle(then: done) }
    }

    private func flush() {
        if let saved = tracker.flush(changeCount: pasteboard.changeCount) { put(saved) }
        resolveCopy()
    }

    /// Ends a copy nobody waits on any more, and puts the user's clipboard back if the
    /// target's answer is on it.
    private func resolveCopy() {
        guard let pending = copy else { return }
        copy = nil
        if pending.wait.restoreNeeded(changeCount: pasteboard.changeCount, deadlineStamp: pending.deadlineStamp, stamp: pressStamp()) {
            put(pending.saved)
        }
    }

    private func put(_ saved: Saved) {
        pasteboard.clearContents()
        switch saved {
        case .concealed:
            output.log(.info, "clipboard held concealed contents; cleared instead of restoring")
        case .items(let saved), .keptTranscript(let saved):
            let items = saved.map { entries in
                let restored = NSPasteboardItem()
                for (type, data) in entries { restored.setData(data, forType: type) }
                return restored
            }
            if !items.isEmpty { pasteboard.writeObjects(items) }
        }
        // The transcript went back with its concealed marker, so the next save needs this
        // record to tell it from a password.
        if case .keptTranscript = saved { tracker.kept(pasteboard.changeCount, contents: saved) }
        copy?.wait.absorb(ownChange: pasteboard.changeCount)
    }
}
