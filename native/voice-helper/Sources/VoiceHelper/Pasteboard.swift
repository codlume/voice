import AppKit
import VoiceHelperCore

enum CopyOutcome {
    case text(String)
    case concealed
    /// Monaco answered with the caret's line because nothing was selected.
    case lineOfEmptySelection
    case nothing
}

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
        } else {
            tracker.kept(write, contents: .items([entries.map { ($0, Data($1.utf8)) }]))
        }
        return write
    }

    func restore(write: Int) {
        switch tracker.restore(write: write, changeCount: pasteboard.changeCount) {
        case .restore(let saved): put(saved)
        case .superseded: output.log(.info, "clipboard superseded by a later paste; not restoring previous contents")
        case .changed: output.log(.info, "clipboard changed by someone else during paste; not restoring previous contents")
        }
    }

    func copyFromFocusedApp() async -> CopyOutcome {
        let saved = save()
        let wait = CopyWait(startChangeCount: pasteboard.changeCount)
        postCommand(typing: "c", fallback: PasteKey.ansiC)
        let postedAt = DispatchTime.now()
        let watchThatOutlivesCancellation = Task { @MainActor [self] () -> CopyOutcome in
            while true {
                switch wait.step(changeCount: pasteboard.changeCount, elapsed: elapsed(since: postedAt)) {
                case .wait:
                    try? await Task.sleep(for: .milliseconds(10))
                case .timedOut:
                    let deadlineStamp = focusInputStamp()
                    DispatchQueue.main.asyncAfter(deadline: postedAt + CopyWait.lateCheck) { [self] in
                        guard !tracker.hasPending,
                            wait.lateRestoreNeeded(changeCount: pasteboard.changeCount, deadlineStamp: deadlineStamp, stamp: focusInputStamp())
                        else { return }
                        put(saved)
                    }
                    return .nothing
                case .changed:
                    let write = pasteboard.changeCount
                    tracker.wrote(write, saved: saved)
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
        }
        return await watchThatOutlivesCancellation.value
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
