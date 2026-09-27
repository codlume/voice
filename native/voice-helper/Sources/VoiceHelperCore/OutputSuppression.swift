public enum OutputControl: Equatable, Sendable {
    case mute(element: UInt32, value: UInt32)
    case volume(element: UInt32, value: Float)

    public var silenced: OutputControl {
        switch self {
        case .mute(let element, _): return .mute(element: element, value: 1)
        case .volume(let element, _): return .volume(element: element, value: 0)
        }
    }
}

public protocol OutputControls: AnyObject {
    func devices() throws -> [String]
    func snapshot(uid: String) throws -> [OutputControl]
    func write(uid: String, control: OutputControl) throws
}

public final class OutputSuppression {
    private let controls: any OutputControls
    private let onError: (String) -> Void
    private var active = false
    private var seen: Set<String> = []
    private var originals: [String: [OutputControl]] = [:]

    public init(controls: any OutputControls, onError: @escaping (String) -> Void) {
        self.controls = controls
        self.onError = onError
    }

    public var needsDeviceListener: Bool { active || !originals.isEmpty }

    public func begin() {
        guard !active else { return }
        restore()
        active = true
        reconcile()
    }

    public func end() {
        active = false
        seen.removeAll()
        restore()
    }

    public func reconcile() {
        guard active else {
            restore()
            return
        }
        do {
            let devices = try controls.devices()
            seen.formIntersection(devices)
            for uid in devices where !seen.contains(uid) {
                seen.insert(uid)
                do {
                    let current = try controls.snapshot(uid: uid)
                    let pending = originals[uid] ?? []
                    let prior = current.map { control in
                        pending.first { $0.silenced == control.silenced } ?? control
                    }
                    for control in prior where control != control.silenced {
                        // A driver can apply a write and still return an error.
                        if !(originals[uid] ?? []).contains(where: { $0.silenced == control.silenced }) {
                            originals[uid, default: []].append(control)
                        }
                        try controls.write(uid: uid, control: control.silenced)
                    }
                } catch {
                    seen.remove(uid)
                    onError("could not silence output: \(error)")
                    restore(uid: uid)
                }
            }
        } catch {
            onError("could not discover audio outputs: \(error)")
        }
    }

    private func restore() {
        for uid in Array(originals.keys) { restore(uid: uid) }
    }

    private func restore(uid: String) {
        let failed = (originals[uid] ?? []).filter { control in
            do {
                try controls.write(uid: uid, control: control)
                return false
            } catch {
                onError("could not restore output: \(error)")
                return true
            }
        }
        originals[uid] = failed.isEmpty ? nil : failed
    }
}
