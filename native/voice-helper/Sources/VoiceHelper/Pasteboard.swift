import AppKit
import VoiceHelperCore

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

    var changeCount: Int { pasteboard.changeCount }

    var string: String? { pasteboard.string(forType: .string) }

    var holdsConcealed: Bool {
        (pasteboard.types ?? []).contains(NSPasteboard.PasteboardType(concealedPasteboardType))
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

    /// Registers the write an app made in answer to a synthetic Cmd+C.
    func wrote(_ write: Int, saved: Saved) {
        tracker.wrote(write, saved: saved)
    }

    func restore(write: Int) {
        guard let saved = tracker.restore(write: write, changeCount: pasteboard.changeCount) else {
            output.log(.info, "clipboard changed during paste; not restoring previous contents")
            return
        }
        put(saved)
    }

    /// For a copy that answered after its deadline. A paste that wrote meanwhile owns the
    /// clipboard until its own restore, so nothing is put back over it.
    func restoreLate(_ saved: Saved, write: Int) {
        guard !tracker.hasPending else { return }
        tracker.wrote(write, saved: saved)
        restore(write: write)
    }

    /// Runs a restore still waiting on its timer, so an exit inside the window does not leave
    /// the transcript on the user's clipboard.
    func flush() {
        guard let saved = tracker.flush(changeCount: pasteboard.changeCount) else { return }
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
