import Darwin
import Foundation
import VoiceHelperCore

final class Output: @unchecked Sendable {
    private let fd: Int32
    private let lock = NSLock()

    /// Takes over fd 1 for the protocol and points fd 1 at stderr so a stray
    /// `print` inside a dependency cannot corrupt the stream.
    init() {
        fd = dup(STDOUT_FILENO)
        dup2(STDERR_FILENO, STDOUT_FILENO)
    }

    init(fd: Int32) {
        self.fd = fd
    }

    func emit(_ event: HelperEvent) {
        let bytes = Array((event.encodeLine() + "\n").utf8)
        lock.lock()
        defer { lock.unlock() }
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
            if written < 0 {
                if errno == EINTR { continue }
                return
            }
            offset += written
        }
    }

    func log(_ level: LogLevel, _ message: String) {
        emit(.log(level: level, message: message))
    }
}
