import Accelerate
import Foundation

public func rms(_ samples: [Float]) -> Float {
    samples.isEmpty ? 0 : vDSP.rootMeanSquare(samples)
}

private let meterFloorDBFS = -50.0

public func perceptualLevel(rms: Float) -> Double {
    guard rms.isFinite, rms > 0 else { return 0 }
    let dBFS = 20 * log10(Double(max(rms, 1e-6)))
    return min(max(1 - dBFS / meterFloorDBFS, 0), 1)
}
