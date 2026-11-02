import Accelerate
import Foundation

/// On laptop speakers the microphone hears the other side, and `system.pcm` holds exactly what
/// played. Before the speech model hears a mic window, the gate mutes each time-frequency cell
/// of it that the system audio explains. Echo never reaches the model, and the user's voice,
/// which fills other cells, survives talking over the other side; a gate on whole windows would
/// drop it there. The mic file itself is never changed.
///
/// It learns the echo path from the audio it is handed, with no adaptive filter: the lag
/// between the two captures, by cross-correlation, and how loud each frequency comes back, a
/// low quantile of mic-to-system power over the cells where system audio plays. A low quantile
/// stays near the echo's own level even when the user talks over much of the stretch. On
/// headphones that level is the room's noise, so the gate takes almost nothing. Where only
/// the other side played, the model gets silence rather than residue to make words of.
public enum EchoGate {
    /// Audio before a window that the gate reads to learn the echo path.
    public static let contextSamples = 8 * PcmFile.sampleRate
    /// How much later the mic may hear what system audio recorded. The built-in mic and
    /// speakers capture -50 to +300 ms apart; Bluetooth or USB speakers play a few hundred ms late.
    static let lagRange = -PcmFile.frames(milliseconds: 100)...PcmFile.frames(milliseconds: 600)
    static let frameSize = 512
    static let hop = frameSize / 2
    static let bins = frameSize / 2 + 1
    static let quantile: Float = 0.3
    /// The predicted echo is this many times what the quantile says, which covers its spread
    /// from frame to frame and the speakers' distortion, which no level predicts.
    static let overSubtraction: Float = 12
    /// The room keeps a sound ringing after it stops: 3 dB less every 16 ms hop.
    static let reverbDecay: Float = 0.5
    /// No echo comes back louder than it played. Without this bound, a user who talks through
    /// every moment the other side does would teach the gate that their voice is echo.
    static let loudestEcho: Float = 1
    /// System power in a bin below about -67 dBFS plays nothing worth learning from.
    static let audiblePower: Float = 1e-7 * Float(frameSize)

    /// Mic samples `offset..<offset + count` (fewer at the end of the file), gated against the
    /// same stretch of system audio. No system file leaves them as recorded.
    public static func read(mic: URL, system: URL, offset: Int, count: Int) throws -> [Float] {
        let start = max(0, offset - contextSamples)
        let heard = try PcmFile.read(at: mic, offset: start, count: offset - start + count)
        let played = (try? PcmFile.read(at: system, offset: start, count: heard.count)) ?? []
        return Array(gate(mic: heard, system: played).dropFirst(offset - start))
    }

    /// `mic` with what `system`, the same stretch of the meeting, explains muted.
    public static func gate(mic: [Float], system: [Float]) -> [Float] {
        guard !mic.isEmpty, !system.isEmpty, vDSP.maximumMagnitude(system) > 0 else { return mic }
        let played = Array(system.prefix(mic.count)) + [Float](repeating: 0, count: max(0, mic.count - system.count))
        let pad = [Float](repeating: 0, count: frameSize)
        let heard = Spectrogram(pad + mic + pad)
        let echo = Spectrogram(pad + shift(played, by: lag(mic: mic, system: played)) + pad)
        let frames = heard.frames
        let power = heard.power

        // The echo's power per cell: what played, still ringing from the frames before.
        var ringing = echo.power
        for t in 1..<frames {
            let now = t * bins..<(t + 1) * bins
            let still = vDSP.multiply(reverbDecay, ringing[now.lowerBound - bins..<now.lowerBound])
            let louder = vDSP.maximum(Array(ringing[now]), still)
            ringing.replaceSubrange(now, with: louder)
        }

        // Digital silence, where the meeting mic recorded nothing during a dictation, is not a
        // quiet room: it says nothing about the echo's level or the room's noise.
        let framePower = (0..<frames).map { vDSP.sum(power[$0 * bins..<($0 + 1) * bins]) }
        var audible = vDSP.threshold(ringing, to: audiblePower, with: .zeroFill)
        for t in 0..<frames where framePower[t] == 0 {
            audible.replaceSubrange(t * bins..<(t + 1) * bins, with: repeatElement(0, count: bins))
        }
        // How loud each bin comes back: mic over echo power, infinite where nothing audible played.
        let ratios = transposed(vDSP.divide(vDSP.add(1e-30, power), audible), rows: frames, columns: bins)
        let level = (0..<bins).map { f -> Float in
            var row = Array(ratios[f * frames..<(f + 1) * frames])
            vDSP.sort(&row, sortOrder: .ascending)
            var audible = 0
            var end = frames
            while audible < end {
                let middle = (audible + end) / 2
                if row[middle].isFinite { audible = middle + 1 } else { end = middle }
            }
            return audible == 0 ? 0 : min(loudestEcho, row[Int(Float(audible - 1) * quantile)])
        }
        // Smoothed across nine bins (280 Hz): the echo path has no sharp notches worth trusting.
        let smoothed = (0..<bins).map { f in
            level[max(0, f - 4)...min(bins - 1, f + 4)].reduce(0, +) / 9
        }

        let expected = vDSP.multiply(overSubtraction, smoothed)
        // The room's own noise: the quietest tenth of the frames, unless the user talks through
        // all of them, when it is what the chunker counts as quiet.
        let quiet = Float(frameSize * frameSize) / 4 * MeetingChunker.quietRms * MeetingChunker.quietRms
        let recorded = framePower.filter { $0 > 0 }.sorted()
        let roomNoise = recorded.isEmpty ? quiet : min(quiet, recorded[recorded.count / 10])
        let silence = [Float](repeating: 0, count: bins)
        var mask = [Float](repeating: 1, count: frames * bins)
        for t in 0..<frames {
            let cells = t * bins..<(t + 1) * bins
            let unexplained = vDSP.subtract([Float](repeating: 1, count: bins),
                                            vDSP.divide(vDSP.multiply(expected, ringing[cells]), vDSP.add(1e-30, power[cells])))
            let kept = vDSP.clip(unexplained, to: 0...1)
            // A frame the other side played into that keeps no more than twice the room's noise
            // goes silent: the speech model makes words of faint echo residue.
            let left = vDSP.sum(vDSP.multiply(vDSP.square(kept), power[cells]))
            let playing = vDSP.maximum(ringing[cells]) > audiblePower
            mask.replaceSubrange(cells, with: playing && left < 2 * roomNoise ? silence : kept)
        }
        return Array(heard.resynthesized(mask: mask)[frameSize..<frameSize + mic.count])
    }

    /// Samples by which the mic trails system audio: the peak of their phase-only
    /// cross-correlation within `lagRange`, summed over two-second blocks.
    static func lag(mic: [Float], system: [Float]) -> Int {
        let block = 1 << 15
        let fft = RealFFT(size: 2 * block)
        var crossRe = [Float](repeating: 0, count: block + 1)
        var crossIm = crossRe
        for start in stride(from: 0, to: mic.count, by: block) {
            let end = min(start + block, mic.count)
            let zeros = [Float](repeating: 0, count: 2 * block - (end - start))
            let m = fft.forward(Array(mic[start..<end]) + zeros)
            let s = fft.forward(Array(system[start..<end]) + zeros)
            crossRe = vDSP.add(crossRe, vDSP.add(vDSP.multiply(m.re, s.re), vDSP.multiply(m.im, s.im)))
            crossIm = vDSP.add(crossIm, vDSP.subtract(vDSP.multiply(m.im, s.re), vDSP.multiply(m.re, s.im)))
        }
        let magnitude = vDSP.add(1e-12, vForce.sqrt(vDSP.add(vDSP.square(crossRe), vDSP.square(crossIm))))
        let correlation = fft.inverse(re: vDSP.divide(crossRe, magnitude), im: vDSP.divide(crossIm, magnitude))
        // Negative lags wrap around to the end.
        let candidates = vDSP.absolute(Array(correlation.suffix(-lagRange.lowerBound) + correlation.prefix(lagRange.upperBound + 1)))
        return Int(vDSP.indexOfMaximum(candidates).0) + lagRange.lowerBound
    }

    private static func transposed(_ matrix: [Float], rows: Int, columns: Int) -> [Float] {
        var out = [Float](repeating: 0, count: matrix.count)
        vDSP_mtrans(matrix, 1, &out, 1, vDSP_Length(columns), vDSP_Length(rows))
        return out
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
        let count: Int
        let frames: Int
        let re: [Float]
        let im: [Float]
        private let fft = RealFFT(size: frameSize)

        init(_ samples: [Float]) {
            count = samples.count
            frames = (samples.count - frameSize) / hop + 1
            var re = [Float](repeating: 0, count: frames * bins)
            var im = re
            for t in 0..<frames {
                let spectrum = fft.forward(vDSP.multiply(Self.window, samples[t * hop..<t * hop + frameSize]))
                re.replaceSubrange(t * bins..<(t + 1) * bins, with: spectrum.re)
                im.replaceSubrange(t * bins..<(t + 1) * bins, with: spectrum.im)
            }
            self.re = re
            self.im = im
        }

        var power: [Float] {
            vDSP.add(vDSP.square(re), vDSP.square(im))
        }

        func resynthesized(mask: [Float]) -> [Float] {
            var out = [Float](repeating: 0, count: count)
            for t in 0..<frames {
                let cells = t * bins..<(t + 1) * bins
                let frame = fft.inverse(re: vDSP.multiply(re[cells], mask[cells]), im: vDSP.multiply(im[cells], mask[cells]))
                let span = t * hop..<t * hop + frameSize
                out.replaceSubrange(span, with: vDSP.add(out[span], vDSP.multiply(Self.window, frame)))
            }
            return out
        }
    }
}

/// A real FFT of `size` samples with numpy's scaling: `size / 2 + 1` bins, the inverse undoing
/// the forward exactly.
private struct RealFFT {
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
