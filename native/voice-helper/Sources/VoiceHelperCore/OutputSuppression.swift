let silentVolume: Float = 0.5 / 64

public enum OutputControl: Equatable, Sendable, Codable {
    case mute(element: UInt32, value: UInt32)
    case volume(element: UInt32, value: Float)

    enum Kind: Sendable { case mute, volume }

    struct ID: Hashable, Sendable {
        let kind: Kind
        let element: UInt32
    }

    var id: ID {
        switch self {
        case .mute(let element, _): return ID(kind: .mute, element: element)
        case .volume(let element, _): return ID(kind: .volume, element: element)
        }
    }

    public var isSilenced: Bool {
        switch self {
        case .mute(_, let value): return value != 0
        case .volume(_, let value): return value < silentVolume
        }
    }

    /// `volume` is the fraction of the level to keep; a mute control can only mute.
    func lowered(to volume: Float) -> OutputControl {
        switch self {
        case .mute(let element, _): return .mute(element: element, value: 1)
        case .volume(let element, let value): return .volume(element: element, value: value * volume)
        }
    }

    func isQuieter(than other: OutputControl) -> Bool {
        switch (self, other) {
        case (.mute(_, let now), .mute(_, let then)): return now != 0 && then == 0
        case (.volume(_, let now), .volume(_, let then)): return now < then
        default: return false
        }
    }
}

public protocol OutputControls: AnyObject {
    func devices() throws -> [String]
    /// The writable mute controls and the writable volume controls; either group may be absent.
    func snapshot(uid: String) throws -> [OutputControl]
    func write(uid: String, control: OutputControl) throws
}

public protocol OutputOriginalsStore {
    /// What the last save left. A failed read must not be treated as an empty record.
    func load() throws -> [String: [OutputControl]]
    /// Replaces the record; an empty map removes it. The record must survive the process dying.
    func save(_ originals: [String: [OutputControl]]) throws
}

public final class OutputSuppression {
    private let controls: any OutputControls
    private let store: any OutputOriginalsStore
    private let onError: (String) -> Void
    private var active = false
    private var volume: Float = 0
    private var seen: Set<String> = []
    private var originals: [String: [OutputControl]] = [:]
    private var saved: [String: [OutputControl]]?

    public init(controls: any OutputControls, store: any OutputOriginalsStore, onError: @escaping (String) -> Void) {
        self.controls = controls
        self.store = store
        self.onError = onError
    }

    public var needsDeviceListener: Bool { active || saved == nil || !originals.isEmpty }

    /// Lowers every output to `volume`, the fraction of its level to keep; 0 mutes.
    public func begin(volume: Float) {
        if !active, saved != nil { restore() }
        active = true
        self.volume = volume
        reconcile()
    }

    public func end() {
        active = false
        seen.removeAll()
        reconcile()
    }

    public func reconcile() {
        if saved == nil {
            do {
                originals = try store.load()
                saved = originals
            } catch {
                onError("could not read the output restore record: \(error)")
                return
            }
            if active { restore() }
        }
        guard active else {
            restore()
            return
        }
        let devices: [String]
        do {
            devices = try controls.devices()
        } catch {
            onError("could not discover audio outputs: \(error)")
            return
        }
        seen.formIntersection(devices)
        let held = originals
        var plans: [(uid: String, writes: [OutputControl])] = []
        for uid in devices where !seen.contains(uid) {
            seen.insert(uid)
            let current: [OutputControl]
            do {
                current = try controls.snapshot(uid: uid)
            } catch {
                seen.remove(uid)
                onError("could not lower output: \(error)")
                continue
            }
            // An original the output is still below was never restored, as when a device drops
            // out mid-session and returns. Lowering from it again keeps the target fixed instead of
            // compounding, and recording the lowered level instead would lose the original.
            var pending = (originals[uid] ?? []).filter { original in
                current.first { $0.id == original.id }?.isQuieter(than: original) ?? true
            }
            var writes: [OutputControl] = []
            for control in group(current) {
                let original: OutputControl
                if let held = pending.first(where: { $0.id == control.id }) {
                    original = held
                } else if control.isSilenced {
                    continue
                } else {
                    original = control
                    pending.append(control)
                }
                let lowered = original.lowered(to: volume)
                if lowered.isQuieter(than: control) { writes.append(lowered) }
            }
            originals[uid] = pending.isEmpty ? nil : pending
            plans.append((uid, writes))
        }
        do {
            try save()
        } catch {
            onError("could not record outputs before lowering them: \(error)")
            originals = held
            seen.subtract(plans.map(\.uid))
            return
        }
        for (uid, writes) in plans {
            do {
                for control in writes { try controls.write(uid: uid, control: control) }
            } catch {
                seen.remove(uid)
                onError("could not lower output: \(error)")
                restore(uid: uid)
            }
        }
        persist()
    }

    /// Partial lowering needs volume controls and muting prefers mute controls; a device that has
    /// only the other kind still gets lowered with what it has.
    private func group(_ controls: [OutputControl]) -> [OutputControl] {
        let mutes = controls.filter { $0.id.kind == .mute }
        let volumes = controls.filter { $0.id.kind == .volume }
        let (preferred, fallback) = volume == 0 ? (mutes, volumes) : (volumes, mutes)
        return preferred.isEmpty ? fallback : preferred
    }

    private func restore() {
        for uid in Array(originals.keys) { restore(uid: uid) }
        persist()
    }

    private func restore(uid: String) {
        guard let pending = originals[uid] else { return }
        let current: [OutputControl]
        do {
            current = try controls.snapshot(uid: uid)
        } catch {
            onError("could not restore output: \(error)")
            return
        }
        let failed = pending.filter { original in
            // A device reports only the group of controls that is settable right now, so a missing
            // control may come back; keep its original for the next device change or session.
            guard let now = current.first(where: { $0.id == original.id }) else { return true }
            // Restore only while the output is still below its original; a level the user raised
            // back is theirs.
            guard now.isQuieter(than: original) else { return false }
            do {
                try controls.write(uid: uid, control: original)
                return false
            } catch {
                onError("could not restore output: \(error)")
                return true
            }
        }
        originals[uid] = failed.isEmpty ? nil : failed
    }

    private func save() throws {
        guard let saved, originals != saved else { return }
        try store.save(originals)
        self.saved = originals
    }

    private func persist() {
        do {
            try save()
        } catch {
            onError("could not update the output restore record: \(error)")
        }
    }
}
