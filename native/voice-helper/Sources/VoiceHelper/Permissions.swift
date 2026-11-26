import AVFoundation
import ApplicationServices
import Foundation
import VoiceHelperCore

final class Permissions {
    typealias Read = @Sendable (_ accessibilityRequested: Bool) -> HelperEvent

    private let output: Output
    private let read: Read
    private let isTrusted: @Sendable () -> Bool
    private let onAccessibility: (_ trusted: Bool) -> Void
    // There is no API that distinguishes "never asked" from "denied", so a
    // request issued by this process is the only signal we have.
    private var accessibilityRequested = false
    private var lastTrusted: Bool?
    private var watch: DispatchSourceTimer?
    private let reads = DispatchQueue(label: "voice.permissions", qos: .userInitiated)

    init(output: Output, read: @escaping Read = Permissions.readSystem(accessibilityRequested:),
         isTrusted: @escaping @Sendable () -> Bool = { AXIsProcessTrusted() },
         onAccessibility: @escaping (_ trusted: Bool) -> Void) {
        self.output = output
        self.read = read
        self.isTrusted = isTrusted
        self.onAccessibility = onAccessibility
    }

    /// macOS announces no Accessibility change, so a slow poll keeps the hotkey tap and main's
    /// view of the grant in step with System Settings, even while no Voice window is open.
    func startWatching() {
        guard watch == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 2, repeating: 2, leeway: .seconds(1))
        timer.setEventHandler { [weak self] in self?.tick() }
        watch = timer
        timer.resume()
    }

    func stopWatching() {
        watch?.cancel()
        watch = nil
    }

    /// Hands every reading to `onAccessibility`, which must be idempotent, so a tap the system
    /// dropped is replaced; reports to main only when the grant changed.
    func tick() {
        let trusted = isTrusted()
        onAccessibility(trusted)
        guard trusted != lastTrusted else { return }
        lastTrusted = trusted
        check()
    }

    func check() {
        let accessibilityRequested = accessibilityRequested
        reads.async { [output, read] in output.emit(read(accessibilityRequested)) }
    }

    func request(_ kind: PermissionKind) {
        switch kind {
        case .microphone:
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async { self.check() }
            }
        case .accessibility:
            accessibilityRequested = true
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)
            check()
        case .systemAudio:
            SystemAudioAccess.request { self.check() }
        }
    }

    @Sendable static func readSystem(accessibilityRequested: Bool) -> HelperEvent {
        let microphone: PermissionState =
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: .granted
            case .denied, .restricted: .denied
            case .notDetermined: .notDetermined
            @unknown default: .denied
            }
        let accessibility: PermissionState = AXIsProcessTrusted() ? .granted : accessibilityRequested ? .denied : .notDetermined
        return .permissions(microphone: microphone, accessibility: accessibility, systemAudio: SystemAudioAccess.state)
    }
}
