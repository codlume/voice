import AVFoundation
import Foundation
import Testing
import VoiceHelperCore
@testable import VoiceHelper

private let burstSeconds = 0.03
private let burstHertz: Float = 1000
private let extrapolatedSamples = 5

private struct NoiseEndingInToneBurst {
    let rate: Double
    let samples: [Float]

    init(rate: Double, seconds: Double = 1.04) {
        self.rate = rate
        let frames = Int(rate * seconds)
        let burstStart = frames - Int(rate * burstSeconds)
        var seed: UInt32 = 0x9E37_79B9
        samples = (0..<frames).map { i in
            if i >= burstStart { return 0.5 * sin(Float(i) * 2 * .pi * burstHertz / Float(rate)) }
            seed = seed &* 1_664_525 &+ 1_013_904_223
            return (Float(seed >> 8) / Float(1 << 24) - 0.5) * 0.02
        }
    }

    var expectedOutput: Int { Int((Double(samples.count) * 16_000 / rate).rounded()) }

    func format() throws -> AVAudioFormat {
        try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false))
    }

    func quanta(of size: Int) -> [Range<Int>] {
        stride(from: 0, to: samples.count, by: size).map { $0..<min($0 + size, samples.count) }
    }
}

private func planarBuffer(_ fixture: NoiseEndingInToneBurst, _ range: Range<Int>, format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(range.count)))
    buffer.frameLength = AVAudioFrameCount(range.count)
    let channels = try #require(buffer.floatChannelData)
    for (offset, index) in range.enumerated() {
        channels[0][offset] = fixture.samples[index]
        channels[1][offset] = 0
    }
    return buffer
}

private func feed(
    _ pipeline: MicPipeline, fixture: NoiseEndingInToneBurst, quanta: [Range<Int>], pullEvery: Int, onPull: () -> Void
) throws {
    let format = try fixture.format()
    let buffers = try quanta.map { try planarBuffer(fixture, $0, format: format) }
    let written = DispatchSemaphore(value: 0)
    let pulled = DispatchSemaphore(value: 0)
    let producer = Thread {
        for (index, buffer) in buffers.enumerated() {
            pipeline.receive(buffer.audioBufferList, frames: Int(buffer.frameLength))
            if (index + 1) % pullEvery == 0 {
                written.signal()
                pulled.wait()
            }
        }
        written.signal()
    }
    producer.start()
    for _ in stride(from: pullEvery, through: buffers.count, by: pullEvery) {
        written.wait()
        onPull()
        pulled.signal()
    }
    written.wait()
}

@Suite struct MicPipelineTests {
    @Test func intakeIsClosedUntilStarted() throws {
        let fixture = NoiseEndingInToneBurst(rate: 48_000, seconds: 0.2)
        let format = try fixture.format()
        let pipeline = try MicPipeline(hardware: format, pendingSeconds: 0.1)
        let buffer = try planarBuffer(fixture, 0..<4800, format: format)
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        pipeline.receive(buffer.audioBufferList, frames: 4800)

        #expect(pipeline.finish().count == 0)
        #expect(pipeline.droppedFrames == 0)

        pipeline.start()
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        #expect(abs(pipeline.finish().count - 1600) <= 1)
        #expect(pipeline.droppedFrames == 0)
    }

    @Test func closedIntakeIgnoresMalformedBuffers() throws {
        let fixture = NoiseEndingInToneBurst(rate: 48_000)
        let pipeline = try MicPipeline(hardware: fixture.format())
        var list = AudioBufferList(
            mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 0, mData: nil))
        pipeline.receive(&list, frames: 4800)

        #expect(pipeline.finish().count == 0)
        #expect(pipeline.droppedFrames == 0)
    }

    @Test func finishRejectsLaterFrames() throws {
        let fixture = NoiseEndingInToneBurst(rate: 48_000, seconds: 0.2)
        let format = try fixture.format()
        let pipeline = try MicPipeline(hardware: format, pendingSeconds: 0.1)
        let buffer = try planarBuffer(fixture, 0..<4800, format: format)
        pipeline.start()
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        #expect(abs(pipeline.finish().count - 1600) <= 1)

        pipeline.receive(buffer.audioBufferList, frames: 4800)
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        #expect(pipeline.pull().count == 0)
        #expect(pipeline.finish().count == 0)
        #expect(pipeline.droppedFrames == 0)

        pipeline.start()
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        #expect(abs(pipeline.finish().count - 1600) <= 1)
        #expect(pipeline.droppedFrames == 0)
    }

    @Test func discardRejectsLaterFrames() throws {
        let fixture = NoiseEndingInToneBurst(rate: 48_000, seconds: 0.2)
        let format = try fixture.format()
        let pipeline = try MicPipeline(hardware: format, pendingSeconds: 0.1)
        let buffer = try planarBuffer(fixture, 0..<4800, format: format)
        pipeline.start()
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        #expect(pipeline.pull().count > 0)
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        pipeline.discard()

        pipeline.receive(buffer.audioBufferList, frames: 4800)
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        #expect(pipeline.pull().count == 0)
        #expect(pipeline.finish().count == 0)
        #expect(pipeline.droppedFrames == 0)

        pipeline.start()
        pipeline.receive(buffer.audioBufferList, frames: 4800)
        #expect(abs(pipeline.finish().count - 1600) <= 1)
        #expect(pipeline.droppedFrames == 0)
    }

    @Test(arguments: [48_000.0, 44_100.0], [512, 4800])
    func finishKeepsTheWholeTailIncludingTheToneBurst(rate: Double, quantum: Int) throws {
        let fixture = NoiseEndingInToneBurst(rate: rate)
        let pipeline = try MicPipeline(hardware: fixture.format())
        pipeline.start()
        var output: [Float] = []
        try feed(pipeline, fixture: fixture, quanta: fixture.quanta(of: quantum), pullEvery: 3) {
            output += pipeline.pull()
        }
        output += pipeline.finish()

        #expect(abs(output.count - fixture.expectedOutput) <= 1, "got \(output.count), expected \(fixture.expectedOutput)")
        let burst = Int(burstSeconds * 16_000) - 2 * extrapolatedSamples
        let tail = rms(Array(output[(output.count - extrapolatedSamples - burst)..<(output.count - extrapolatedSamples)]))
        let floor = rms(Array(output[0..<8000]))
        #expect(tail > 0.3, "tone burst missing from the tail: rms \(tail)")
        #expect(tail > 10 * floor, "tail rms \(tail) is not well above the noise floor \(floor)")
    }

    @Test func startDiscardsFramesWrittenBeforeIt() throws {
        let fixture = NoiseEndingInToneBurst(rate: 48_000, seconds: 0.2)
        let format = try fixture.format()
        let pipeline = try MicPipeline(hardware: format)
        pipeline.start()
        let quanta = fixture.quanta(of: 4800)
        for range in quanta.dropLast() {
            let buffer = try planarBuffer(fixture, range, format: format)
            pipeline.receive(buffer.audioBufferList, frames: Int(buffer.frameLength))
        }
        pipeline.start()
        let last = try planarBuffer(fixture, quanta[quanta.count - 1], format: format)
        pipeline.receive(last.audioBufferList, frames: Int(last.frameLength))

        let output = pipeline.finish()
        #expect(abs(output.count - 1600) <= 1, "only the quantum after restart should remain, got \(output.count)")
    }

    @Test func fullPendingBufferDropsNewBlocksInsteadOfGrowing() throws {
        let fixture = NoiseEndingInToneBurst(rate: 48_000, seconds: 0.3)
        let format = try fixture.format()
        let pipeline = try MicPipeline(hardware: format, pendingSeconds: 0.2)
        pipeline.start()
        for range in fixture.quanta(of: 480) {
            let buffer = try planarBuffer(fixture, range, format: format)
            pipeline.receive(buffer.audioBufferList, frames: Int(buffer.frameLength))
        }

        let output = pipeline.finish()
        #expect(abs(output.count - 3200) <= 1, "0.2 s of 48 kHz frames is 3200 samples at 16 kHz, got \(output.count)")
        #expect(pipeline.droppedFrames == 4800, "the 0.1 s past capacity is counted as dropped")
        pipeline.discard()
        #expect(pipeline.droppedFrames == 0)
    }

    @Test func interleavedHardwareFormatIsRejected() throws {
        let interleaved = try #require(
            AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: true))
        #expect(throws: CaptureError.self) { try MicPipeline(hardware: interleaved) }
        let int16 = try #require(
            AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 1, interleaved: false))
        #expect(throws: CaptureError.self) { try MicPipeline(hardware: int16) }
    }
}
