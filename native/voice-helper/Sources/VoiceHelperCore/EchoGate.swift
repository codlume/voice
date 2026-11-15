import Accelerate
import Foundation

/// On laptop speakers the microphone hears the other side, and `system.pcm` holds exactly what
/// played. Before the speech model hears a mic window, the gate mutes each time-frequency cell
/// of it that the system audio explains. Echo never reaches the model, and the user's voice,
/// which fills other cells, survives talking over the other side; a gate on whole windows would
/// drop it there. The mic file itself is never changed.
///
/// It learns the echo path from the audio it is handed: the lag, and the short filter that turns
/// what played into what the mic heard of it. Small speakers colour the echo bin by bin, so the
/// cells are judged against the echo that filter predicts, and the filter's echo is taken out of
/// the cells that stay. On headphones it finds no echo and takes almost nothing. Where only the
/// other side played, the model gets silence rather than residue to make words of.
public enum EchoGate {
    /// Audio before a block that the gate reads to learn the echo path.
    public static let contextSamples = 8 * PcmFile.sampleRate
    /// Audio after a block that the gate reads when both files hold it. A lag that moves just
    /// before the block ends shows only in what follows. Of 960 simulated windows that end 0.1
    /// to 4 s after a move of a MacBook Air's or a laptop's echo, 13 kept echo with 2 s after
    /// them, 7 with 2.5 s, and none with 3 s.
    static let lookaheadSamples = 3 * PcmFile.sampleRate
    /// The newest audio of the files, in which a lag that just moved shows in no block yet:
    /// three quarters of a second. Of 448 simulated live windows that end 0.5 to 3 s after a
    /// move, the live loop showed echo from 4 when it held no such audio back, and from none
    /// with half a second. Of 256 that end 0.1 to 0.4 s after a move it showed echo from 77,
    /// from 8 with half a second, and from 2 with three quarters.
    static let newestSamples = 3 * PcmFile.sampleRate / 4
    /// A long stretch is gated one live window at a time, so a clock that drifts never carries
    /// the lag far within one.
    static let blockSamples = MeetingChunker.windowSamples
    /// How much later the mic may hear what system audio recorded. The built-in mic and
    /// speakers capture -50 to +300 ms apart; Bluetooth or USB speakers play a few hundred ms late.
    static let lagRange = -PcmFile.frames(milliseconds: 100)...PcmFile.frames(milliseconds: 600)
    static let correlationBlock = 1 << 15
    /// A bin where system audio has under a thousandth of its average power says nothing about
    /// the lag. All it holds is the step each two-second block is cut off with, at one sample in
    /// the mic and in system audio alike, and a phase-only correlation counts every bin the
    /// same. A voice that plays nothing above 1.8 kHz left four bins in five like that, and
    /// they outvoted the echo for a lag of exactly zero.
    static let unplayedPower: Float = 1e-3
    /// Each two-second block fades in and out over 32 ms before its lag is looked for, so no
    /// block ends on a step. Left in, the step showed as a lag of zero in single blocks of the
    /// meeting fixtures, up to 16 times the correlation's rms.
    private static let fade = (0..<frameSize).map { 0.5 - 0.5 * cos(Float.pi * (Float($0) + 0.5) / Float(frameSize)) }
    /// A block shows a lag when its correlation peaks this many times its rms. Through
    /// speakers, on a MacBook Air and the meeting fixtures, 99 blocks in 100 peaked over 20
    /// times it. On headphones, with no echo to find, none of 694 blocks reached 12.
    static let clearPeak: Float = 16
    /// A block's lag this close to the last block's is the same echo path, not a move: 4 ms. A
    /// MacBook Air's echo peaked 2 ms late in a block that held little of it, and a clock 500
    /// parts per million fast carries the lag 1 ms a block.
    static let lagSlack = PcmFile.frames(milliseconds: 4)
    static let frameSize = 512
    static let hop = frameSize / 2
    static let bins = frameSize / 2 + 1
    /// A low quantile of the mic-to-echo ratios stays near the echo's own level even when the
    /// user talks over much of the stretch.
    static let quantile: Float = 0.3
    /// The predicted echo is this many times what the quantile says, which covers its spread
    /// from frame to frame and the speakers' distortion, which no level predicts. On the meeting
    /// fixtures through the real model, 4 leaks echo once it comes back as loud as it played, and
    /// 12 takes the user's double-talk with it; the unit tests pass at both.
    static let overSubtraction: Float = 6
    /// The room keeps a sound ringing after it stops: 3 dB less every 16 ms hop.
    static let reverbDecay: Float = 0.5
    /// Echo power in a bin below about -67 dBFS is nothing worth learning from.
    static let audiblePower: Float = 1e-7 * Float(frameSize)
    /// The path from the speakers to the mic is fitted as a filter this long, 64 ms. A MacBook
    /// Air's own speakers put 96% of the echo's energy within 16 ms of the direct sound.
    static let pathSamples = 1024
    /// The filter starts 2 ms ahead of the lag: the capture's own filters ring before the
    /// direct sound.
    static let pathLead = 32
    /// The path holds while the mic hears the echo within 2 dB of the level it predicts. Echo
    /// through a steady path came back within 0.6 dB on a MacBook Air and on the laptop
    /// fixtures, and 1.1 dB over through clipping speakers. A speaker whose clock drifts 50
    /// parts per million came back up to 4 dB over, and headphones, with no echo to fit, 6 to
    /// 11 dB under.
    static let pathTolerance: Float = 1.6
    /// What no path predicts of an echo, the speakers' distortion and the ringing past the
    /// filter's end, stays under a sixteenth of it: 21 dB under on a MacBook Air at half volume
    /// and 16.5 dB under on a MacBook Pro at 60%. Over a sweep of echo paths with only the other
    /// side talking, 1/32 left 84 of 20549 frames loud enough to transcribe; 1/16 and 1/8 left 5.
    static let distortion: Float = 1 / 16
    /// A frame that keeps four times what would silence it holds the user's voice, and so do
    /// the frames beside it: speech runs on where residue comes and goes. On a spoken Polish
    /// meeting where both sides share one voice, silencing by the residue alone lost 14 of the
    /// 222 words the user got through over the other side, and this keeps 11 of them.
    static let voiceMargin: Float = 4
    /// Frames either side of one that holds the user's voice: 96 ms.
    static let voiceReach = 6
    private static let correlationFFT = RealFFT(size: 2 * correlationBlock)

    /// Mic samples `offset..<offset + count` (fewer at the end of the file), gated against the
    /// same stretch of system audio. No system file leaves them as recorded, and so does a block
    /// with no speech in it, which most of a meeting is.
    public static func read(mic: URL, system: URL, offset: Int, count: Int) throws -> [Float] {
        let end = min(offset + count, PcmFile.frames(at: mic))
        let hasSystem = FileManager.default.fileExists(atPath: system.path)
        let systemEnd = PcmFile.frames(at: system)
        var out: [Float] = []
        for at in stride(from: offset, to: end, by: blockSamples) {
            let start = max(0, at - contextSamples)
            let blockEnd = min(at + blockSamples, end)
            let heard = try PcmFile.read(at: mic, offset: start, count: max(blockEnd, min(blockEnd + lookaheadSamples, systemEnd)) - start)
            let block = at - start..<blockEnd - start
            guard hasSystem, MeetingChunker.speech(in: Array(heard[block])) != nil else {
                out += heard[block]
                continue
            }
            out += gate(mic: heard, system: try PcmFile.read(at: system, offset: start, count: heard.count))[block]
        }
        return out
    }

    /// How much of `gated` is safe to transcribe while the files still grow: the count of its
    /// samples before the first sound that may still be the other side's echo, or all of them.
    /// `gated` is the mic from `offset` on, as `read` returned it. The gate places a lag that
    /// moved from the audio that follows the move, so a sound it left where the other side
    /// played may be their echo at a new lag as much as the user's voice. That holds for the
    /// newest `newestSamples` of the files, where no move shows yet. Once the mic shows that
    /// the lag moved, it holds until the system file has `lookaheadSamples` after the sound.
    public static func settled(_ gated: [Float], offset: Int, mic: URL, system: URL) throws -> Int {
        guard FileManager.default.fileExists(atPath: system.path) else { return gated.count }
        let systemEnd = PcmFile.frames(at: system)
        let runs = MeetingChunker.speechRuns(in: gated)
        func firstSound(inTheLast newest: Int) throws -> Int? {
            let unplaced = systemEnd - newest
            for run in runs where offset + run.upperBound > unplaced {
                // The mic hears what played anywhere in the lag's range around a sound.
                let sound = max(offset + run.lowerBound, unplaced)
                let from = max(0, sound - lagRange.upperBound)
                let played = try PcmFile.read(at: system, offset: from, count: offset + run.upperBound - lagRange.lowerBound - from)
                if let first = MeetingChunker.speech(in: played)?.lowerBound {
                    return max(sound, from + first + lagRange.lowerBound) - offset
                }
            }
            return nil
        }
        guard let sound = try firstSound(inTheLast: lookaheadSamples) else { return gated.count }
        // The lags in what the gate read for this window: its context, and the files to their end.
        let start = max(0, offset - contextSamples)
        let heard = try PcmFile.read(at: mic, offset: start, count: systemEnd - start)
        let lags = stretches(mic: heard, system: try PcmFile.read(at: system, offset: start, count: heard.count))
        // The lag may have moved up to a block after the start of the first block that shows the new one.
        let moved = lags.count > 1 && heard.count - lags.last!.range.lowerBound < lookaheadSamples + correlationBlock
        return try moved ? sound : firstSound(inTheLast: newestSamples) ?? gated.count
    }

    /// `mic` with what `system`, the same stretch of the meeting, explains muted. An output
    /// device that changes mid-call moves the lag and the echo's path with it, so each stretch
    /// of one lag is gated on its own, from what it alone heard.
    public static func gate(mic: [Float], system: [Float]) -> [Float] {
        guard !mic.isEmpty, !system.isEmpty, vDSP.maximumMagnitude(system) > 0 else { return mic }
        let played = Array(system.prefix(mic.count)) + [Float](repeating: 0, count: max(0, mic.count - system.count))
        let stretches = stretches(mic: mic, system: played)
        // The lag moved inside the last block that shows the old one or the first that shows
        // the new: where going from the old lag's gating to the new one's leaves the least of
        // the mic, since the wrong lag leaves the echo.
        var moves: [ClosedRange<Int>] = []
        for (old, new) in zip(stretches, stretches.dropFirst()) {
            let around = new.range.lowerBound - correlationBlock..<min(mic.count, new.range.lowerBound + correlationBlock)
            let before = gate(mic: mic, played: played, range: old.range.lowerBound..<around.upperBound, lag: old.lag)
            let after = gate(mic: mic, played: played, range: around.lowerBound..<new.range.upperBound, lag: new.lag)
            let handover = handover(from: before.suffix(around.count), to: after.prefix(around.count))
            let earliest = max(moves.last?.upperBound ?? 0, around.lowerBound + handover.lowerBound)
            moves.append(earliest...max(earliest, around.lowerBound + handover.upperBound))
        }
        let starts = [0] + moves.map(\.lowerBound) + [mic.count]
        var out: [Float] = []
        for (index, stretch) in stretches.enumerated() where starts[index] < starts[index + 1] {
            out += gate(mic: mic, played: played, range: starts[index]..<starts[index + 1], lag: stretch.lag)
        }
        // Neither gating leaves anything to hear where the move may be, and the frames at its
        // ends hold echo at both lags.
        for move in moves {
            let torn = max(0, move.lowerBound - frameSize)..<min(out.count, move.upperBound + frameSize)
            out.replaceSubrange(torn, with: repeatElement(0, count: torn.count))
        }
        return out
    }

    /// `mic[range]` with what system audio explains muted, heard `lag` samples after it `played`.
    static func gate(mic: [Float], played: [Float], range: Range<Int>, lag: Int) -> [Float] {
        let mic = Array(mic[range])
        let pad = [Float](repeating: 0, count: frameSize)
        let heard = Spectrogram(pad + mic + pad)
        let frames = heard.frames
        let power = heard.power

        // Digital silence, where the meeting mic recorded nothing during a dictation, is not a
        // quiet room: it says nothing about the echo's level or the room's noise.
        let heardPerFrame = (0..<frames).map { vDSP.sum(power[$0 * bins..<($0 + 1) * bins]) }
        func levelHeard(of echo: Spectrogram) -> Float {
            var audible = vDSP.threshold(echo.power, to: audiblePower, with: .zeroFill)
            for t in 0..<frames where heardPerFrame[t] == 0 {
                audible.replaceSubrange(t * bins..<(t + 1) * bins, with: repeatElement(0, count: bins))
            }
            return echoLevel(heard: power, audible: audible)
        }

        // The echo as the path from the speakers to the mic predicts it: right cell by cell,
        // however the speakers colour what they play. A speaker on another clock, or a lag that
        // moves, has no one path. The mic then hears the echo at another level than the filter
        // predicts, and the echo is taken to be what played, at one level for every bin.
        let ahead = Array(shift(played, by: lag - pathLead)[range])
        var echo = Spectrogram(pad + filtered(ahead, through: echoPath(from: ahead, to: mic)) + pad)
        var level = levelHeard(of: echo)
        let pathHolds = (1 / pathTolerance...pathTolerance).contains(level)
        if !pathHolds {
            echo = Spectrogram(pad + Array(shift(played, by: lag)[range]) + pad)
            level = levelHeard(of: echo)
        }

        // The echo's power per cell: what played, still ringing from the frames before.
        var ringing = echo.power
        for t in 1..<frames {
            let now = t * bins..<(t + 1) * bins
            let still = vDSP.multiply(reverbDecay, ringing[now.lowerBound - bins..<now.lowerBound])
            ringing.replaceSubrange(now, with: vDSP.maximum(Array(ringing[now]), still))
        }

        // The room's own noise: the quietest tenth of the frames, unless the user talks through
        // all of them, when it is what the chunker counts as quiet.
        let quiet = framePower(rms: MeetingChunker.quietRms)
        let recorded = heardPerFrame.filter { $0 > 0 }.sorted()
        let roomNoise = recorded.isEmpty ? quiet : min(quiet, recorded[recorded.count / 10])

        // A path that holds also takes its echo out of the cells the mask keeps, where the user
        // talks over the other side.
        let left = pathHolds ? heard.minus(echo) : heard
        let leftPower = pathHolds ? left.power : power
        var mask = vDSP.clip(vDSP.add(1, vDSP.divide(vDSP.multiply(-overSubtraction * level, ringing), vDSP.add(1e-30, power))), to: 0...1)
        // Frame by frame: what the mask keeps, and how much of that can still be the residue of
        // an echo the path predicts.
        let kept = (0..<frames).map { t in
            vDSP.sum(vDSP.multiply(vDSP.square(mask[t * bins..<(t + 1) * bins]), leftPower[t * bins..<(t + 1) * bins]))
        }
        let residue = (0..<frames).map { pathHolds ? distortion * level * vDSP.sum(ringing[$0 * bins..<($0 + 1) * bins]) : 0 }
        let silence = [Float](repeating: 0, count: bins)
        for t in 0..<frames where vDSP.maximum(ringing[t * bins..<(t + 1) * bins]) > audiblePower {
            // A frame the other side played into goes silent when it keeps no more than twice the
            // room's noise, or than the echo's residue: the speech model makes words of faint
            // echo residue. Beside the user's voice the residue is let be, since a frame cut out
            // of a word costs the word, but only beside a voice at least as loud as this frame's
            // residue: a faint sound just before a loud word of the other side's is no voice.
            let voiceNear = (max(0, t - voiceReach)...min(frames - 1, t + voiceReach)).contains {
                kept[$0] >= max(voiceMargin * max(2 * roomNoise, residue[$0]), residue[t])
            }
            if kept[t] < max(2 * roomNoise, voiceNear ? 0 : residue[t]) {
                mask.replaceSubrange(t * bins..<(t + 1) * bins, with: silence)
            }
        }
        return Array(left.resynthesized(mask: mask)[frameSize..<frameSize + mic.count])
    }

    /// How loud the echo comes back, learned from its direct power rather than its ringing: the
    /// modelled tail overstates an echo that decays faster, and a low quantile is drawn to those
    /// cells, more the louder the echo.
    static func echoLevel(heard: [Float], audible: [Float]) -> Float {
        // Only the cells where something audible played have a ratio; vDSP keeps a debug build
        // off a generic sort of the whole matrix, which the verify harness runs.
        var ratios = vDSP.compress(vDSP.divide(heard, audible), gatingVector: audible, nonZeroGatingCount: nil)
        guard !ratios.isEmpty else { return 0 }
        vDSP.sort(&ratios, sortOrder: .ascending)
        return ratios[Int(Float(ratios.count - 1) * quantile)]
    }

    /// The power a frame at `rms` sums to over its one-sided spectrum.
    static func framePower(rms: Float) -> Float {
        let windowEnergy = Float(frameSize) / 2
        let oneSidedSpectrumGain = Float(frameSize) / 2
        return windowEnergy * oneSidedSpectrumGain * rms * rms
    }

    /// The stretches of `mic` whose blocks show one lag behind system audio each, in order.
    static func stretches(mic: [Float], system: [Float]) -> [(range: Range<Int>, lag: Int)] {
        let blocks = blockSpectra(mic: faded(mic), system: faded(system))
        var starts = [0]
        var held: Int?
        for (index, block) in blocks.enumerated() {
            let correlation = correlation(block)
            let (peakAt, peak) = vDSP.indexOfMaximum(correlation)
            guard peak > clearPeak * vDSP.rootMeanSquare(correlation) else { continue }
            let lag = Int(peakAt) + lagRange.lowerBound
            if let held, abs(lag - held) > lagSlack { starts.append(index) }
            held = lag
        }
        return starts.indices.map { stretch in
            let first = starts[stretch]
            let last = stretch + 1 < starts.count ? starts[stretch + 1] : blocks.count
            return (first * correlationBlock..<min(mic.count, last * correlationBlock), lag(sum(blocks[first..<last])))
        }
    }

    /// Where to go from `before` to `after`, two gatings of the same samples: the counts taken
    /// from `before` that leave the least to hear, to the hop. A hop the chunker counts as
    /// quiet leaves nothing.
    static func handover(from before: ArraySlice<Float>, to after: ArraySlice<Float>) -> ClosedRange<Int> {
        let quiet = Float(hop) * MeetingChunker.quietRms * MeetingChunker.quietRms
        func heard(_ samples: ArraySlice<Float>, from start: Int) -> Float {
            let energy = vDSP.sumOfSquares(samples.dropFirst(start).prefix(hop))
            return energy > quiet ? energy : 0
        }
        var best = (counts: 0...0, saved: Float(0))
        var saved: Float = 0
        for start in stride(from: 0, to: before.count, by: hop) {
            saved += heard(after, from: start) - heard(before, from: start)
            let count = min(start + hop, before.count)
            if saved > best.saved { best = (count...count, saved) }
            if saved == best.saved { best.counts = best.counts.lowerBound...count }
        }
        return best.counts
    }

    /// `samples` with each two-second block faded in and out.
    static func faded(_ samples: [Float]) -> [Float] {
        var out = samples
        for start in stride(from: 0, to: samples.count, by: correlationBlock) {
            let end = min(start + correlationBlock, samples.count)
            let ramp = fade.prefix((end - start) / 2)
            out.replaceSubrange(start..<start + ramp.count, with: vDSP.multiply(ramp, samples[start..<start + ramp.count]))
            out.replaceSubrange(end - ramp.count..<end, with: vDSP.multiply(ramp.reversed(), samples[end - ramp.count..<end]))
        }
        return out
    }

    typealias Spectra = (crossRe: [Float], crossIm: [Float], power: [Float])

    /// Samples by which the mic trails system audio: the peak of their correlation.
    static func lag(_ spectra: Spectra) -> Int {
        Int(vDSP.indexOfMaximum(correlation(spectra)).0) + lagRange.lowerBound
    }

    /// How well each lag in `lagRange` lines the mic up with system audio: the size of their
    /// phase-only cross-correlation, over the bins the other side played.
    static func correlation(_ spectra: Spectra) -> [Float] {
        let (crossRe, crossIm, power) = spectra
        let magnitude = vDSP.add(1e-12, vForce.sqrt(vDSP.add(vDSP.square(crossRe), vDSP.square(crossIm))))
        // 1 where the other side played, 0 where it did not.
        let played = vDSP.add(0.5, vDSP.threshold(power, to: unplayedPower * vDSP.mean(power), with: .signedConstant(0.5)))
        let phase = vDSP.divide(played, magnitude)
        let correlation = correlationFFT.inverse(re: vDSP.multiply(crossRe, phase), im: vDSP.multiply(crossIm, phase))
        // Negative lags wrap around to the end.
        return vDSP.absolute(Array(correlation.suffix(-lagRange.lowerBound) + correlation.prefix(lagRange.upperBound + 1)))
    }

    /// The mic's cross-spectrum with system audio and system audio's own power spectrum, summed
    /// over two-second blocks.
    static func spectra(mic: [Float], system: [Float]) -> Spectra {
        sum(blockSpectra(mic: mic, system: system)[...])
    }

    static func sum(_ blocks: ArraySlice<Spectra>) -> Spectra {
        blocks.dropFirst().reduce(blocks.first!) {
            (vDSP.add($0.crossRe, $1.crossRe), vDSP.add($0.crossIm, $1.crossIm), vDSP.add($0.power, $1.power))
        }
    }

    /// For each two-second block, the mic's cross-spectrum with system audio and system audio's
    /// own power spectrum.
    static func blockSpectra(mic: [Float], system: [Float]) -> [Spectra] {
        let block = correlationBlock
        return stride(from: 0, to: mic.count, by: block).map { start in
            let end = min(start + block, mic.count)
            let zeros = [Float](repeating: 0, count: 2 * block - (end - start))
            let m = correlationFFT.forward(Array(mic[start..<end]) + zeros)
            let s = correlationFFT.forward(Array(system[start..<end]) + zeros)
            return (vDSP.add(vDSP.multiply(m.re, s.re), vDSP.multiply(m.im, s.im)),
                    vDSP.subtract(vDSP.multiply(m.im, s.re), vDSP.multiply(m.re, s.im)),
                    vDSP.add(vDSP.square(s.re), vDSP.square(s.im)))
        }
    }

    /// The filter of `pathSamples` taps that brings `played` closest to `mic`, by least squares.
    /// `played` is system audio moved to start `pathLead` ahead of the mic's lag.
    static func echoPath(from played: [Float], to mic: [Float]) -> [Float] {
        // What played into the mic's digital silence was never heard: left in, it would fit a
        // path quieter than the real one.
        var played = played
        for start in stride(from: 0, to: mic.count, by: hop) {
            let span = start..<min(start + hop, mic.count)
            if vDSP.maximumMagnitude(mic[span]) == 0 { played.replaceSubrange(span, with: repeatElement(0, count: span.count)) }
        }
        // How what played correlates with the mic and with itself, lag by lag.
        let (crossRe, crossIm, power) = spectra(mic: mic, system: played)
        let withMic = correlationFFT.inverse(re: crossRe, im: crossIm)
        var withItself = vDSP.floatToDouble(correlationFFT.inverse(re: power, im: [Float](repeating: 0, count: power.count)).prefix(pathSamples))
        guard withItself[0] > 0 else { return [Float](repeating: 0, count: pathSamples) }
        // Speech leaves whole bands unplayed, and there any path fits. A thousandth of its
        // power, added as white noise, makes the fit choose none.
        withItself[0] *= 1.001
        return vDSP.doubleToFloat(solve(toeplitz: withItself, vDSP.floatToDouble(withMic.prefix(pathSamples))))
    }

    /// `x` with `sum(x[j] * r[abs(i - j)]) == y[i]` for every `i`, by Levinson's recursion: the
    /// least-squares filter from how its input correlates with itself, `r`, and with its
    /// output, `y`, each by lag.
    static func solve(toeplitz r: [Double], _ y: [Double]) -> [Double] {
        let backwards = Array(r.reversed())
        var forward = [1 / r[0]]
        var backward = forward
        var x = [y[0] / r[0]]
        for n in 1..<y.count {
            // r[n], r[n - 1], ..., r[1]: the matrix's next row against the solutions so far.
            let row = backwards[r.count - 1 - n..<r.count - 1]
            let forwardError = vDSP.dot(row, forward)
            let error = vDSP.dot(row, x)
            let scale = 1 / (1 - forwardError * forwardError)
            let grown = forward + [0]
            let moved = [0] + backward
            forward = vDSP.add(multiplication: (grown, scale), multiplication: (moved, -forwardError * scale))
            backward = vDSP.add(multiplication: (moved, scale), multiplication: (grown, -forwardError * scale))
            x = vDSP.add(x + [0], vDSP.multiply(y[n] - error, backward))
        }
        return x
    }

    /// `samples` through the filter `path`, at the same length.
    static func filtered(_ samples: [Float], through path: [Float]) -> [Float] {
        let block = correlationBlock
        let response = correlationFFT.forward(path + [Float](repeating: 0, count: 2 * block - path.count))
        var out = [Float](repeating: 0, count: samples.count + 2 * block)
        for start in stride(from: 0, to: samples.count, by: block) {
            let end = min(start + block, samples.count)
            let s = correlationFFT.forward(Array(samples[start..<end]) + [Float](repeating: 0, count: 2 * block - (end - start)))
            let through = correlationFFT.inverse(
                re: vDSP.subtract(vDSP.multiply(s.re, response.re), vDSP.multiply(s.im, response.im)),
                im: vDSP.add(vDSP.multiply(s.re, response.im), vDSP.multiply(s.im, response.re)))
            // A block and the path's tail fit the transform, so nothing wraps around.
            let span = start..<start + 2 * block
            out.replaceSubrange(span, with: vDSP.add(out[span], through))
        }
        return Array(out.prefix(samples.count))
    }

    /// `samples` delayed by `lag`, early by a negative one, at the same length.
    static func shift(_ samples: [Float], by lag: Int) -> [Float] {
        let silence = [Float](repeating: 0, count: min(abs(lag), samples.count))
        return lag >= 0 ? silence + samples.dropLast(silence.count) : samples.dropFirst(silence.count) + silence
    }

    /// Overlapping `frameSize` frames, `hop` apart, under a sine window whose square sums to
    /// one, so masking and resynthesis leave an untouched cell exactly as it was.
    private struct Spectrogram {
        static let window = (0..<frameSize).map { sin(Float.pi * Float($0) / Float(frameSize)) }
        private static let fft = RealFFT(size: frameSize)
        let count: Int
        let frames: Int
        let re: [Float]
        let im: [Float]

        init(_ samples: [Float]) {
            count = samples.count
            frames = (samples.count - frameSize) / hop + 1
            var re = [Float](repeating: 0, count: frames * bins)
            var im = re
            for t in 0..<frames {
                let spectrum = Self.fft.forward(vDSP.multiply(Self.window, samples[t * hop..<t * hop + frameSize]))
                re.replaceSubrange(t * bins..<(t + 1) * bins, with: spectrum.re)
                im.replaceSubrange(t * bins..<(t + 1) * bins, with: spectrum.im)
            }
            self.re = re
            self.im = im
        }

        private init(count: Int, frames: Int, re: [Float], im: [Float]) {
            self.count = count
            self.frames = frames
            self.re = re
            self.im = im
        }

        var power: [Float] {
            vDSP.add(vDSP.square(re), vDSP.square(im))
        }

        /// These cells with those of `other`, as long, taken out of them.
        func minus(_ other: Spectrogram) -> Spectrogram {
            Spectrogram(count: count, frames: frames, re: vDSP.subtract(re, other.re), im: vDSP.subtract(im, other.im))
        }

        func resynthesized(mask: [Float]) -> [Float] {
            var out = [Float](repeating: 0, count: count)
            for t in 0..<frames {
                let cells = t * bins..<(t + 1) * bins
                let frame = Self.fft.inverse(re: vDSP.multiply(re[cells], mask[cells]), im: vDSP.multiply(im[cells], mask[cells]))
                let span = t * hop..<t * hop + frameSize
                out.replaceSubrange(span, with: vDSP.add(out[span], vDSP.multiply(Self.window, frame)))
            }
            return out
        }
    }
}

/// A real FFT of `size` samples with numpy's scaling: `size / 2 + 1` bins, the inverse undoing
/// the forward exactly. Safe to share: the setup is read-only once built, and a transform writes
/// only into its caller's buffers.
private struct RealFFT: @unchecked Sendable {
    let size: Int
    private let fft: vDSP.FFT<DSPSplitComplex>

    init(size: Int) {
        self.size = size
        fft = vDSP.FFT(log2n: vDSP_Length(size.trailingZeroBitCount), radix: .radix2, ofType: DSPSplitComplex.self)!
    }

    func forward(_ samples: [Float]) -> (re: [Float], im: [Float]) {
        let half = size / 2
        var re = [Float](repeating: 0, count: half + 1)
        var im = [Float](repeating: 0, count: half + 1)
        re.withUnsafeMutableBufferPointer { rp in
            im.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                samples.withUnsafeBufferPointer { sp in
                    sp.withMemoryRebound(to: DSPComplex.self) { vDSP_ctoz($0.baseAddress!, 2, &split, 1, vDSP_Length(half)) }
                }
                let input = split
                fft.forward(input: input, output: &split)
            }
        }
        // vDSP doubles every bin and packs the Nyquist bin into the DC bin's imaginary part.
        re[half] = im[0]
        im[0] = 0
        return (vDSP.multiply(0.5, re), vDSP.multiply(0.5, im))
    }

    func inverse(re: [Float], im: [Float]) -> [Float] {
        let half = size / 2
        var packedRe = Array(re.prefix(half))
        var packedIm = Array(im.prefix(half))
        packedIm[0] = re[half]
        var out = [Float](repeating: 0, count: size)
        packedRe.withUnsafeMutableBufferPointer { rp in
            packedIm.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                let input = split
                fft.inverse(input: input, output: &split)
                out.withUnsafeMutableBufferPointer { op in
                    op.withMemoryRebound(to: DSPComplex.self) { vDSP_ztoc(&split, 1, $0.baseAddress!, 2, vDSP_Length(half)) }
                }
            }
        }
        return vDSP.multiply(1 / Float(size), out)
    }
}
