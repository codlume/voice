import AppKit
import VoiceHelperCore

/// What the focused app put on the clipboard in answer to a synthetic Cmd+C.
enum CopyOutcome {
    /// The clipboard's string, empty when the app wrote something that is not text.
    case text(String)
    /// The write carried the concealed marker: a password field.
    case concealed
    /// No write before the deadline.
    case nothing
}

/// The one keeper of the user's clipboard across every write the helper causes: a paste
/// insertion's own item and the copy an app makes in answer to a selection read's Cmd+C. One
/// `ClipboardRestore` for both is what lets a read inside a paste's restore window carry the
/// user's contents over instead of saving the transcript.
final class Pasteboard {
    typealias Item = [(NSPasteboard.PasteboardType, Data)]
    typealias Saved = SavedClipboard<Item>

    private let pasteboard = NSPasteboard.general
    private let output: Output
    private var tracker = ClipboardRestore<Saved>()

    init(output: Output) {
        self.output = output
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

    /// Puts the transient paste item on the clipboard and returns the changeCount of that write.
    func write(text: String, html: String?, saved: Saved) -> Int {
        // Host-only keeps Universal Clipboard from offering the transcript to the user's other devices.
        pasteboard.prepareForNewContents(with: .currentHostOnly)
        let item = NSPasteboardItem()
        // Without the charset, readers decode the HTML as Latin-1 and garble non-ASCII text.
        if let html { item.setString("<meta charset=\"utf-8\">" + html, forType: .html) }
        item.setString(text, forType: .string)
        item.setString(text, forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        item.setString(text, forType: NSPasteboard.PasteboardType(concealedPasteboardType))
        pasteboard.writeObjects([item])
        let write = pasteboard.changeCount
        tracker.wrote(write, saved: saved)
        return write
    }

    /// After a paste, puts the user's contents back once the target has read the transient item.
    func restore(write: Int) {
        restore(write: write, changed: "clipboard changed during paste; not restoring previous contents")
    }

    /// Borrows the clipboard for a synthetic Cmd+C and hands it back: the user's contents are
    /// saved, the app's answer is read and restored over at once, and an answer after the
    /// deadline is restored too, unless the user copied something meanwhile or a paste wrote in
    /// between (its own restore owns the clipboard then). The watch runs in a task of its own
    /// that a cancelled caller cannot reach: the keystroke is out, so the restore must follow.
    func copyFromFocusedApp() async -> CopyOutcome {
        let saved = save()
        let wait = CopyWait(startChangeCount: pasteboard.changeCount)
        postCommand(typing: "c", fallback: PasteKey.ansiC)
        let postedAt = DispatchTime.now()
        return await Task { @MainActor [self] in
            while true {
                switch wait.step(changeCount: pasteboard.changeCount, elapsed: elapsed(since: postedAt)) {
                case .wait:
                    try? await Task.sleep(for: .milliseconds(10))
                case .timedOut:
                    DispatchQueue.main.asyncAfter(deadline: postedAt + CopyWait.lateCheck) { [self] in
                        guard !tracker.hasPending, wait.lateRestoreNeeded(changeCount: pasteboard.changeCount) else { return }
                        put(saved)
                    }
                    return .nothing
                case .changed:
                    let write = pasteboard.changeCount
                    tracker.wrote(write, saved: saved)
                    let concealed = (pasteboard.types ?? []).contains(NSPasteboard.PasteboardType(concealedPasteboardType))
                    let text = pasteboard.string(forType: .string) ?? ""
                    restore(write: write, changed: "clipboard changed during copy; not restoring previous contents")
                    return concealed ? .concealed : .text(text)
                }
            }
        }.value
    }

    /// Runs a restore still waiting on its timer, so an exit inside the window does not leave
    /// the transcript on the user's clipboard.
    func flush() {
        guard let saved = tracker.flush(changeCount: pasteboard.changeCount) else { return }
        put(saved)
    }

    private func restore(write: Int, changed log: String) {
        guard let saved = tracker.restore(write: write, changeCount: pasteboard.changeCount) else {
            output.log(.info, log)
            return
        }
        put(saved)
    }

    private func put(_ saved: Saved) {
        pasteboard.clearContents()
        guard case .items(let saved) = saved else {
            output.log(.info, "clipboard held concealed contents; cleared instead of restoring")
            return
        }
        let items = saved.map { entries in
            let restored = NSPasteboardItem()
            for (type, data) in entries { restored.setData(data, forType: type) }
            return restored
        }
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }
}
