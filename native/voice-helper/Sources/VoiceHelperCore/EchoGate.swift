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
    /// A long stretch is gated one live window at a time, each with its own lag: a Bluetooth
    /// reconnect or clock drift moves the lag mid-call.
    static let blockSamples = MeetingChunker.windowSamples
    /// How much later the mic may hear what system audio recorded. The built-in mic and
    /// speakers capture -50 to +300 ms apart; Bluetooth or USB speakers play a few hundred ms late.
    static let lagRange = -PcmFile.frames(milliseconds: 100)...PcmFile.frames(milliseconds: 600)
    static let correlationBlock = 1 << 15
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
        var out: [Float] = []
        for at in stride(from: offset, to: end, by: blockSamples) {
            let start = max(0, at - contextSamples)
            let heard = try PcmFile.read(at: mic, offset: start, count: min(at + blockSamples, end) - start)
            let block = Array(heard.dropFirst(at - start))
            guard hasSystem, MeetingChunker.speech(in: block) != nil else {
                out += block
                continue
            }
            out += gate(mic: heard, system: try PcmFile.read(at: system, offset: start, count: heard.count)).dropFirst(at - start)
        }
        return out
    }

    /// `mic` with what `system`, the same stretch of the meeting, explains muted.
    public static func gate(mic: [Float], system: [Float]) -> [Float] {
        guard !mic.isEmpty, !system.isEmpty, vDSP.maximumMagnitude(system) > 0 else { return mic }
        let played = Array(system.prefix(mic.count)) + [Float](repeating: 0, count: max(0, mic.count - system.count))
        let pad = [Float](repeating: 0, count: frameSize)
        let lag = lag(mic: mic, system: played)
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
        let ahead = shift(played, by: lag - pathLead)
        var echo = Spectrogram(pad + filtered(ahead, through: echoPath(from: ahead, to: mic)) + pad)
        var level = levelHeard(of: echo)
        let pathHolds = (1 / pathTolerance...pathTolerance).contains(level)
        if !pathHolds {
            echo = Spectrogram(pad + shift(played, by: lag) + pad)
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
            // of a word costs the word.
            let voiceNear = (max(0, t - voiceReach)...min(frames - 1, t + voiceReach)).contains {
                kept[$0] >= voiceMargin * max(2 * roomNoise, residue[$0])
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

    /// Samples by which the mic trails system audio: the peak of their phase-only
    /// cross-correlation within `lagRange`, summed over two-second blocks.
    static func lag(mic: [Float], system: [Float]) -> Int {
        let (crossRe, crossIm, _) = spectra(mic: mic, system: system)
        let magnitude = vDSP.add(1e-12, vForce.sqrt(vDSP.add(vDSP.square(crossRe), vDSP.square(crossIm))))
        let correlation = correlationFFT.inverse(re: vDSP.divide(crossRe, magnitude), im: vDSP.divide(crossIm, magnitude))
        // Negative lags wrap around to the end.
        let candidates = vDSP.absolute(Array(correlation.suffix(-lagRange.lowerBound) + correlation.prefix(lagRange.upperBound + 1)))
        return Int(vDSP.indexOfMaximum(candidates).0) + lagRange.lowerBound
    }

    /// The mic's cross-spectrum with system audio and system audio's own power spectrum, summed
    /// over two-second blocks.
    static func spectra(mic: [Float], system: [Float]) -> (crossRe: [Float], crossIm: [Float], power: [Float]) {
        let block = correlationBlock
        var crossRe = [Float](repeating: 0, count: block + 1)
        var crossIm = crossRe
        var power = crossRe
        for start in stride(from: 0, to: mic.count, by: block) {
            let end = min(start + block, mic.count)
            let zeros = [Float](repeating: 0, count: 2 * block - (end - start))
            let m = correlationFFT.forward(Array(mic[start..<end]) + zeros)
            let s = correlationFFT.forward(Array(system[start..<end]) + zeros)
            crossRe = vDSP.add(crossRe, vDSP.add(vDSP.multiply(m.re, s.re), vDSP.multiply(m.im, s.im)))
            crossIm = vDSP.add(crossIm, vDSP.subtract(vDSP.multiply(m.im, s.re), vDSP.multiply(m.re, s.im)))
            power = vDSP.add(power, vDSP.add(vDSP.square(s.re), vDSP.square(s.im)))
        }
        return (crossRe, crossIm, power)
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
