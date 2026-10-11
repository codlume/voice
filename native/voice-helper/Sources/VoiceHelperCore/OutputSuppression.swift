let silentVolume: Float = 0.5 / 64

public enum OutputControl: Equatable, Sendable, Codable {
    case mute(element: UInt32, value: UInt32)
    case volume(element: UInt32, value: Float)

    public var silenced: OutputControl {
        switch self {
        case .mute(let element, _): return .mute(element: element, value: 1)
        case .volume(let element, _): return .volume(element: element, value: 0)
        }
    }

    public var isSilenced: Bool {
        switch self {
        case .mute(_, let value): return value != 0
        case .volume(_, let value): return value < silentVolume
        }
    }
}

public protocol OutputControls: AnyObject {
    func devices() throws -> [String]
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
    private var seen: Set<String> = []
    private var originals: [String: [OutputControl]] = [:]
    private var saved: [String: [OutputControl]]?

    public init(controls: any OutputControls, store: any OutputOriginalsStore, onError: @escaping (String) -> Void) {
        self.controls = controls
        self.store = store
        self.onError = onError
    }

    public var needsDeviceListener: Bool { active || saved == nil || !originals.isEmpty }

    public func begin() {
        if !active, saved != nil { restore() }
        active = true
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
        var plans: [(uid: String, toSilence: [OutputControl])] = []
        for uid in devices where !seen.contains(uid) {
            seen.insert(uid)
            let current: [OutputControl]
            do {
                current = try controls.snapshot(uid: uid)
            } catch {
                seen.remove(uid)
                onError("could not silence output: \(error)")
                continue
            }
            let toSilence = current.filter { !$0.isSilenced }
            var pending = (originals[uid] ?? []).filter { original in
                current.first { $0.silenced == original.silenced }?.isSilenced ?? true
            }
            pending.append(contentsOf: toSilence)
            originals[uid] = pending.isEmpty ? nil : pending
            plans.append((uid, toSilence))
        }
        do {
            try save()
        } catch {
            onError("could not record outputs before silencing them: \(error)")
            originals = held
            seen.subtract(plans.map(\.uid))
            return
        }
        for (uid, toSilence) in plans {
            do {
                for control in toSilence { try controls.write(uid: uid, control: control.silenced) }
            } catch {
                seen.remove(uid)
                onError("could not silence output: \(error)")
                restore(uid: uid)
            }
        }
        persist()
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
            guard let now = current.first(where: { $0.silenced == original.silenced }) else { return true }
            guard now.isSilenced else { return false }
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
