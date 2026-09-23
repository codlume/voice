import AppKit

// The paste fallback's temporary use of a pasteboard. The prior contents are copied into this
// process only for the duration of one paste. They never leave the helper: they are not sent to
// Electron, logged, or written anywhere. Restoring requires Voice's temporary value to still be
// the current one, so a copy the user makes meanwhile always survives.
public final class Clipboard: @unchecked Sendable {
    public typealias Kind = NSPasteboard.PasteboardType
    // Marks Voice's temporary value. The nspasteboard.org markers ask clipboard managers not to
    // record or show it; the Voice marker lets a reader recognise it.
    public static let marker = Kind("com.codlume.voice.insertion")
    public static let transient = Kind("org.nspasteboard.TransientType")
    public static let concealed = Kind("org.nspasteboard.ConcealedType")
    // Every item and every type it offers, in order, with the bytes each type returned.
    public struct Snapshot: @unchecked Sendable {
        fileprivate let items: [[(Kind, Data)]]
        fileprivate let count: Int
    }
    public enum Restoration: Equatable, Sendable {
        // Nothing was pending. `superseded`: someone else wrote since Voice did; their value stays.
        case idle, restored, superseded, failed
    }
    private final class Box: @unchecked Sendable { var snapshot: Snapshot? }
    private let pasteboard: NSPasteboard
    private let budget: DispatchTimeInterval
    private let limit: Int
    private let lock = NSLock()
    private var pending: (snapshot: Snapshot, owned: Int)?

    public init(_ pasteboard: NSPasteboard, budget: DispatchTimeInterval = .milliseconds(750), limit: Int = 64 << 20) {
        self.pasteboard = pasteboard
        self.budget = budget
        self.limit = limit
    }

    // A complete copy of the current contents, or nil when any part cannot be preserved exactly.
    // Reading can call into the app that owns lazily provided data, so it runs on its own thread
    // and gives up after the budget instead of stalling delivery.
    public func snapshot() -> Snapshot? {
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) let pasteboard = pasteboard
        let limit = limit
        Thread.detachNewThread {
            box.snapshot = Clipboard.read(pasteboard, limit: limit)
            done.signal()
        }
        guard done.wait(timeout: .now() + budget) == .success else { return nil }
        return box.snapshot
    }
    private static func read(_ pasteboard: NSPasteboard, limit: Int) -> Snapshot? {
        let count = pasteboard.changeCount
        guard let items = pasteboard.pasteboardItems else { return nil }
        var total = 0
        var copied: [[(Kind, Data)]] = []
        for item in items {
            var types: [(Kind, Data)] = []
            for type in item.types {
                // Concealed or transient values belong to their owner's lifecycle (a password
                // manager clears its own copy), and promised files cannot be recreated from bytes.
                if type == concealed || type == transient || type.rawValue.localizedCaseInsensitiveContains("promise") { return nil }
                // Lazily provided data that fails to materialize cannot be put back.
                guard let data = item.data(forType: type) else { return nil }
                total += data.count
                if total > limit { return nil }
                types.append((type, data))
            }
            copied.append(types)
        }
        guard pasteboard.changeCount == count else { return nil }
        return Snapshot(items: copied, count: count)
    }

    // Replaces the contents with the marked text, only if nothing changed since the snapshot.
    // After a false return, call restore(): the pasteboard may have been cleared.
    public func write(_ text: String, over snapshot: Snapshot) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard pending == nil, pasteboard.changeCount == snapshot.count else { return false }
        pasteboard.clearContents()
        pending = (snapshot, pasteboard.changeCount)
        let item = NSPasteboardItem()
        guard item.setString(text, forType: .string),
              item.setData(Data(), forType: Clipboard.transient),
              item.setData(Data(), forType: Clipboard.concealed),
              item.setData(Data(), forType: Clipboard.marker),
              pasteboard.writeObjects([item]) else { return false }
        pending = (snapshot, pasteboard.changeCount)
        return true
    }

    // Puts the snapshot back while Voice's value is still current. Safe from any thread, and at
    // most once per write: the termination path and the paste itself cannot both restore.
    public func restore() -> Restoration {
        lock.lock()
        defer { lock.unlock() }
        guard let current = pending else { return .idle }
        pending = nil
        // A tiny window remains between this check and clearing; NSPasteboard has no atomic swap.
        guard pasteboard.changeCount == current.owned else { return .superseded }
        pasteboard.clearContents()
        let items = current.snapshot.items.map { types in
            let item = NSPasteboardItem()
            return (item, types.allSatisfy { item.setData($0.1, forType: $0.0) })
        }
        guard items.allSatisfy(\.1) else { return .failed }
        if items.isEmpty { return .restored }
        return pasteboard.writeObjects(items.map(\.0)) ? .restored : .failed
    }
}
