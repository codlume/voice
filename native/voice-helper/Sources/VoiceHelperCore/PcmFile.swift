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
        return data.withUnsafeBytes { raw in
            (0..<raw.count / bytesPerFrame).map { index in
                Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * bytesPerFrame, as: Int16.self))) / 32768
            }
        }
    }
}

public final class PcmWriter {
    private let handle: FileHandle
    private let syncEvery: Int
    private var unsynced = 0
    public private(set) var frames: Int

    /// Opens for appending, creating the file owner-only. `syncEvery` frames are flushed to disk
    /// at a time, so a power loss costs at most that much audio.
    public init(url: URL, syncEvery: Int = 5 * PcmFile.sampleRate) throws {
        if !FileManager.default.fileExists(atPath: url.path) {
            guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
            }
        }
        handle = try FileHandle(forWritingTo: url)
        let end = try handle.seekToEnd()
        // A crash mid-write can leave half a frame, which would shift every later sample.
        let whole = end - end % UInt64(PcmFile.bytesPerFrame)
        if whole != end { try handle.truncate(atOffset: whole) }
        frames = Int(whole) / PcmFile.bytesPerFrame
        self.syncEvery = syncEvery
    }

    public func append(_ samples: [Float]) throws {
        guard !samples.isEmpty else { return }
        var data = Data(count: samples.count * PcmFile.bytesPerFrame)
        data.withUnsafeMutableBytes { raw in
            for (index, sample) in samples.enumerated() {
                let value = Int16(max(-1, min(1, sample)) * 32767).littleEndian
                raw.storeBytes(of: value, toByteOffset: index * PcmFile.bytesPerFrame, as: Int16.self)
            }
        }
        try handle.write(contentsOf: data)
        frames += samples.count
        unsynced += samples.count
        if unsynced >= syncEvery {
            try handle.synchronize()
            unsynced = 0
        }
    }

    /// Appends silence up to `target` frames, which keeps the meeting's files on one timeline.
    public func pad(to target: Int) throws {
        guard target > frames else { return }
        try append([Float](repeating: 0, count: target - frames))
    }

    public func close() throws {
        defer { try? handle.close() }
        try handle.synchronize()
    }
}
