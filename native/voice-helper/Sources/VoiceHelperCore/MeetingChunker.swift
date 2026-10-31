/// Where to cut a meeting stream into windows the speech model decodes in one call. Windows end
/// at a pause when one comes, so a word is rarely split, and never run past the model's 15 s input.
public enum MeetingChunker {
    public static let frameSamples = 1600
    static let minimumFrames = 20
    static let maximumFrames = 140
    /// The most audio `cut` looks at; more would never be taken in one window.
    public static let windowSamples = maximumFrames * frameSamples
    static let pauseFrames = 6
    /// A pause this long ends a window shorter than the minimum, so a short reply shows soon.
    static let longPauseFrames = 10
    /// Below this RMS a 100 ms frame counts as quiet: about -46 dBFS.
    static let quietRms: Float = 0.005

    /// Samples to take from the front of `samples`, or nil to wait for more. `final` means no more
    /// audio follows, so whatever is left is one last window.
    public static func cut(_ samples: [Float], final: Bool) -> Int? {
        if samples.isEmpty { return nil }
        let levels = frameLevels(samples)
        // Silence before any speech is taken at once, so the other stream never waits on it, and
        // the next window keeps a short lead-in before the speech.
        let lead = levels.prefix { $0 < quietRms }.count
        if lead == levels.count, final { return samples.count }
        if lead >= pauseFrames { return (lead - pauseFrames / 2) * frameSamples }
        if let pause = firstPause(levels) { return pause * frameSamples }
        if levels.count >= maximumFrames {
            // No pause inside the window: cut at its quietest frame in the last 4 s.
            let tail = (maximumFrames - 40)..<maximumFrames
            let quietest = tail.min { levels[$0] < levels[$1] } ?? maximumFrames
            return max(quietest, 1) * frameSamples
        }
        return final ? samples.count : nil
    }

    /// The most audio one final-pass window takes. Longer windows give the model more context than
    /// the live windows had; the model still decodes them in overlapping 15 s pieces.
    public static let finalWindowSamples = 120 * PcmFile.sampleRate

    /// Samples to take from the front of `samples` for one final-pass window: all of them when
    /// fewer than a window remain, else up to the middle of the window's last pause, else its
    /// quietest frame in the last 10 s.
    public static func finalCut(_ samples: [Float]) -> Int {
        guard samples.count >= finalWindowSamples else { return samples.count }
        let levels = frameLevels(samples)
        var run = 0
        var lastPause: Int?
        for (index, level) in levels.enumerated() {
            run = level < quietRms ? run + 1 : 0
            if run >= pauseFrames { lastPause = index - run / 2 }
        }
        if let lastPause, lastPause > levels.count / 2 { return lastPause * frameSamples }
        let tail = (levels.count - 100)..<levels.count
        let quietest = tail.min { levels[$0] < levels[$1] } ?? levels.count
        return max(quietest, 1) * frameSamples
    }

    /// The span in `window` that holds speech, as a sample range, or nil when it is all quiet and
    /// needs no decode.
    public static func speech(in window: [Float]) -> Range<Int>? {
        let levels = frameLevels(window)
        guard let first = levels.firstIndex(where: { $0 >= quietRms }),
              let last = levels.lastIndex(where: { $0 >= quietRms })
        else { return nil }
        return first * frameSamples..<min(window.count, (last + 1) * frameSamples)
    }

    private static func frameLevels(_ samples: [Float]) -> [Float] {
        stride(from: 0, to: samples.count, by: frameSamples).map { start in
            let frame = samples[start..<min(start + frameSamples, samples.count)]
            let power = frame.reduce(0) { $0 + $1 * $1 } / Float(frame.count)
            return power.squareRoot()
        }
    }

    // The middle of the first quiet run of at least `pauseFrames` whose middle comes after the
    // minimum window, or of the first run of `longPauseFrames`, as far as the run reaches yet.
    private static func firstPause(_ levels: [Float]) -> Int? {
        var run = 0
        for (index, level) in levels.enumerated().prefix(maximumFrames) {
            run = level < quietRms ? run + 1 : 0
            let middle = index - run + 1 + run / 2
            if run >= pauseFrames, middle >= minimumFrames || run >= longPauseFrames { return middle }
        }
        return nil
    }
}
