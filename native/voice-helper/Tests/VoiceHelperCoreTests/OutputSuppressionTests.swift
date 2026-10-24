import Testing
@testable import VoiceHelperCore

private enum DeviceError: Error { case unavailable }
private enum StoreError: Error { case full, unreadable }

private final class FakeOutputs: OutputControls {
    var values: [String: [OutputControl]] = [:]
    var connected: [String] = []
    var writes: [(String, OutputControl)] = []
    var discoveries = 0
    var failure: ((String, OutputControl) -> Bool)?
    var beforeWrite: ((String, OutputControl) -> Void)?

    init(values: [String: [OutputControl]] = [:], connected: [String]? = nil) {
        self.values = values
        self.connected = connected ?? Array(values.keys)
    }

    func devices() throws -> [String] {
        discoveries += 1
        return connected
    }

    func snapshot(uid: String) throws -> [OutputControl] {
        guard connected.contains(uid) else { throw DeviceError.unavailable }
        return values[uid] ?? []
    }

    func write(uid: String, control: OutputControl) throws {
        guard connected.contains(uid) else { throw DeviceError.unavailable }
        beforeWrite?(uid, control)
        writes.append((uid, control))
        guard let index = values[uid]?.firstIndex(where: { $0.id == control.id }) else {
            throw DeviceError.unavailable
        }
        values[uid]?[index] = control
        if failure?(uid, control) == true { throw DeviceError.unavailable }
    }
}

private final class MemoryOriginalsStore: OutputOriginalsStore {
    var saved: [String: [OutputControl]]
    var saves = 0
    var failing = false
    var loadFailing = false

    init(_ saved: [String: [OutputControl]] = [:]) { self.saved = saved }

    func load() throws -> [String: [OutputControl]] {
        if loadFailing { throw StoreError.unreadable }
        return saved
    }

    func save(_ originals: [String: [OutputControl]]) throws {
        saves += 1
        if failing { throw StoreError.full }
        saved = originals
    }
}

private let unmuted = OutputControl.mute(element: 0, value: 0)
private let muted = OutputControl.mute(element: 0, value: 1)
private let left = OutputControl.volume(element: 1, value: 0.3)
private let right = OutputControl.volume(element: 2, value: 0.7)

private enum RecoveryRetry: CaseIterable {
    case begin, end, deviceAfterBegin, deviceAfterEnd
}

@Test(arguments: RecoveryRetry.allCases)
private func unreadCrashRecordBlocksWritesUntilRecoveryCanRetry(retry: RecoveryRetry) {
    let originals = ["crashed": [unmuted]]
    let store = MemoryOriginalsStore(originals)
    store.loadFailing = true
    let outputs = FakeOutputs(values: ["crashed": [muted]])
    var errors: [String] = []
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { errors.append($0) })
    #expect(suppression.needsDeviceListener)
    suppression.begin(scale: 0)
    outputs.connected.append("new")
    outputs.values["new"] = [left, right]
    suppression.begin(scale: 0)
    suppression.reconcile()
    if retry == .end || retry == .deviceAfterEnd { suppression.end() }

    #expect(outputs.writes.isEmpty)
    #expect(outputs.values == ["crashed": [muted], "new": [left, right]])
    #expect(store.saves == 0)
    #expect(store.saved == originals)
    #expect(suppression.needsDeviceListener)
    #expect(!errors.isEmpty)

    store.loadFailing = false
    switch retry {
    case .begin: suppression.begin(scale: 0)
    case .end: suppression.end()
    case .deviceAfterBegin, .deviceAfterEnd: suppression.reconcile()
    }
    #expect(outputs.writes.first?.0 == "crashed")
    #expect(outputs.writes.first?.1 == unmuted)
    if retry == .begin || retry == .deviceAfterBegin {
        #expect(outputs.values == ["crashed": [muted], "new": [.volume(element: 1, value: 0), .volume(element: 2, value: 0)]])
        #expect(store.saved == ["crashed": [unmuted], "new": [left, right]])
        suppression.end()
    } else {
        #expect(outputs.writes.count == 1)
    }
    #expect(outputs.values == ["crashed": [unmuted], "new": [left, right]])
    #expect(store.saved.isEmpty)
    #expect(!suppression.needsDeviceListener)
}

@Test func disabledOutputSuppressionDoesNotReadOrWriteDevices() {
    let outputs = FakeOutputs()
    let store = MemoryOriginalsStore()
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.end()
    #expect(outputs.discoveries == 0)
    #expect(outputs.writes.isEmpty)
    #expect(store.saves == 0)
    #expect(!suppression.needsDeviceListener)
}

@Test func outputSuppressionRestoresMultipleDevicesAndIndependentChannelVolumes() {
    let outputs = FakeOutputs(values: ["speakers": [unmuted], "headphones": [left, right], "muted": [muted]])
    let original = outputs.values
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0)
    #expect(outputs.values["speakers"] == [muted])
    #expect(outputs.values["headphones"] == [.volume(element: 1, value: 0), .volume(element: 2, value: 0)])
    #expect(!outputs.writes.contains { $0.0 == "muted" })
    let count = outputs.writes.count
    suppression.begin(scale: 0)
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
    let outputs = FakeOutputs(values: ["stereo": [.volume(element: 1, value: 0.2), .volume(element: 2, value: 0.8)]])
    let original = outputs.values
    outputs.failure = { _, control in control == .volume(element: 2, value: 0) }
    var errors: [String] = []
    let store = MemoryOriginalsStore()
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { errors.append($0) })
    suppression.begin(scale: 0)
    #expect(outputs.values == original)
    #expect(errors.count == 1)
    suppression.end()
    #expect(!suppression.needsDeviceListener)
    #expect(store.saved.isEmpty)
}

@Test func restorationFailureRetainsOriginalsAndDoesNotRepeatSuccessfulWrites() {
    let outputs = FakeOutputs(values: ["a": [unmuted], "b": [unmuted]])
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0)
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
    let outputs = FakeOutputs(values: ["speakers": [unmuted]])
    outputs.failure = { _, control in control == muted }
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0)
    #expect(outputs.values["speakers"] == [unmuted])
    outputs.failure = nil
    suppression.reconcile()
    #expect(outputs.values["speakers"] == [muted])
    suppression.end()
    #expect(outputs.values["speakers"] == [unmuted])
}

@Test func newAndReconnectedOutputsAreSilencedWithoutReplacingTheirOriginalState() {
    let outputs = FakeOutputs(values: ["a": [unmuted], "c": [.volume(element: 0, value: 0.45)]])
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0)
    outputs.connected = ["b"]
    outputs.values["b"] = [.volume(element: 0, value: 0.45)]
    suppression.reconcile()
    #expect(outputs.values["b"] == [.volume(element: 0, value: 0)])
    outputs.values["c"] = [.volume(element: 0, value: 0.9)]
    outputs.connected = ["a", "b", "c"]
    suppression.reconcile()
    #expect(outputs.values["c"] == [.volume(element: 0, value: 0)])
    suppression.end()
    #expect(outputs.values == ["a": [unmuted], "b": [.volume(element: 0, value: 0.45)], "c": [.volume(element: 0, value: 0.9)]])
}

@Test func disconnectedOutputRestoresWhenItReturnsAfterCaptureEnds() {
    let outputs = FakeOutputs(values: ["original": [unmuted]])
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0)
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
    let outputs = FakeOutputs(values: ["a": [unmuted]])
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0)
    suppression.end()
    outputs.connected.append("b")
    outputs.values["b"] = [unmuted]
    suppression.reconcile()
    #expect(outputs.values["b"] == [unmuted])
    #expect(!outputs.writes.contains { $0.0 == "b" })
}

@Test func nextCaptureSilencesAllChannelsWhilePreservingAFailedRestoration() {
    let left = OutputControl.volume(element: 1, value: 0.2)
    let right = OutputControl.volume(element: 2, value: 0.8)
    let outputs = FakeOutputs(values: ["stereo": [left, right]])
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0)
    outputs.failure = { _, control in control == right }
    suppression.end()
    suppression.begin(scale: 0)
    #expect(outputs.values["stereo"] == [.volume(element: 1, value: 0), .volume(element: 2, value: 0)])
    outputs.failure = nil
    suppression.end()
    #expect(outputs.values["stereo"] == [left, right])
}

@Test func replacementInstanceRestoresWhatADroppedInstanceSilenced() {
    let outputs = FakeOutputs(values: ["speakers": [unmuted], "headphones": [left, right]])
    let original = outputs.values
    let store = MemoryOriginalsStore()
    let crashed = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    crashed.begin(scale: 0)
    #expect(outputs.values["speakers"] == [muted])
    #expect(store.saved == original)
    let replacement = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    replacement.end()
    #expect(outputs.values == original)
    #expect(store.saved.isEmpty)
    #expect(!replacement.needsDeviceListener)
}

@Test func recoveryFromAKillAtEveryWriteInstantRestoresTheOriginals() {
    let outputs = FakeOutputs(values: ["speakers": [unmuted], "headphones": [left, right]])
    let original = outputs.values
    let store = MemoryOriginalsStore()
    var instants: [(values: [String: [OutputControl]], record: [String: [OutputControl]])] = []
    outputs.beforeWrite = { _, _ in instants.append((outputs.values, store.saved)) }
    let crashed = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    crashed.begin(scale: 0)
    crashed.end()
    instants.append((outputs.values, store.saved))
    #expect(instants.count == 7)
    #expect(instants[0].record == original, "the record is complete before the first write")

    for (index, instant) in instants.enumerated() {
        let world = FakeOutputs(values: instant.values)
        let record = MemoryOriginalsStore(instant.record)
        var errors: [String] = []
        let replacement = OutputSuppression(controls: world, store: record, onError: { errors.append($0) })
        replacement.end()
        #expect(world.values == original, "instant \(index)")
        #expect(record.saved.isEmpty, "instant \(index)")
        #expect(errors.isEmpty, "instant \(index)")
        #expect(!replacement.needsDeviceListener, "instant \(index)")
        let writes = world.writes.count
        OutputSuppression(controls: world, store: record, onError: { _ in }).end()
        #expect(world.writes.count == writes, "instant \(index): a second replacement writes nothing")
    }
}

@Test func recordIsSavedBeforeTheFirstWriteToEachDevice() {
    let outputs = FakeOutputs(values: ["speakers": [unmuted], "headphones": [left, right]])
    let store = MemoryOriginalsStore()
    outputs.beforeWrite = { uid, control in
        #expect(store.saved[uid]?.contains { $0.id == control.id } == true, "\(uid) \(control)")
    }
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.begin(scale: 0)
    #expect(outputs.writes.count == 3)
    #expect(store.saves == 1, "one write-ahead save per reconcile, not per device")
}

@Test func restoreAfterCrashIsIdempotent() {
    let outputs = FakeOutputs(values: ["speakers": [unmuted], "headphones": [left, right]])
    let original = outputs.values
    let store = MemoryOriginalsStore()
    OutputSuppression(controls: outputs, store: store, onError: { _ in }).begin(scale: 0)
    let replacement = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    replacement.end()
    #expect(outputs.values == original)
    let writes = outputs.writes.count
    replacement.end()
    #expect(outputs.writes.count == writes)
    OutputSuppression(controls: outputs, store: store, onError: { _ in }).end()
    #expect(outputs.writes.count == writes)

    let clean = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    clean.begin(scale: 0)
    clean.end()
    let afterClean = outputs.writes.count
    OutputSuppression(controls: outputs, store: store, onError: { _ in }).end()
    #expect(outputs.writes.count == afterClean)
    #expect(outputs.values == original)
    #expect(store.saved.isEmpty)
}

@Test func restoreAfterCrashLeavesAValueTheUserChanged() {
    let store = MemoryOriginalsStore(["speakers": [unmuted], "stereo": [.volume(element: 1, value: 0.2), .volume(element: 2, value: 0.8)]])
    let outputs = FakeOutputs(values: ["speakers": [unmuted], "stereo": [.volume(element: 1, value: 0.5), .volume(element: 2, value: 0)]])
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.end()
    #expect(outputs.values == ["speakers": [unmuted], "stereo": [.volume(element: 1, value: 0.5), .volume(element: 2, value: 0.8)]])
    #expect(outputs.writes.map { $0.0 } == ["stereo"])
    #expect(store.saved.isEmpty)
    #expect(!suppression.needsDeviceListener)
}

@Test func crashAfterPartialWritesRestoresOnlyWhatWasSilenced() {
    let store = MemoryOriginalsStore(["stereo": [left, right]])
    let outputs = FakeOutputs(values: ["stereo": [.volume(element: 1, value: 0), right]])
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.end()
    #expect(outputs.values == ["stereo": [left, right]])
    #expect(outputs.writes.count == 1)
    #expect(store.saved.isEmpty)
}

@Test func recoveryOfAnUnreachableDeviceWaitsForItAndStillComparesFirst() {
    for userUnmutedWhileUnplugged in [false, true] {
        let store = MemoryOriginalsStore(["dock": [unmuted]])
        let outputs = FakeOutputs(values: ["dock": [muted]], connected: [])
        let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
        suppression.end()
        #expect(outputs.writes.isEmpty)
        #expect(store.saved == ["dock": [unmuted]])
        #expect(suppression.needsDeviceListener)

        if userUnmutedWhileUnplugged { outputs.values["dock"] = [unmuted] }
        outputs.connected = ["dock"]
        suppression.reconcile()
        #expect(outputs.values["dock"] == [unmuted])
        #expect(outputs.writes.count == (userUnmutedWhileUnplugged ? 0 : 1))
        #expect(store.saved.isEmpty)
        #expect(!suppression.needsDeviceListener)
    }
}

@Test func outputsStayAudibleWhenTheRecordCannotBeSaved() {
    let outputs = FakeOutputs(values: ["speakers": [unmuted], "headphones": [left, right]])
    let original = outputs.values
    let store = MemoryOriginalsStore()
    store.failing = true
    var errors: [String] = []
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { errors.append($0) })
    suppression.begin(scale: 0)
    #expect(outputs.writes.isEmpty)
    #expect(outputs.values == original)
    #expect(errors.count == 1)
    #expect(store.saved.isEmpty)
    store.failing = false
    suppression.reconcile()
    #expect(outputs.values["speakers"] == [muted], "the next device change retries")
    suppression.end()
    #expect(outputs.values == original)
    #expect(!suppression.needsDeviceListener)
}

@Test func recoveryRestoresOnlyOutputsStillBelowTheirOriginal() {
    let store = MemoryOriginalsStore([
        "speakers": [.volume(element: 0, value: 0.6)],
        "headphones": [.volume(element: 0, value: 0.6)],
        "dock": [.volume(element: 0, value: 0.6)],
    ])
    let outputs = FakeOutputs(values: [
        "speakers": [.volume(element: 0, value: 0.06)],
        "headphones": [.volume(element: 0, value: 0.6)],
        "dock": [.volume(element: 0, value: 0.9)],
    ])
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.end()
    #expect(outputs.values == [
        "speakers": [.volume(element: 0, value: 0.6)],
        "headphones": [.volume(element: 0, value: 0.6)],
        "dock": [.volume(element: 0, value: 0.9)],
    ])
    #expect(outputs.writes.map { $0.0 } == ["speakers"])
    #expect(store.saved.isEmpty)
}

@Test func anOriginalWhoseControlIsMissingFromTheSnapshotWaitsForIt() {
    let outputs = FakeOutputs(values: ["speakers": [unmuted]])
    let store = MemoryOriginalsStore()
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.begin(scale: 0)
    outputs.values["speakers"] = [.volume(element: 0, value: 0.5)]
    suppression.end()
    #expect(store.saved == ["speakers": [unmuted]], "a mute group that is not settable right now keeps its original")
    #expect(suppression.needsDeviceListener)
    suppression.begin(scale: 0)
    suppression.end()
    #expect(store.saved["speakers"]?.contains(unmuted) == true, "a session on the volume group keeps the held mute original")
    outputs.values["speakers"] = [muted]
    suppression.reconcile()
    #expect(outputs.values["speakers"] == [unmuted])
    #expect(store.saved.isEmpty)
    #expect(!suppression.needsDeviceListener)
}

@Test func loweringKeepsAFractionOfEveryChannelAndRestoresIt() {
    let outputs = FakeOutputs(values: ["headphones": [unmuted, left, right]])
    let store = MemoryOriginalsStore()
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.begin(scale: 0.5)
    #expect(outputs.values["headphones"] == [unmuted, .volume(element: 1, value: 0.15), .volume(element: 2, value: 0.35)])
    #expect(store.saved == ["headphones": [left, right]])
    suppression.end()
    #expect(outputs.values["headphones"] == [unmuted, left, right])
    #expect(store.saved.isEmpty)
    #expect(!suppression.needsDeviceListener)
}

@Test func endKeepsALevelTheUserRaisedDuringTheSession() {
    let outputs = FakeOutputs(values: ["headphones": [left, right]])
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0.1)
    outputs.values["headphones"] = [.volume(element: 1, value: 0.5), right]
    let writes = outputs.writes.count
    suppression.end()
    #expect(outputs.values["headphones"] == [.volume(element: 1, value: 0.5), right])
    #expect(outputs.writes.count == writes)
    #expect(!suppression.needsDeviceListener)
}

@Test func mutingPrefersMuteControlsAndLoweringPrefersVolumeControls() {
    let volume = OutputControl.volume(element: 0, value: 0.5)
    let outputs = FakeOutputs(values: ["both": [unmuted, volume], "muteOnly": [unmuted], "volumeOnly": [volume]])
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0)
    #expect(outputs.values == ["both": [muted, volume], "muteOnly": [muted], "volumeOnly": [.volume(element: 0, value: 0)]])
    suppression.end()
    suppression.begin(scale: 0.1)
    #expect(outputs.values == [
        "both": [unmuted, .volume(element: 0, value: 0.05)],
        "muteOnly": [muted],
        "volumeOnly": [.volume(element: 0, value: 0.05)],
    ])
    suppression.end()
    #expect(outputs.values == ["both": [unmuted, volume], "muteOnly": [unmuted], "volumeOnly": [volume]])
}

@Test func anOutputThatReturnsMidSessionIsNotLoweredTwice() {
    let outputs = FakeOutputs(values: ["dock": [.volume(element: 0, value: 0.5)]])
    let store = MemoryOriginalsStore()
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.begin(scale: 0.1)
    #expect(outputs.values["dock"] == [.volume(element: 0, value: 0.05)])
    outputs.connected = []
    suppression.reconcile()
    outputs.connected = ["dock"]
    suppression.reconcile()
    #expect(outputs.values["dock"] == [.volume(element: 0, value: 0.05)])
    #expect(outputs.writes.count == 1)
    #expect(store.saved == ["dock": [.volume(element: 0, value: 0.5)]])
    suppression.end()
    #expect(outputs.values["dock"] == [.volume(element: 0, value: 0.5)])
    #expect(store.saved.isEmpty)
}

@Test func replacementInstanceRestoresWhatADroppedInstanceLowered() {
    let outputs = FakeOutputs(values: ["speakers": [unmuted, .volume(element: 0, value: 0.8)], "headphones": [left, right]])
    let original = outputs.values
    let store = MemoryOriginalsStore()
    OutputSuppression(controls: outputs, store: store, onError: { _ in }).begin(scale: 0.1)
    #expect(outputs.values != original)
    let replacement = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    replacement.end()
    #expect(outputs.values == original)
    #expect(store.saved.isEmpty)
    #expect(!replacement.needsDeviceListener)
}

private let half = OutputControl.volume(element: 0, value: 0.5)

@Test func planMutesAMuteOnlyOutputAtEveryScale() {
    for scale: Float in [0, 0.3] {
        let plan = OutputSuppression.plan(current: [unmuted], held: [], scale: scale)
        #expect(plan.originals == [unmuted])
        #expect(plan.writes == [muted])
    }
}

@Test func planScalesAVolumeOnlyOutput() {
    let muting = OutputSuppression.plan(current: [half], held: [], scale: 0)
    #expect(muting.originals == [half])
    #expect(muting.writes == [.volume(element: 0, value: 0)])
    let lowering = OutputSuppression.plan(current: [half], held: [], scale: 0.3)
    #expect(lowering.originals == [half])
    #expect(lowering.writes == [.volume(element: 0, value: 0.15)])
}

@Test func planMutesWithTheMuteControlAndLowersWithTheVolumeControl() {
    let muting = OutputSuppression.plan(current: [unmuted, half], held: [], scale: 0)
    #expect(muting.originals == [unmuted])
    #expect(muting.writes == [muted])
    let lowering = OutputSuppression.plan(current: [unmuted, half], held: [], scale: 0.3)
    #expect(lowering.originals == [half])
    #expect(lowering.writes == [.volume(element: 0, value: 0.15)])
}

@Test func planLeavesAnAlreadySilentVolumeAlone() {
    let plan = OutputSuppression.plan(current: [.volume(element: 0, value: 0.005)], held: [], scale: 0.3)
    #expect(plan.originals.isEmpty)
    #expect(plan.writes.isEmpty)
}

@Test func planLowersFromAHeldOriginalWithoutCompounding() {
    let lowered = OutputSuppression.plan(current: [.volume(element: 0, value: 0.15)], held: [half], scale: 0.3)
    #expect(lowered.originals == [half])
    #expect(lowered.writes.isEmpty)
    let raised = OutputSuppression.plan(current: [.volume(element: 0, value: 0.25)], held: [half], scale: 0.3)
    #expect(raised.originals == [half])
    #expect(raised.writes == [.volume(element: 0, value: 0.15)])
}

@Test func endRestoresALevelTheUserRaisedThatIsStillBelowTheOriginal() {
    let outputs = FakeOutputs(values: ["dock": [half]])
    let suppression = OutputSuppression(controls: outputs, store: MemoryOriginalsStore(), onError: { _ in })
    suppression.begin(scale: 0.1)
    #expect(outputs.values["dock"] == [.volume(element: 0, value: 0.05)])
    outputs.values["dock"] = [.volume(element: 0, value: 0.3)]
    suppression.end()
    #expect(outputs.values["dock"] == [half])
    #expect(!suppression.needsDeviceListener)
}

@Test func beginAtANewScaleWhileLoweringReplansFromTheHeldOriginal() {
    let outputs = FakeOutputs(values: ["dock": [half]])
    let store = MemoryOriginalsStore()
    let suppression = OutputSuppression(controls: outputs, store: store, onError: { _ in })
    suppression.begin(scale: 0.5)
    #expect(outputs.values["dock"] == [.volume(element: 0, value: 0.25)])
    suppression.begin(scale: 0.1)
    #expect(outputs.values["dock"] == [.volume(element: 0, value: 0.05)])
    #expect(store.saved == ["dock": [half]])
    suppression.end()
    #expect(outputs.values["dock"] == [half])
    #expect(store.saved.isEmpty)
}
