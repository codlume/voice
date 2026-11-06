import CryptoKit
import Darwin
import Foundation

/// Fetches one manifest file at a time from Hugging Face by a URL built from the manifest
/// alone: no listing, no token, no registry override. Bytes stream to a staging file under an
/// incremental SHA256 and a hard cap at the manifest size, and only a file whose final hash
/// matches is left behind.
public struct ModelFetcher: Sendable {
    public static let host = "https://huggingface.co"
    public static let attempts = 4
    public static let maximumRetryAfter: Duration = .seconds(30)

    public enum Failure: LocalizedError, Equatable, Sendable {
        case status(Int)
        case insecureRedirect
        case oversize
        case shortBody
        case hashMismatch
        case transport(URLError.Code)
        case cancelled
        case write

        var retryable: Bool {
            switch self {
            case .status(let code): return code == 429 || code >= 500
            case .shortBody, .transport: return true
            case .insecureRedirect, .oversize, .hashMismatch, .cancelled, .write: return false
            }
        }

        public var errorDescription: String? {
            switch self {
            case .status(let code): return "the server answered HTTP \(code)"
            case .insecureRedirect: return "the server redirected away from https"
            case .oversize: return "the server sent more bytes than the file has"
            case .shortBody: return "the connection ended before the file was complete"
            case .hashMismatch: return "the downloaded file did not match the expected contents"
            case .transport(.notConnectedToInternet): return "this Mac is not connected to the internet"
            case .transport(.timedOut): return "the connection timed out"
            case .transport(.cannotFindHost), .transport(.dnsLookupFailed): return "the download server could not be found"
            case .transport(.cannotConnectToHost): return "the download server could not be reached"
            case .transport(.networkConnectionLost): return "the connection was lost"
            case .transport(.secureConnectionFailed), .transport(.serverCertificateUntrusted): return "a secure connection could not be made"
            case .transport: return "the connection failed"
            case .cancelled: return "the download was cancelled"
            case .write: return "the file could not be written to the models folder"
            }
        }
    }

    private let configuration: URLSessionConfiguration
    private let backoff: [Duration]
    private let minimumRate: (bytes: Int64, per: Duration)
    private let sleep: @Sendable (Duration) async throws -> Void

    public init(
        configuration: URLSessionConfiguration,
        backoff: [Duration] = [.seconds(1), .seconds(2), .seconds(4)],
        minimumRate: (bytes: Int64, per: Duration) = (bytes: 1 << 20, per: .seconds(120)),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.configuration = configuration.copy() as! URLSessionConfiguration
        self.backoff = backoff
        self.minimumRate = minimumRate
        self.sleep = sleep
    }

    public static func url(repository: String, revision: String, path: String) -> URL? {
        guard let components = ModelPath.components(of: path), ModelPath.isValid(repository), ModelPath.isValid(revision) else { return nil }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let encoded = components.map { $0.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
        return URL(string: "\(host)/\(repository)/resolve/\(revision)/\(encoded.joined(separator: "/"))")
    }

    /// Downloads `file` to `destination`, which must not exist. On return the bytes there have
    /// the manifest's size and hash and are synced to disk. On any failure nothing is left at
    /// `destination`.
    public func fetch(_ file: ModelFile, of release: ModelRelease, to destination: URL) async throws {
        guard let url = Self.url(repository: release.repository, revision: release.revision, path: file.path) else {
            throw ModelCacheError(kind: .invalidManifest(file.path), model: release.displayName)
        }
        let download = try Download(destination: destination, size: file.size, minimumRate: minimumRate)
        defer { download.close() }
        var attempt = 0
        while true {
            attempt += 1
            let outcome = await download.run(url: url, configuration: configuration)
            switch outcome {
            case .complete:
                guard download.syncedDigestOfReceivedBytes() == file.sha256 else {
                    download.discard()
                    throw Failure.hashMismatch
                }
                return
            case .failed(let failure, let retryAfter):
                guard failure.retryable, attempt < Self.attempts else {
                    download.discard()
                    throw failure
                }
                let delay = retryAfter.map { min($0, Self.maximumRetryAfter) } ?? backoff[min(attempt - 1, backoff.count - 1)]
                do {
                    try await sleep(delay)
                } catch {
                    download.discard()
                    throw Failure.cancelled
                }
            }
        }
    }

    enum Outcome: Equatable {
        case complete
        case failed(Failure, retryAfter: Duration?)
    }

    final class Download: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        private let destination: URL
        private let size: Int64
        private let minimumRate: (bytes: Int64, per: Duration)
        private let fd: Int32
        private let lock = NSLock()
        private var hasher = SHA256()
        private var received: Int64 = 0
        private var windowStart = ContinuousClock.now
        private var windowBytes: Int64 = 0
        private var failure: Failure?
        private var retryAfter: Duration?
        private var task: URLSessionDataTask?
        private var continuation: CheckedContinuation<Outcome, Never>?

        init(destination: URL, size: Int64, minimumRate: (bytes: Int64, per: Duration)) throws {
            self.destination = destination
            self.size = size
            self.minimumRate = minimumRate
            fd = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
            guard fd >= 0 else { throw Failure.write }
        }

        func run(url: URL, configuration: URLSessionConfiguration) async -> Outcome {
            var request = URLRequest(url: url)
            // A resume offset counts bytes as stored. Compressed transfer would make it meaningless.
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            let resumeFrom = lock.withLock { received }
            if resumeFrom > 0 { request.setValue("bytes=\(resumeFrom)-", forHTTPHeaderField: "Range") }
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            lock.withLock {
                failure = nil
                retryAfter = nil
                windowStart = .now
                windowBytes = 0
            }
            return await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    let task = session.dataTask(with: request)
                    lock.withLock {
                        self.continuation = continuation
                        self.task = task
                    }
                    task.resume()
                }
            } onCancel: {
                lock.withLock {
                    failure = .cancelled
                    task?.cancel()
                }
            }
        }

        func syncedDigestOfReceivedBytes() -> String {
            let synced = fsync(fd) == 0
            let digest = lock.withLock { hasher.finalize().map { String(format: "%02x", $0) }.joined() }
            return synced ? digest : ""
        }

        func discard() {
            unlink(destination.path)
        }

        func close() {
            Darwin.close(fd)
        }

        private func restart() {
            received = 0
            hasher = SHA256()
            ftruncate(fd, 0)
            lseek(fd, 0, SEEK_SET)
        }

        // MARK: URLSessionDataDelegate, on the session's serial delegate queue

        func urlSession(
            _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
        ) {
            if request.url?.scheme?.lowercased() == "https" { return completionHandler(request) }
            lock.withLock { failure = .insecureRedirect }
            completionHandler(nil)
        }

        func urlSession(
            _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
            completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
        ) {
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            let decision: URLSession.ResponseDisposition = lock.withLock {
                if failure != nil { return .cancel }
                switch status {
                case 200:
                    if received > 0 { restart() }
                    return .allow
                case 206 where received > 0:
                    let range = http?.value(forHTTPHeaderField: "Content-Range") ?? ""
                    guard range.hasPrefix("bytes \(received)-") else {
                        failure = .status(status)
                        return .cancel
                    }
                    return .allow
                default:
                    failure = .status(status)
                    if status == 429 || status == 503, let seconds = http?.value(forHTTPHeaderField: "Retry-After").flatMap({ Int($0.trimmingCharacters(in: .whitespaces)) }), seconds > 0 {
                        retryAfter = .seconds(seconds)
                    }
                    return .cancel
                }
            }
            completionHandler(decision)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            let stop: Bool = lock.withLock {
                guard failure == nil else { return true }
                let room = size - received
                guard Int64(data.count) <= room else {
                    failure = .oversize
                    return true
                }
                let written = data.withUnsafeBytes { bytes -> Bool in
                    var offset = 0
                    while offset < bytes.count {
                        let count = write(fd, bytes.baseAddress! + offset, bytes.count - offset)
                        if count <= 0 { return false }
                        offset += count
                    }
                    return true
                }
                guard written else {
                    failure = .write
                    return true
                }
                hasher.update(data: data)
                received += Int64(data.count)
                windowBytes += Int64(data.count)
                // The session's idle timeout resets on every byte, so a trickle needs this floor.
                if ContinuousClock.now - windowStart >= minimumRate.per {
                    if windowBytes < minimumRate.bytes, received < size {
                        failure = .transport(.timedOut)
                        return true
                    }
                    windowStart = .now
                    windowBytes = 0
                }
                return false
            }
            if stop { dataTask.cancel() }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            let outcome: Outcome = lock.withLock {
                if let failure { return .failed(failure, retryAfter: retryAfter) }
                // Every byte arrived, so a late transport error costs nothing: the hash decides.
                if received == size { return .complete }
                if let error {
                    let code = (error as? URLError)?.code ?? .unknown
                    return .failed(.transport(code), retryAfter: nil)
                }
                return .failed(.shortBody, retryAfter: nil)
            }
            let continuation = lock.withLock {
                defer { self.continuation = nil; self.task = nil }
                return self.continuation
            }
            continuation?.resume(returning: outcome)
        }
    }
}
