import AVFoundation
import ApplicationServices
import Foundation
import VoiceHelperCore

final class Permissions {
    /// The three grants as macOS reports them now, given whether this process has asked for Accessibility.
    typealias Read = @Sendable (_ accessibilityRequested: Bool) -> HelperEvent

    private let output: Output
    private let read: Read
    private let onAccessibilityGranted: () -> Void
    // There is no API that distinguishes "never asked" from "denied", so a
    // request issued by this process is the only signal we have.
    private var accessibilityRequested = false
    private var poll: DispatchSourceTimer?
    // The grants are read over XPC, about 25 ms for the first read in a process. At launch main
    // sends `asr.prepare` right behind the check, so on the main thread that read delayed the
    // model load. One serial queue keeps the answers in the order the checks were made.
    private let reads = DispatchQueue(label: "voice.permissions", qos: .userInitiated)

    init(output: Output, read: @escaping Read = Permissions.readSystem(accessibilityRequested:), onAccessibilityGranted: @escaping () -> Void) {
        self.output = output
        self.read = read
        self.onAccessibilityGranted = onAccessibilityGranted
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
            pollUntilAccessibilityGranted()
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

    private func pollUntilAccessibilityGranted() {
        poll?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        let deadline = DispatchTime.now() + 120
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if AXIsProcessTrusted() {
                self.poll?.cancel()
                self.poll = nil
                self.check()
                self.onAccessibilityGranted()
            } else if DispatchTime.now() > deadline {
                self.poll?.cancel()
                self.poll = nil
            }
        }
        poll = timer
        timer.resume()
    }
}
