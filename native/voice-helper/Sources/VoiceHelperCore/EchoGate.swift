import Accelerate
import Foundation

/// Mutes each time-frequency cell of mic audio that `system.pcm`, what played, explains, so the
/// other side's echo never reaches the speech model while the user's voice in other cells stays.
/// The mic file itself is never changed.
public enum EchoGate {
    /// Audio before a block that the gate reads to learn the echo path.
    public static let contextSamples = 8 * PcmFile.sampleRate
    static let lookaheadSamples = 3 * PcmFile.sampleRate
    static let newestSamples = 3 * PcmFile.sampleRate / 4
    static let blockSamples = MeetingChunker.windowSamples
    /// How much later the mic may hear what system audio recorded. The built-in mic and
    /// speakers capture -50 to +300 ms apart; Bluetooth or USB speakers play a few hundred ms late.
    static let lagRange = -PcmFile.frames(milliseconds: 100)...PcmFile.frames(milliseconds: 600)
    static let correlationBlock = 1 << 15
    static let unplayedPower: Float = 1e-3
    private static let fade = (0..<frameSize).map { 0.5 - 0.5 * cos(Float.pi * (Float($0) + 0.5) / Float(frameSize)) }
    static let clearPeak: Float = 16
    static let lagSlack = PcmFile.frames(milliseconds: 4)
    static let frameSize = 512
    static let hop = frameSize / 2
    static let bins = frameSize / 2 + 1
    static let quantile: Float = 0.3
    static let overSubtraction: Float = 6
    static let reverbDecay: Float = 0.5
    static let audiblePower: Float = 1e-7 * Float(frameSize)
    static let pathSamples = 1024
    /// The filter starts 2 ms ahead of the lag: the capture's own filters ring before the
    /// direct sound.
    static let pathLead = 32
    static let pathTolerance: Float = 1.6
    static let distortion: Float = 1 / 8
    static let voiceMargin: Float = 4
    static let voiceReach = 6
    private static let correlationFFT = RealFFT(size: 2 * correlationBlock)

    /// Mic samples `offset..<offset + count` (fewer at the end of the file), gated against the
    /// same stretch of system audio. No system file leaves them as recorded, and so does a block
    /// with no speech in it.
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
    /// `gated` is the mic from `offset` on, as `read` returned it. `heardEnd` is where both files
    /// ended before the gate read them.
    /// It correlates seconds of audio, so it never runs on main, where it would hold up the shortcut.
    public static func settled(_ gated: [Float], offset: Int, heardEnd: Int, mic: URL, system: URL) async throws -> Int {
        dispatchPrecondition(condition: .notOnQueue(.main))
        guard FileManager.default.fileExists(atPath: system.path) else { return gated.count }
        let runs = MeetingChunker.speechRuns(in: gated)
        func firstSound(inTheLast newest: Int) throws -> Int? {
            let unplaced = heardEnd - newest
            for run in runs where offset + run.upperBound > unplaced {
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
        let start = max(0, offset - contextSamples)
        let heard = try PcmFile.read(at: mic, offset: start, count: heardEnd - start)
        let lags = stretches(mic: heard, system: try PcmFile.read(at: system, offset: start, count: heard.count))
        let moved = lags.count > 1 && heard.count - lags.last!.range.lowerBound < lookaheadSamples + correlationBlock
        return try moved ? sound : firstSound(inTheLast: newestSamples) ?? gated.count
    }

    /// `mic` with what `system`, the same stretch of the meeting, explains muted.
    public static func gate(mic: [Float], system: [Float]) -> [Float] {
        guard !mic.isEmpty, !system.isEmpty, vDSP.maximumMagnitude(system) > 0 else { return mic }
        let played = Array(system.prefix(mic.count)) + [Float](repeating: 0, count: max(0, mic.count - system.count))
        let stretches = stretches(mic: mic, system: played)
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
        for move in moves {
            let torn = max(0, move.lowerBound - frameSize)..<min(out.count, move.upperBound + frameSize)
            out.replaceSubrange(torn, with: repeatElement(0, count: torn.count))
        }
        return out
    }

    static func gate(mic: [Float], played: [Float], range: Range<Int>, lag: Int) -> [Float] {
        let mic = Array(mic[range])
        let pad = [Float](repeating: 0, count: frameSize)
        let heard = Spectrogram(pad + mic + pad)
        let frames = heard.frames
        let power = heard.power

        let heardPerFrame = (0..<frames).map { vDSP.sum(power[$0 * bins..<($0 + 1) * bins]) }
        func levelHeard(of echo: Spectrogram) -> Float {
            var audible = vDSP.threshold(echo.power, to: audiblePower, with: .zeroFill)
            for t in 0..<frames where heardPerFrame[t] == 0 {
                audible.replaceSubrange(t * bins..<(t + 1) * bins, with: repeatElement(0, count: bins))
            }
            return echoLevel(heard: power, audible: audible)
        }

        let ahead = Array(shift(played, by: lag - pathLead)[range])
        var echo = Spectrogram(pad + filtered(ahead, through: echoPath(from: ahead, to: mic)) + pad)
        var level = levelHeard(of: echo)
        let pathHolds = (1 / pathTolerance...pathTolerance).contains(level)
        if !pathHolds {
            echo = Spectrogram(pad + Array(shift(played, by: lag)[range]) + pad)
            level = levelHeard(of: echo)
        }

        var ringing = echo.power
        for t in 1..<frames {
            let now = t * bins..<(t + 1) * bins
            let still = vDSP.multiply(reverbDecay, ringing[now.lowerBound - bins..<now.lowerBound])
            ringing.replaceSubrange(now, with: vDSP.maximum(Array(ringing[now]), still))
        }

        let quiet = framePower(rms: MeetingChunker.quietRms)
        let recorded = heardPerFrame.filter { $0 > 0 }.sorted()
        let roomNoise = recorded.isEmpty ? quiet : min(quiet, recorded[recorded.count / 10])

        let left = pathHolds ? heard.minus(echo) : heard
        let leftPower = pathHolds ? left.power : power
        var mask = vDSP.clip(vDSP.add(1, vDSP.divide(vDSP.multiply(-overSubtraction * level, ringing), vDSP.add(1e-30, power))), to: 0...1)
        let kept = (0..<frames).map { t in
            vDSP.sum(vDSP.multiply(vDSP.square(mask[t * bins..<(t + 1) * bins]), leftPower[t * bins..<(t + 1) * bins]))
        }
        let residue = (0..<frames).map { pathHolds ? distortion * level * vDSP.sum(ringing[$0 * bins..<($0 + 1) * bins]) : 0 }
        let silence = [Float](repeating: 0, count: bins)
        let noiseFloor = 2 * roomNoise
        func holdsAVoice(_ frame: Int, heardOver residueOf: Int) -> Bool {
            kept[frame] >= max(voiceMargin * max(noiseFloor, residue[frame]), residue[residueOf])
        }
        for t in 0..<frames where vDSP.maximum(ringing[t * bins..<(t + 1) * bins]) > audiblePower {
            let besideAVoice = (max(0, t - voiceReach)...min(frames - 1, t + voiceReach)).contains { holdsAVoice($0, heardOver: t) }
            if kept[t] < (besideAVoice ? noiseFloor : max(noiseFloor, residue[t])) {
                mask.replaceSubrange(t * bins..<(t + 1) * bins, with: silence)
            }
        }
        return Array(left.resynthesized(mask: mask)[frameSize..<frameSize + mic.count])
    }

    static func echoLevel(heard: [Float], audible: [Float]) -> Float {
        var ratios = vDSP.compress(vDSP.divide(heard, audible), gatingVector: audible, nonZeroGatingCount: nil)
        guard !ratios.isEmpty else { return 0 }
        vDSP.sort(&ratios, sortOrder: .ascending)
        return ratios[Int(Float(ratios.count - 1) * quantile)]
    }

    static func framePower(rms: Float) -> Float {
        let windowEnergy = Float(frameSize) / 2
        let oneSidedSpectrumGain = Float(frameSize) / 2
        return windowEnergy * oneSidedSpectrumGain * rms * rms
    }

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

    static func lag(_ spectra: Spectra) -> Int {
        Int(vDSP.indexOfMaximum(correlation(spectra)).0) + lagRange.lowerBound
    }

    static func correlation(_ spectra: Spectra) -> [Float] {
        let (crossRe, crossIm, power) = spectra
        let magnitude = vDSP.add(1e-12, vForce.sqrt(vDSP.add(vDSP.square(crossRe), vDSP.square(crossIm))))
        let played = vDSP.add(0.5, vDSP.threshold(power, to: unplayedPower * vDSP.mean(power), with: .signedConstant(0.5)))
        let phase = vDSP.divide(played, magnitude)
        let correlation = correlationFFT.inverse(re: vDSP.multiply(crossRe, phase), im: vDSP.multiply(crossIm, phase))
        // Negative lags wrap around to the end.
        return vDSP.absolute(Array(correlation.suffix(-lagRange.lowerBound) + correlation.prefix(lagRange.upperBound + 1)))
    }

    static func spectra(mic: [Float], system: [Float]) -> Spectra {
        sum(blockSpectra(mic: mic, system: system)[...])
    }

    static func sum(_ blocks: ArraySlice<Spectra>) -> Spectra {
        blocks.dropFirst().reduce(blocks.first!) {
            (vDSP.add($0.crossRe, $1.crossRe), vDSP.add($0.crossIm, $1.crossIm), vDSP.add($0.power, $1.power))
        }
    }

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

    static func echoPath(from played: [Float], to mic: [Float]) -> [Float] {
        var played = played
        for start in stride(from: 0, to: mic.count, by: hop) {
            let span = start..<min(start + hop, mic.count)
            if vDSP.maximumMagnitude(mic[span]) == 0 { played.replaceSubrange(span, with: repeatElement(0, count: span.count)) }
        }
        let (crossRe, crossIm, power) = spectra(mic: mic, system: played)
        let withMic = correlationFFT.inverse(re: crossRe, im: crossIm)
        var withItself = vDSP.floatToDouble(correlationFFT.inverse(re: power, im: [Float](repeating: 0, count: power.count)).prefix(pathSamples))
        guard withItself[0] > 0 else { return [Float](repeating: 0, count: pathSamples) }
        withItself[0] *= 1.001
        return vDSP.doubleToFloat(solve(toeplitz: withItself, vDSP.floatToDouble(withMic.prefix(pathSamples))))
    }

    static func solve(toeplitz r: [Double], _ y: [Double]) -> [Double] {
        let backwards = Array(r.reversed())
        var forward = [1 / r[0]]
        var backward = forward
        var x = [y[0] / r[0]]
        for n in 1..<y.count {
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
            let span = start..<start + 2 * block
            out.replaceSubrange(span, with: vDSP.add(out[span], through))
        }
        return Array(out.prefix(samples.count))
    }

    static func shift(_ samples: [Float], by lag: Int) -> [Float] {
        let silence = [Float](repeating: 0, count: min(abs(lag), samples.count))
        return lag >= 0 ? silence + samples.dropLast(silence.count) : samples.dropFirst(silence.count) + silence
    }

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

/// Safe to share: the setup is read-only once built, and a transform writes only into its
/// caller's buffers.
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
