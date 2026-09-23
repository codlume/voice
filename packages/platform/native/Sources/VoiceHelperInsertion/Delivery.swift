import ApplicationServices
import VoiceHelperProtocol

// How a native Accessibility write ended. nil means the route does not exist for this field and
// nothing was written, the only case where the paste fallback may follow.
public func nativeOutcome(_ result: AXError, confirmed: Bool) -> InsertionOutcome? {
    switch result {
    case .success: return confirmed ? .inserted : .uncertain
    case .invalidUIElement: return .closed
    case .cannotComplete, .failure: return .uncertain
    case .attributeUnsupported, .notImplemented: return nil
    default: return .failed
    }
}

// The target-specific steps of a paste, supplied by the Accessibility layer.
public struct PasteSteps {
    // Revalidates the target and pending delivery right before paste; non-nil blocks delivery.
    public let ready: () -> InsertionOutcome?
    // Posts the paste command to the target. False when nothing was sent.
    public let paste: () -> Bool
    // Waits, bounded, for evidence the target consumed exactly this paste.
    public let consumed: () -> Bool
    public init(ready: @escaping () -> InsertionOutcome?, paste: @escaping () -> Bool, consumed: @escaping () -> Bool) {
        self.ready = ready; self.paste = paste; self.consumed = consumed
    }
}

// One delivery into an already validated target. `native` is nil when the field offers no
// Accessibility write. A native attempt that may have inserted never falls back to paste, so an
// uncertain insertion is never duplicated. Paste happens only after the whole clipboard was
// preserved, and the clipboard is restored on every path once Voice has written to it.
public func deliver(_ text: String, native: (() -> InsertionOutcome?)?, clipboard: Clipboard, steps: PasteSteps) -> InsertionResult {
    if let native, let outcome = native() { return InsertionResult(outcome) }
    guard let snapshot = clipboard.snapshot() else { return InsertionResult(.unpreserved) }
    if let refusal = steps.ready() { return InsertionResult(refusal) }
    func finish(_ outcome: InsertionOutcome) -> InsertionResult {
        InsertionResult(outcome, restored: clipboard.restore() != .failed)
    }
    guard clipboard.write(text, over: snapshot) else { return finish(.unpreserved) }
    if let refusal = steps.ready() { return finish(refusal) }
    guard steps.paste() else { return finish(.failed) }
    return finish(steps.consumed() ? .pasted : .uncertain)
}
