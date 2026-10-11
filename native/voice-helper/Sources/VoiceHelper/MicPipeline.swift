import AVFoundation
import Foundation
import os

let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: asrSampleRate, channels: 1, interleaved: false)

final class MicPipeline {
    let hardware: AVAudioFormat
    private let mono: AVAudioFormat
    private let target: AVAudioFormat
    private let converter: AVAudioConverter
    private let capacity: Int
    private let pending: OSAllocatedUnfairLock<Pending>
    private var spare: [Float]
    private(set) var droppedFrames = 0

    init(hardware: AVAudioFormat, pendingSeconds: Double = 10) throws(CaptureError) {
        guard hardware.sampleRate > 0, hardware.channelCount > 0, hardware.commonFormat == .pcmFormatFloat32,
            !hardware.isInterleaved, let targetFormat,
            let mono = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: hardware.sampleRate, channels: 1, interleaved: false),
            let converter = AVAudioConverter(from: mono, to: targetFormat)
        else {
            throw CaptureError(reason: .device, message: "no usable audio input device")
        }
        self.hardware = hardware
        self.mono = mono
        self.target = targetFormat
        self.converter = converter
        capacity = Int(hardware.sampleRate * pendingSeconds)
        let touched = min(capacity, Int(hardware.sampleRate / 2))
        pending = OSAllocatedUnfairLock(initialState: Pending(frames: Self.buffer(capacity: capacity, touched: touched)))
        spare = Self.buffer(capacity: capacity, touched: touched)
    }

    /// IO thread. No allocation (both buffers are reserved on main), no logging, no dispatch.
    func receive(_ list: UnsafePointer<AudioBufferList>, frames: Int) {
        guard frames > 0 else { return }
        pending.withLockUnchecked { pending in
            guard pending.accepting else { return }
            guard list.pointee.mNumberBuffers >= 1, let data = list.pointee.mBuffers.mData,
                Int(list.pointee.mBuffers.mDataByteSize) >= frames * MemoryLayout<Float>.size
            else {
                pending.dropped += frames
                return
            }
            guard pending.frames.count + frames <= capacity else {
                pending.dropped += frames
                return
            }
            let channel = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: frames)
            pending.frames.append(contentsOf: channel)
        }
    }

    func start() {
        discard()
        pending.withLockUnchecked { $0.accepting = true }
    }

    func pull() -> [Float] {
        drain { $0.isEmpty ? [] : convert($0, endOfStream: false) }
    }

    func finish() -> [Float] {
        let tail = drain(closingIntake: true) { convert($0, endOfStream: true) }
        converter.reset()
        return tail
    }

    func discard() {
        drain(closingIntake: true) { _ in [] }
        converter.reset()
        droppedFrames = 0
    }

    /// Swaps the two buffers so the IO thread keeps writing into pages it has touched before, and hands
    /// the frames that arrived to `body` before the buffer is emptied for reuse.
    @discardableResult
    private func drain(closingIntake: Bool = false, _ body: ([Float]) -> [Float]) -> [Float] {
        var frames: [Float] = []
        swap(&frames, &spare)
        let dropped = pending.withLockUnchecked { pending in
            if closingIntake { pending.accepting = false }
            swap(&pending.frames, &frames)
            defer { pending.dropped = 0 }
            return pending.dropped
        }
        droppedFrames += dropped
        let converted = body(frames)
        frames.removeAll(keepingCapacity: true)
        swap(&frames, &spare)
        return converted
    }

    private func convert(_ frames: [Float], endOfStream: Bool) -> [Float] {
        guard let input = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(max(frames.count, 1)))
        else { return [] }
        input.frameLength = AVAudioFrameCount(frames.count)
        if let channel = input.floatChannelData?[0] {
            frames.withUnsafeBufferPointer { source in
                if let base = source.baseAddress { channel.update(from: base, count: frames.count) }
            }
        }
        return resample(input, with: converter, to: target, endOfStream: endOfStream) ?? []
    }

    /// Touches the first `touched` frames, which covers several pump periods, so steady capture
    /// never page-faults on the IO thread; only a long main-thread stall reaches fresh pages.
    private static func buffer(capacity: Int, touched: Int) -> [Float] {
        var buffer: [Float] = []
        buffer.reserveCapacity(capacity)
        buffer.append(contentsOf: repeatElement(0, count: touched))
        buffer.removeAll(keepingCapacity: true)
        return buffer
    }

    private struct Pending {
        var frames: [Float]
        var dropped = 0
        var accepting = false
    }
}

func resample(
    _ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat, endOfStream: Bool
) -> [Float]? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    // A larger output capacity makes the converter hold back more audio per call (68 ms at +1024),
    // so streaming converts stay at +16 and only the end-of-stream flush gets room for the tail.
    let slack: AVAudioFrameCount = endOfStream ? 4096 : 16
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + slack
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var consumed = buffer.frameLength == 0
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
        if consumed {
            status.pointee = endOfStream ? .endOfStream : .noDataNow
            return nil
        }
        consumed = true
        status.pointee = .haveData
        return buffer
    }
    guard error == nil, let channel = out.floatChannelData?[0] else { return nil }
    return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
}
