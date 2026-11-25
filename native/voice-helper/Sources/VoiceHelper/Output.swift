import Darwin
import Foundation
import VoiceHelperCore

final class Output: @unchecked Sendable {
    private let fd: Int32
    private let owner: AnyObject?
    private let lock = NSLock()

    /// Takes over fd 1 for the protocol and points fd 1 at stderr so a stray
    /// `print` inside a dependency cannot corrupt the stream.
    init() {
        fd = dup(STDOUT_FILENO)
        owner = nil
        dup2(STDERR_FILENO, STDOUT_FILENO)
    }

    /// `owner` is whatever closes `fd`. The output holds it, so the descriptor stays open for
    /// as long as anything can still emit. A closed descriptor's number goes to the next file
    /// the process opens, and a late emit would be written into that file.
    init(fd: Int32, owner: AnyObject? = nil) {
        self.fd = fd
        self.owner = owner
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
