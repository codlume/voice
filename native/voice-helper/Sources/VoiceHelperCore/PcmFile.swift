import Accelerate
import Foundation

/// Meeting audio on disk: 16 kHz mono Int16 little-endian, no header, append-only, so a crash
/// leaves a readable prefix and frame n sits at byte 2n.
public enum PcmFile {
    public static let sampleRate = 16_000
    static let bytesPerFrame = 2

    public static func frames(at url: URL) -> Int {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? nil
        return (size ?? 0) / bytesPerFrame
    }

    public static func milliseconds(_ frames: Int) -> Double {
        Double(frames) * 1000 / Double(sampleRate)
    }

    public static func frames(milliseconds: Double) -> Int {
        Int((milliseconds * Double(sampleRate) / 1000).rounded())
    }

    /// Up to `count` frames from `offset`, fewer at the end of the file.
    public static func read(at url: URL, offset: Int, count: Int) throws -> [Float] {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset * bytesPerFrame))
        let data = try handle.read(upToCount: count * bytesPerFrame) ?? Data()
        // Every Mac is little-endian, as the file is.
        var frames = [Int16](repeating: 0, count: data.count / bytesPerFrame)
        _ = frames.withUnsafeMutableBytes { data.copyBytes(to: $0) }
        return vDSP.multiply(1 / 32768, vDSP.integerToFloatingPoint(frames, floatingPointType: Float.self))
    }
}

public final class PcmWriter {
    private let handle: FileHandle
    public private(set) var frames: Int

    public init(url: URL) throws {
        if !FileManager.default.fileExists(atPath: url.path) {
            guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
            }
        }
        handle = try FileHandle(forWritingTo: url)
        let end = try handle.seekToEnd()
        let whole = end - end % UInt64(PcmFile.bytesPerFrame)
        if whole != end { try handle.truncate(atOffset: whole) }
        frames = Int(whole) / PcmFile.bytesPerFrame
    }

    public func append(_ samples: [Float]) throws {
        guard !samples.isEmpty else { return }
        let scaled = vDSP.multiply(32767, vDSP.clip(samples, to: -1...1))
        // Every Mac is little-endian, as the file is.
        let pcm = vDSP.floatingPointToInteger(scaled, integerType: Int16.self, rounding: .towardZero)
        try handle.write(contentsOf: pcm.withUnsafeBytes { Data($0) })
        frames += samples.count
    }

    public func pad(to target: Int) throws {
        guard target > frames else { return }
        try append([Float](repeating: 0, count: target - frames))
    }

    /// Flushes what was appended to disk. Until then it survives the helper's crash, but not a
    /// power loss.
    public func synchronize() throws {
        try handle.synchronize()
    }

    public func close() throws {
        defer { try? handle.close() }
        try handle.synchronize()
    }
}
