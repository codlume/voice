import Foundation
import Testing
import VoiceHelperCore
import os
@testable import VoiceHelper

/// A helper watching a Mac whose Accessibility grant the test flips in System Settings.
private final class WatchedMac: @unchecked Sendable {
    let lines = EmittedLines()
    private let trusted: OSAllocatedUnfairLock<Bool>
    private let tapCalls = OSAllocatedUnfairLock<[Bool]>(initialState: [])
    private(set) var permissions: Permissions!

    init(trusted: Bool) {
        self.trusted = OSAllocatedUnfairLock(initialState: trusted)
        let state = self.trusted
        let tapCalls = tapCalls
        permissions = Permissions(
            output: lines.output(),
            read: { requested in
                .permissions(microphone: .granted,
                             accessibility: state.withLock { $0 } ? .granted : requested ? .denied : .notDetermined,
                             systemAudio: .granted)
            },
            isTrusted: { state.withLock { $0 } },
            onAccessibility: { trusted in tapCalls.withLock { $0.append(trusted) } })
    }

    func set(trusted: Bool) {
        self.trusted.withLock { $0 = trusted }
    }

    /// What the hotkey tap was told on each tick: install when true, remove when false.
    var tap: [Bool] { tapCalls.withLock { $0 } }

    /// The accessibility state of every permissions event, once `count` of them have arrived.
    func reported(count: Int) async throws -> [String] {
        let deadline = ContinuousClock.now + .seconds(5)
        while true {
            let states = lines.snapshot().filter { $0["type"] as? String == "permissions" }
                .compactMap { $0["accessibility"] as? String }
            if states.count >= count { return states }
            guard ContinuousClock.now < deadline else { throw ProtocolError("only \(states) within 5s") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

struct PermissionsWatchTests {
    @Test func revokingAccessibilityRemovesTheTapAndTellsMain() async throws {
        let mac = WatchedMac(trusted: true)
        mac.permissions.tick()
        _ = try await mac.reported(count: 1)

        mac.set(trusted: false)
        mac.permissions.tick()

        #expect(try await mac.reported(count: 2) == ["granted", "notDetermined"])
        #expect(mac.tap == [true, false])
    }

    @Test func grantingAccessibilityInstallsTheTapAndTellsMain() async throws {
        let mac = WatchedMac(trusted: false)
        mac.permissions.tick()
        _ = try await mac.reported(count: 1)

        mac.set(trusted: true)
        mac.permissions.tick()

        #expect(try await mac.reported(count: 2) == ["notDetermined", "granted"])
        #expect(mac.tap == [false, true])
    }

    @Test func anUnchangedGrantKeepsTheTapInPlaceWithoutNewEvents() async throws {
        let mac = WatchedMac(trusted: true)
        mac.permissions.tick()
        _ = try await mac.reported(count: 1)

        mac.permissions.tick()
        mac.permissions.tick()
        // Events arrive in order, so a later change bounds any event the unchanged ticks sent.
        mac.set(trusted: false)
        mac.permissions.tick()

        #expect(try await mac.reported(count: 2) == ["granted", "notDetermined"])
        #expect(mac.tap == [true, true, true, false])
    }
}
