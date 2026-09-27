import Testing
@testable import VoiceHelperCore

private enum DeviceError: Error { case unavailable }

private final class FakeOutputs: OutputControls {
    var values: [String: [OutputControl]] = [:]
    var connected: [String] = []
    var writes: [(String, OutputControl)] = []
    var discoveries = 0
    var failure: ((String, OutputControl) -> Bool)?

    func devices() throws -> [String] {
        discoveries += 1
        return connected
    }

    func snapshot(uid: String) throws -> [OutputControl] { values[uid] ?? [] }

    func write(uid: String, control: OutputControl) throws {
        guard connected.contains(uid) else { throw DeviceError.unavailable }
        writes.append((uid, control))
        guard let index = values[uid]?.firstIndex(where: { $0.silenced == control.silenced }) else {
            throw DeviceError.unavailable
        }
        values[uid]?[index] = control
        if failure?(uid, control) == true { throw DeviceError.unavailable }
    }
}

private let unmuted = OutputControl.mute(element: 0, value: 0)
private let muted = OutputControl.mute(element: 0, value: 1)

@Test func disabledOutputSuppressionDoesNotReadOrWriteDevices() {
    let outputs = FakeOutputs()
    let suppression = OutputSuppression(controls: outputs, onError: { _ in })
    suppression.end()
    #expect(outputs.discoveries == 0)
    #expect(outputs.writes.isEmpty)
    #expect(!suppression.needsDeviceListener)
}

@Test func outputSuppressionRestoresMultipleDevicesAndIndependentChannelVolumes() {
    let outputs = FakeOutputs()
    outputs.connected = ["speakers", "headphones", "muted"]
    outputs.values = ["speakers": [unmuted], "headphones": [.volume(element: 1, value: 0.3), .volume(element: 2, value: 0.7)], "muted": [muted]]
    let original = outputs.values
    let suppression = OutputSuppression(controls: outputs, onError: { _ in })
    suppression.begin()
    #expect(outputs.values["speakers"] == [muted])
    #expect(outputs.values["headphones"] == [.volume(element: 1, value: 0), .volume(element: 2, value: 0)])
    #expect(!outputs.writes.contains { $0.0 == "muted" })
    let count = outputs.writes.count
    suppression.begin()
    suppression.reconcile()
    #expect(outputs.writes.count == count)
    suppression.end()
    #expect(outputs.values == original)
    let restored = outputs.writes.count
    suppression.end()
    suppression.reconcile()
    #expect(outputs.writes.count == restored)
}

@Test func partialMuteFailureRollsBackEvenWhenTheDriverAppliedTheFailedWrite() {
    let outputs = FakeOutputs()
    outputs.connected = ["stereo"]
    outputs.values = ["stereo": [.volume(element: 1, value: 0.2), .volume(element: 2, value: 0.8)]]
    let original = outputs.values
    outputs.failure = { _, control in control == .volume(element: 2, value: 0) }
    var errors: [String] = []
    let suppression = OutputSuppression(controls: outputs, onError: { errors.append($0) })
    suppression.begin()
    #expect(outputs.values == original)
    #expect(errors.count == 1)
    suppression.end()
    #expect(!suppression.needsDeviceListener)
}

@Test func restorationFailureRetainsOriginalsAndDoesNotRepeatSuccessfulWrites() {
    let outputs = FakeOutputs()
    outputs.connected = ["a", "b"]
    outputs.values = ["a": [unmuted], "b": [unmuted]]
    let suppression = OutputSuppression(controls: outputs, onError: { _ in })
    suppression.begin()
    outputs.failure = { uid, control in uid == "a" && control == unmuted }
    suppression.end()
    #expect(suppression.needsDeviceListener)
    let countB = outputs.writes.filter { $0.0 == "b" }.count
    outputs.failure = nil
    suppression.end()
    #expect(!suppression.needsDeviceListener)
    #expect(outputs.values == ["a": [unmuted], "b": [unmuted]])
    #expect(outputs.writes.filter { $0.0 == "b" }.count == countB)
}

@Test func transientMuteFailureRetriesOnTheNextDeviceChange() {
    let outputs = FakeOutputs()
    outputs.connected = ["speakers"]
    outputs.values = ["speakers": [unmuted]]
    outputs.failure = { _, control in control == muted }
    let suppression = OutputSuppression(controls: outputs, onError: { _ in })
    suppression.begin()
    #expect(outputs.values["speakers"] == [unmuted])
    outputs.failure = nil
    suppression.reconcile()
    #expect(outputs.values["speakers"] == [muted])
    suppression.end()
    #expect(outputs.values["speakers"] == [unmuted])
}

@Test func newAndReconnectedOutputsAreSilencedWithoutReplacingTheirOriginalState() {
    let outputs = FakeOutputs()
    outputs.connected = ["a"]
    outputs.values = ["a": [unmuted]]
    let suppression = OutputSuppression(controls: outputs, onError: { _ in })
    suppression.begin()
    outputs.connected = ["b"]
    outputs.values["b"] = [.volume(element: 0, value: 0.45)]
    suppression.reconcile()
    #expect(outputs.values["b"] == [.volume(element: 0, value: 0)])
    outputs.connected = ["a", "b"]
    suppression.reconcile()
    suppression.end()
    #expect(outputs.values == ["a": [unmuted], "b": [.volume(element: 0, value: 0.45)]])
}

@Test func disconnectedOutputRestoresWhenItReturnsAfterCaptureEnds() {
    let outputs = FakeOutputs()
    outputs.connected = ["original"]
    outputs.values = ["original": [unmuted]]
    let suppression = OutputSuppression(controls: outputs, onError: { _ in })
    suppression.begin()
    outputs.connected = ["replacement"]
    outputs.values["replacement"] = [muted]
    suppression.end()
    #expect(suppression.needsDeviceListener)
    #expect(!outputs.writes.contains { $0.0 == "replacement" })
    outputs.connected = ["replacement", "original"]
    suppression.reconcile()
    #expect(outputs.values["original"] == [unmuted])
    #expect(outputs.values["replacement"] == [muted])
    #expect(!suppression.needsDeviceListener)
}

@Test func queuedReconciliationAfterEndCannotMuteNewDevices() {
    let outputs = FakeOutputs()
    outputs.connected = ["a"]
    outputs.values = ["a": [unmuted]]
    let suppression = OutputSuppression(controls: outputs, onError: { _ in })
    suppression.begin()
    suppression.end()
    outputs.connected.append("b")
    outputs.values["b"] = [unmuted]
    suppression.reconcile()
    #expect(outputs.values["b"] == [unmuted])
    #expect(!outputs.writes.contains { $0.0 == "b" })
}

@Test func nextCaptureSilencesAllChannelsWhilePreservingAFailedRestoration() {
    let outputs = FakeOutputs()
    outputs.connected = ["stereo"]
    let left = OutputControl.volume(element: 1, value: 0.2)
    let right = OutputControl.volume(element: 2, value: 0.8)
    outputs.values = ["stereo": [left, right]]
    let suppression = OutputSuppression(controls: outputs, onError: { _ in })
    suppression.begin()
    outputs.failure = { _, control in control == right }
    suppression.end()
    suppression.begin()
    #expect(outputs.values["stereo"] == [left.silenced, right.silenced])
    outputs.failure = nil
    suppression.end()
    #expect(outputs.values["stereo"] == [left, right])
}
