import Accelerate
import Foundation

public func rms(_ samples: UnsafeBufferPointer<Float>) -> Float {
    guard !samples.isEmpty else { return 0 }
    return vDSP.rootMeanSquare(samples)
}

public func rms(_ samples: [Float]) -> Float {
    samples.withUnsafeBufferPointer(rms)
}

/// Maps RMS to a 0...1 meter on a dBFS scale: silence is 0, normal speech
/// (-30 dBFS) lands near 0.4, loud speech (-15 dBFS) near 0.7, full scale is 1.
public func perceptualLevel(rms: Float) -> Double {
    guard rms.isFinite, rms > 0 else { return 0 }
    let dBFS = 20 * log10(Double(max(rms, 1e-6)))
    return min(max(1 + dBFS / 50, 0), 1)
}
