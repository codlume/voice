private let focusSnapshotAttempts = 3

/// Takes a session's focus baseline from two reads that must agree. `take` blocks through the
/// reads and the pauses, so call it off main.
public struct FocusSnapshot<Element: Equatable> {
    private let read: () -> FocusReread<Element>
    private let inputUnchanged: () -> Bool
    private let frontmost: () -> Bool
    private let cancelled: () -> Bool
    private let pageURL: (Element) -> String?
    private let pause: () -> Void

    public init(
        read: @escaping () -> FocusReread<Element>, inputUnchanged: @escaping () -> Bool, frontmost: @escaping () -> Bool,
        cancelled: @escaping () -> Bool, pageURL: @escaping (Element) -> String?, pause: @escaping () -> Void
    ) {
        self.read = read
        self.inputUnchanged = inputUnchanged
        self.frontmost = frontmost
        self.cancelled = cancelled
        self.pageURL = pageURL
        self.pause = pause
    }

    public func take() -> (focus: CapturedFocus<Element>, attempt: Int) {
        var origin: TargetFocus<Element>?
        var attempt = 1
        while true {
            guard !cancelled() else { return (.unavailable(.cancelled), attempt) }
            guard inputUnchanged() else { return (.unavailable(.inputMoved), attempt) }
            let first = read()
            let second = first == .noAnswer ? first : read()
            if attempt == 1, let focus = first.focus, focus.anchor != .windowOnly(pageURL: nil) { origin = focus }
            var moved = false
            if first == second, let origin, let now = first.focus {
                moved = !origin.isSameTarget(as: now, pageURL: pageURL)
            }
            let frontmost = frontmost()
            var focus = CapturedFocus<Element>.pending
            focus.resolve(
                first: first, second: second, inputUnchanged: inputUnchanged(), frontmost: frontmost, movedSinceFirstRead: moved)
            guard case .unavailable(let loss) = focus, loss.isTransient, origin != nil, attempt < focusSnapshotAttempts else {
                return (focus, attempt)
            }
            pause()
            attempt += 1
        }
    }
}
