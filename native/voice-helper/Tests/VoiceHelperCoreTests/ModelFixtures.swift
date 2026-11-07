import CryptoKit
import Foundation
import os
@testable import VoiceHelperCore

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func temporaryDirectory(_ label: String = "models") throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(label)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

struct SyntheticRelease {
    let release: ModelRelease
    let contents: [String: Data]

    init(files: [(path: String, data: Data)], folderName: String = "model", marker: String? = nil, shadows: [String] = [], revision: String = String(repeating: "ab", count: 20)) {
        contents = Dictionary(uniqueKeysWithValues: files)
        release = ModelRelease(
            id: "synthetic", displayName: "test model", repository: "test/\(UUID().uuidString.lowercased())",
            folderName: folderName, revision: revision,
            files: files.map { ModelFile($0.path, size: Int64($0.data.count), sha256: sha256Hex($0.data)) },
            marker: marker, shadows: shadows)
    }

    func folder(in modelsDirectory: URL) -> URL {
        modelsDirectory.appendingPathComponent(release.folderName, isDirectory: true)
    }

    func write(into modelsDirectory: URL, overriding: [String: Data] = [:], skipping: Set<String> = []) throws {
        for file in release.files where !skipping.contains(file.path) {
            let url = folder(in: modelsDirectory).appendingPathComponent(file.path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try (overriding[file.path] ?? contents[file.path]!).write(to: url)
        }
    }

    func url(for path: String) -> URL {
        ModelFetcher.url(repository: release.repository, revision: release.revision, path: path)!
    }

    func cache(in modelsDirectory: URL) -> ModelCache {
        ModelCache(release: release, modelsDirectory: modelsDirectory)
    }
}

func patternedData(_ count: Int, seed: UInt8) -> Data {
    var data = Data(count: count)
    data.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
        var state = UInt32(seed) &* 2_654_435_761 &+ 1
        for index in 0..<count {
            state = state &* 1_664_525 &+ 1_013_904_223
            bytes[index] = UInt8(truncatingIfNeeded: state >> 24)
        }
    }
    return data
}

struct FileIdentity: Equatable {
    let inode: UInt64
    let mtimeNs: Int64
    let size: Int64

    init(_ url: URL) throws {
        var status = stat()
        guard lstat(url.path, &status) == 0 else { throw POSIXError(.ENOENT) }
        inode = UInt64(status.st_ino)
        mtimeNs = Int64(status.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(status.st_mtimespec.tv_nsec)
        size = Int64(status.st_size)
    }
}

final class StubHub: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable {
        enum End: Sendable {
            case finish
            case fail(URLError.Code)
            case hang
        }

        var status = 200
        var headers: [String: String] = [:]
        var chunks: [Data] = []
        var end = End.finish
        var redirect: URL?
        var resume: Data?
        var truncate: Int?

        static func resume(_ full: Data, truncateAt: Int? = nil, end: End = .finish) -> Reply {
            Reply(end: end, resume: full, truncate: truncateAt)
        }

        static func ok(_ data: Data, chunk: Int = 64 << 10) -> Reply {
            Reply(status: 200, headers: ["Content-Length": "\(data.count)"], chunks: data.chunked(chunk))
        }

        static func partial(_ data: Data, of full: Data) -> Reply {
            Reply(status: 206, headers: ["Content-Range": "bytes \(full.count - data.count)-\(full.count - 1)/\(full.count)"], chunks: data.chunked(64 << 10))
        }

        static func status(_ code: Int, headers: [String: String] = [:]) -> Reply {
            Reply(status: code, headers: headers, chunks: [Data("error".utf8)])
        }

        static func redirect(to url: URL) -> Reply {
            Reply(status: 302, headers: ["Location": url.absoluteString], redirect: url)
        }
    }

    private struct State {
        var scripts: [String: [Reply]] = [:]
        var requests: [URLRequest] = []
    }

    private static let state = OSAllocatedUnfairLock(initialState: State())

    static func script(_ url: URL, _ replies: [Reply]) {
        state.withLock { $0.scripts[url.path] = replies }
    }

    static func requests(for release: ModelRelease) -> [URLRequest] {
        state.withLock { $0.requests.filter { $0.url?.path.contains(release.repository) == true } }
    }

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubHub.self]
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var reply: Reply = Self.state.withLock { state in
            state.requests.append(request)
            guard let path = request.url?.path, var queue = state.scripts[path], let next = queue.first else {
                return .status(404)
            }
            if queue.count > 1 { queue.removeFirst() }
            state.scripts[path] = queue
            return next
        }
        guard let client, let url = request.url else { return }
        if let full = reply.resume {
            let offset = request.value(forHTTPHeaderField: "Range").flatMap { Int($0.dropFirst("bytes=".count).dropLast()) } ?? 0
            let served = full.suffix(from: offset).prefix(reply.truncate ?? .max)
            reply.status = offset > 0 ? 206 : 200
            reply.headers = offset > 0 ? ["Content-Range": "bytes \(offset)-\(full.count - 1)/\(full.count)"] : ["Content-Length": "\(full.count)"]
            reply.chunks = Data(served).chunked(10_000)
        }
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        // One client call per step, spaced out like bytes arriving on a socket. A synchronous
        // burst followed by a failure makes URLSession drop data its delegate never saw.
        var steps: [() -> Void] = []
        if let redirect = reply.redirect {
            steps.append { client.urlProtocol(self, wasRedirectedTo: URLRequest(url: redirect), redirectResponse: response) }
        }
        steps.append { client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed) }
        for chunk in reply.chunks {
            steps.append { client.urlProtocol(self, didLoad: chunk) }
        }
        switch reply.end {
        case .finish: steps.append { client.urlProtocolDidFinishLoading(self) }
        case .fail(let code): steps.append { client.urlProtocol(self, didFailWithError: URLError(code)) }
        case .hang: break
        }
        for (index, step) in steps.enumerated() {
            let delay = index == steps.count - 1 ? 2 * index + 50 : 2 * index
            Self.delivery.asyncAfter(deadline: .now() + .milliseconds(delay)) { [self] in
                if !stopped.withLock({ $0 }) { step() }
            }
        }
    }

    private static let delivery = DispatchQueue(label: "StubHub.delivery")
    private let stopped = OSAllocatedUnfairLock(initialState: false)

    override func stopLoading() {
        stopped.withLock { $0 = true }
    }
}

extension Data {
    func chunked(_ size: Int) -> [Data] {
        stride(from: startIndex, to: endIndex, by: size).map { Data(self[$0..<Swift.min($0 + size, endIndex)]) }
    }
}

final class RecordedSleeps: @unchecked Sendable {
    private let lock = NSLock()
    private var delays: [Duration] = []

    var recorded: [Duration] { lock.withLock { delays } }

    func fetcher(backoff: [Duration] = [.seconds(1), .seconds(2), .seconds(4)]) -> ModelFetcher {
        ModelFetcher(configuration: StubHub.configuration(), backoff: backoff) { [self] delay in
            lock.withLock { delays.append(delay) }
        }
    }
}
