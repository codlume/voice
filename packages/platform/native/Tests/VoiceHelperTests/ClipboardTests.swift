import AppKit
import ApplicationServices
import Testing
import VoiceHelperInsertion
import VoiceHelperProtocol

// Deterministic ownership and fault tests on private named pasteboards with synthetic fixtures.
// Nothing here reads or writes the user's general pasteboard.
typealias Kind = NSPasteboard.PasteboardType
typealias Items = [[(Kind, Data)]]
let transcript = "Hello, Priya. Do not deploy VX-204."
let fixtures: [String: Items] = [
    "empty": [],
    "plain": [[(.string, Data("Synthetic plain copy".utf8))]],
    "rich": [[
        (.string, Data("Synthetic bold".utf8)),
        (.rtf, Data(#"{\rtf1\ansi\b Synthetic bold}"#.utf8)),
        (.html, Data("<b>Synthetic bold</b>".utf8)),
    ]],
    "nontext": [
        [(.png, Data([0x89, 0x50, 0x4E, 0x47, 0, 1, 2])), (Kind("com.codlume.voice.fixture.binary"), Data([0, 255, 7]))],
        [(.string, Data("Second item".utf8)), (.URL, Data("https://example.com/fixture".utf8))],
    ],
]
final class Scratch {
    let pasteboard = NSPasteboard(name: NSPasteboard.Name("com.codlume.voice.test.\(UUID().uuidString)"))
    deinit { pasteboard.releaseGlobally() }
    func write(_ items: Items) {
        pasteboard.clearContents()
        guard !items.isEmpty else { return }
        pasteboard.writeObjects(items.map { types in
            let item = NSPasteboardItem()
            for (type, data) in types { item.setData(data, forType: type) }
            return item
        })
    }
    // Exact comparison of every item and type with the expected fixture.
    func holds(_ expected: Items) -> Bool {
        let items = pasteboard.pasteboardItems ?? []
        guard items.count == expected.count else { return false }
        return zip(items, expected).allSatisfy { item, types in
            types.allSatisfy { type, data in item.data(forType: type) == data }
        }
    }
    var holdsTranscript: Bool {
        let types = pasteboard.types ?? []
        return pasteboard.string(forType: .string) == transcript
            && [Clipboard.marker, Clipboard.transient, Clipboard.concealed].allSatisfy(types.contains)
    }
}
final class Silent: NSObject, NSPasteboardItemDataProvider {
    // Promised data that never materializes.
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: Kind) {}
}
// Records which steps a delivery took.
final class Steps {
    var ready: [InsertionOutcome?] = []
    var readyCalls = 0
    var pastes = 0
    var consumed = true
    var duringPaste: (() -> Void)?
    var duringWait: (() -> Void)?
    func make() -> PasteSteps {
        PasteSteps(
            ready: {
                defer { self.readyCalls += 1 }
                return self.readyCalls < self.ready.count ? self.ready[self.readyCalls] : nil
            },
            paste: { self.pastes += 1; self.duringPaste?(); return true },
            consumed: { self.duringWait?(); return self.consumed }
        )
    }
}

@Test(arguments: ["empty", "plain", "rich", "nontext"])
func pasteRestoresEveryItemAndType(_ kind: String) throws {
    let scratch = Scratch()
    let fixture = try #require(fixtures[kind])
    scratch.write(fixture)
    let clipboard = Clipboard(scratch.pasteboard)
    let steps = Steps()
    var marked = false
    steps.duringPaste = { marked = scratch.holdsTranscript }
    let result = deliver(transcript, native: nil, clipboard: clipboard, steps: steps.make())
    #expect(result == InsertionResult(.pasted))
    #expect(marked, "the target is offered only the marked transcript")
    #expect(steps.pastes == 1)
    #expect(scratch.holds(fixture))
    #expect(!(scratch.pasteboard.types ?? []).contains(Clipboard.marker))
}

@Test func unpreservableClipboardIsNeverTouched() {
    let silent = Silent()
    let cases: [(String, (NSPasteboard) -> Void)] = [
        ("lazy data that fails to materialize", { pasteboard in
            let item = NSPasteboardItem()
            item.setString("Synthetic", forType: .string)
            item.setDataProvider(silent, forTypes: [Kind("com.codlume.voice.fixture.lazy")])
            pasteboard.writeObjects([item])
        }),
        ("concealed", { $0.setString("secret", forType: .string); $0.setData(Data(), forType: Clipboard.concealed) }),
        ("transient", { $0.setString("temporary", forType: .string); $0.setData(Data(), forType: Clipboard.transient) }),
        ("file promise", { $0.setData(Data("x".utf8), forType: Kind("com.apple.pasteboard.promised-file-url")) }),
        ("over the size limit", { $0.setData(Data(count: 4096), forType: .png) }),
    ]
    for (name, fill) in cases {
        let scratch = Scratch()
        scratch.pasteboard.clearContents()
        fill(scratch.pasteboard)
        let count = scratch.pasteboard.changeCount
        let clipboard = Clipboard(scratch.pasteboard, budget: .milliseconds(300), limit: 1024)
        let steps = Steps()
        let result = deliver(transcript, native: nil, clipboard: clipboard, steps: steps.make())
        #expect(result == InsertionResult(.unpreserved), "\(name)")
        #expect(steps.pastes == 0 && steps.readyCalls == 0, "\(name)")
        #expect(scratch.pasteboard.changeCount == count, "\(name) must leave the clipboard alone")
    }
}

@Test func aCopyMadeDuringThePasteSurvives() throws {
    let scratch = Scratch()
    scratch.write(try #require(fixtures["rich"]))
    let copy: Items = [[(.string, Data("Synthetic newer copy".utf8))]]
    let steps = Steps()
    // Another writer takes the clipboard after Voice wrote and before it restores.
    steps.duringWait = { scratch.write(copy) }
    let result = deliver(transcript, native: nil, clipboard: Clipboard(scratch.pasteboard), steps: steps.make())
    #expect(result == InsertionResult(.pasted))
    #expect(scratch.holds(copy))
}

@Test func aCopyBetweenSnapshotAndWriteIsNeverOverwritten() throws {
    let scratch = Scratch()
    scratch.write(try #require(fixtures["plain"]))
    let clipboard = Clipboard(scratch.pasteboard)
    let snapshot = try #require(clipboard.snapshot())
    let copy: Items = [[(.string, Data("Synthetic newer copy".utf8))]]
    scratch.write(copy)
    #expect(!clipboard.write(transcript, over: snapshot))
    #expect(clipboard.restore() == .idle)
    #expect(scratch.holds(copy))
}

@Test func restoreHappensAtMostOnce() throws {
    let scratch = Scratch()
    let fixture = try #require(fixtures["plain"])
    scratch.write(fixture)
    let clipboard = Clipboard(scratch.pasteboard)
    let snapshot = try #require(clipboard.snapshot())
    #expect(clipboard.write(transcript, over: snapshot))
    #expect(scratch.holdsTranscript)
    // The termination path and the paste itself share this; the second caller finds nothing.
    #expect(clipboard.restore() == .restored)
    #expect(clipboard.restore() == .idle)
    #expect(scratch.holds(fixture))
}

@Test func uncertainOrFinishedNativeInsertionNeverFallsBackToPaste() throws {
    for outcome in [InsertionOutcome.uncertain, .inserted, .closed, .failed] {
        let scratch = Scratch()
        scratch.write(try #require(fixtures["plain"]))
        let count = scratch.pasteboard.changeCount
        let steps = Steps()
        let result = deliver(transcript, native: { outcome }, clipboard: Clipboard(scratch.pasteboard), steps: steps.make())
        #expect(result == InsertionResult(outcome))
        #expect(steps.pastes == 0 && steps.readyCalls == 0)
        #expect(scratch.pasteboard.changeCount == count)
    }
    // Only a route that does not exist falls back.
    let scratch = Scratch()
    let steps = Steps()
    let result = deliver(transcript, native: { nativeOutcome(.attributeUnsupported, confirmed: false) }, clipboard: Clipboard(scratch.pasteboard), steps: steps.make())
    #expect(result == InsertionResult(.pasted) && steps.pastes == 1)
}

@Test func nativeResultsThatMayHaveInsertedAreNeverRetried() {
    #expect(nativeOutcome(.success, confirmed: true) == .inserted)
    #expect(nativeOutcome(.success, confirmed: false) == .uncertain)
    #expect(nativeOutcome(.failure, confirmed: false) == .uncertain)
    #expect(nativeOutcome(.cannotComplete, confirmed: false) == .uncertain)
    #expect(nativeOutcome(.invalidUIElement, confirmed: false) == .closed)
    #expect(nativeOutcome(.illegalArgument, confirmed: false) == .failed)
    #expect(nativeOutcome(.attributeUnsupported, confirmed: false) == nil)
    #expect(nativeOutcome(.notImplemented, confirmed: false) == nil)
}

@Test func revalidationBeforePasteBlocksDeliveryAndRestores() throws {
    let fixture = try #require(fixtures["nontext"])
    // Refused before Voice writes, then refused after the write and immediately before paste.
    let cases: [([InsertionOutcome?], Bool)] = [([.changed], false), ([nil, .closed], true), ([nil, .missing], true)]
    for (ready, writes) in cases {
        let scratch = Scratch()
        scratch.write(fixture)
        let count = scratch.pasteboard.changeCount
        let steps = Steps()
        steps.ready = ready
        let expected = ready.compactMap { $0 }.first
        let result = deliver(transcript, native: nil, clipboard: Clipboard(scratch.pasteboard), steps: steps.make())
        #expect(result.outcome == expected && result.restored)
        #expect(steps.pastes == 0)
        #expect(scratch.holds(fixture))
        #expect((scratch.pasteboard.changeCount == count) == !writes)
    }
}

@Test func unconfirmedConsumptionIsUncertainAndStillRestores() throws {
    let scratch = Scratch()
    let fixture = try #require(fixtures["rich"])
    scratch.write(fixture)
    let steps = Steps()
    steps.consumed = false
    let result = deliver(transcript, native: nil, clipboard: Clipboard(scratch.pasteboard), steps: steps.make())
    #expect(result == InsertionResult(.uncertain))
    #expect(steps.pastes == 1)
    #expect(scratch.holds(fixture))
}

@Test func aPasteThatCouldNotBeSentRestoresAndFails() throws {
    let scratch = Scratch()
    let fixture = try #require(fixtures["plain"])
    scratch.write(fixture)
    let steps = PasteSteps(ready: { nil }, paste: { false }, consumed: { Issue.record("no paste was sent"); return true })
    let result = deliver(transcript, native: nil, clipboard: Clipboard(scratch.pasteboard), steps: steps)
    #expect(result == InsertionResult(.failed))
    #expect(scratch.holds(fixture))
}

@Test func insertionResultReportsOnlyAnUnrestoredClipboard() throws {
    for (result, clipboard) in [(InsertionResult(.pasted), nil), (InsertionResult(.uncertain, restored: false), "unrestored")] {
        let encoded = try JSONEncoder().encode(SetupReply(id: 1, result: .insertion(session: "one", result: result)))
        let reply = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let body = try #require(reply["result"] as? [String: Any])
        #expect(Set(body.keys) == Set(clipboard == nil ? ["type", "session", "outcome"] : ["type", "session", "outcome", "clipboard"]))
        #expect(body["clipboard"] as? String == clipboard)
    }
}
