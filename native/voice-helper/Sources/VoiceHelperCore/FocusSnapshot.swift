private let focusSnapshotAttempts = 3

/// Takes a session's focus baseline from two reads that must agree, and takes it again while
/// the miss is one that can pass on its own. Focus can move with no press (a swipe back, a page
/// focusing another field), so a later attempt cannot tell whether it reads the field the user
/// dictated into. Only the session's first read can stand for that field. When it named no
/// target there is no retry, and a retry keeps only a baseline that still shows the target it
/// named. `take` blocks through the reads and the pauses, so it runs off main.
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
            // An app that did not answer would spend its timeout again and still give no baseline.
            let second = first == .noAnswer ? first : read()
            // A window-only read with no URL names no page, so a later one in that window could
            // be another page whose lookup also gave up.
            if attempt == 1, let focus = first.focus, focus.anchor != .windowOnly(pageURL: nil) { origin = focus }
            var moved = false
            if first == second, let origin, let now = first.focus {
                moved = !origin.isSameTarget(as: now, pageURL: pageURL)
            }
            // `frontmost` can block. The press count is read after it, so a press in that time still counts.
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
