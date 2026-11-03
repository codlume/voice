import Accelerate
import Foundation

/// On laptop speakers the microphone hears the other side, and `system.pcm` holds exactly what
/// played. Before the speech model hears a mic window, the gate mutes each time-frequency cell
/// of it that the system audio explains. Echo never reaches the model, and the user's voice,
/// which fills other cells, survives talking over the other side; a gate on whole windows would
/// drop it there. The mic file itself is never changed.
///
/// It learns the echo path from the audio it is handed. On headphones it finds no echo and
/// takes almost nothing. Where only the other side played, the model gets silence rather than
/// residue to make words of.
public enum EchoGate {
    /// Audio before a window that the gate reads to learn the echo path.
    public static let contextSamples = 8 * PcmFile.sampleRate
    /// How much later the mic may hear what system audio recorded. The built-in mic and
    /// speakers capture -50 to +300 ms apart; Bluetooth or USB speakers play a few hundred ms late.
    static let lagRange = -PcmFile.frames(milliseconds: 100)...PcmFile.frames(milliseconds: 600)
    static let frameSize = 512
    static let hop = frameSize / 2
    static let bins = frameSize / 2 + 1
    /// A low quantile of the mic-to-echo ratios stays near the echo's own level even when the
    /// user talks over much of the stretch.
    static let quantile: Float = 0.3
    /// The predicted echo is this many times what the quantile says, which covers its spread
    /// from frame to frame and the speakers' distortion, which no level predicts. On the meeting
    /// fixtures, 4 leaks echo once it comes back as loud as it played, and 12 takes the user's
    /// double-talk with it.
    static let overSubtraction: Float = 6
    /// The room keeps a sound ringing after it stops: 3 dB less every 16 ms hop.
    static let reverbDecay: Float = 0.5
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
            ringing.replaceSubrange(now, with: vDSP.maximum(Array(ringing[now]), still))
        }

        // Digital silence, where the meeting mic recorded nothing during a dictation, is not a
        // quiet room: it says nothing about the echo's level or the room's noise.
        let heardPerFrame = (0..<frames).map { vDSP.sum(power[$0 * bins..<($0 + 1) * bins]) }
        var audible = vDSP.threshold(echo.power, to: audiblePower, with: .zeroFill)
        for t in 0..<frames where heardPerFrame[t] == 0 {
            audible.replaceSubrange(t * bins..<(t + 1) * bins, with: repeatElement(0, count: bins))
        }
        let expected = overSubtraction * echoLevel(heard: power, audible: audible)

        // The room's own noise: the quietest tenth of the frames, unless the user talks through
        // all of them, when it is what the chunker counts as quiet.
        let quiet = framePower(rms: MeetingChunker.quietRms)
        let recorded = heardPerFrame.filter { $0 > 0 }.sorted()
        let roomNoise = recorded.isEmpty ? quiet : min(quiet, recorded[recorded.count / 10])

        var mask = vDSP.clip(vDSP.add(1, vDSP.divide(vDSP.multiply(-expected, ringing), vDSP.add(1e-30, power))), to: 0...1)
        let silence = [Float](repeating: 0, count: bins)
        for t in 0..<frames {
            let cells = t * bins..<(t + 1) * bins
            // A frame the other side played into that keeps no more than twice the room's noise
            // goes silent: the speech model makes words of faint echo residue.
            let left = vDSP.sum(vDSP.multiply(vDSP.square(mask[cells]), power[cells]))
            if vDSP.maximum(ringing[cells]) > audiblePower, left < 2 * roomNoise {
                mask.replaceSubrange(cells, with: silence)
            }
        }
        return Array(heard.resynthesized(mask: mask)[frameSize..<frameSize + mic.count])
    }

    /// How loud the echo comes back, learned from its direct power rather than its ringing: the
    /// modelled tail overstates an echo that decays faster, and a low quantile is drawn to those
    /// cells, more the louder the echo.
    static func echoLevel(heard: [Float], audible: [Float]) -> Float {
        let ratios = vDSP.divide(heard, audible).filter(\.isFinite).sorted()
        return ratios.isEmpty ? 0 : ratios[Int(Float(ratios.count - 1) * quantile)]
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
