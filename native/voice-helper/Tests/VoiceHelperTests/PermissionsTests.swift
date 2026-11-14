import Foundation
import Testing
import VoiceHelperCore
import os
@testable import VoiceHelper

struct PermissionsTests {
    private static func answer(microphone: PermissionState) -> HelperEvent {
        .permissions(microphone: microphone, accessibility: .granted, systemAudio: .granted)
    }

    @Test func aCheckReturnsBeforeMacOSHasAnswered() async throws {
        let lines = EmittedLines()
        let callerReturned = DispatchSemaphore(value: 0)
        let readFinishedAfterTheCaller = OSAllocatedUnfairLock(initialState: false)
        let permissions = Permissions(
            output: Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor),
            read: { _ in
                // A check that held its caller would leave this to time out.
                let returned = callerReturned.wait(timeout: .now() + .seconds(2)) == .success
                readFinishedAfterTheCaller.withLock { $0 = returned }
                return Self.answer(microphone: .granted)
            },
            onAccessibilityGranted: {})

        permissions.check()
        callerReturned.signal()

        let events = try await lines.wait(for: "permissions")
        #expect(readFinishedAfterTheCaller.withLock { $0 })
        #expect(events.map { $0["microphone"] as? String } == ["granted"])
    }

    @Test func answersArriveInTheOrderTheChecksWereMade() async throws {
        let lines = EmittedLines()
        let firstMayAnswer = DispatchSemaphore(value: 0)
        let reads = OSAllocatedUnfairLock(initialState: 0)
        let permissions = Permissions(
            output: Output(fd: lines.pipe.fileHandleForWriting.fileDescriptor),
            read: { _ in
                let first = reads.withLock { count in
                    count += 1
                    return count == 1
                }
                if first { _ = firstMayAnswer.wait(timeout: .now() + .seconds(2)) }
                return Self.answer(microphone: first ? .denied : .granted)
            },
            onAccessibilityGranted: {})

        permissions.check()
        permissions.check()
        // The first read is still running. The second answer gets this long to overtake it.
        _ = try? await lines.wait(for: "permissions", timeout: .milliseconds(200))
        firstMayAnswer.signal()

        let deadline = ContinuousClock.now + .seconds(5)
        while lines.snapshot().count < 2, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(lines.snapshot().map { $0["microphone"] as? String } == ["denied", "granted"])
    }
}
