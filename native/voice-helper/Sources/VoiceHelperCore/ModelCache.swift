import CryptoKit
import Darwin
import Foundation

/// Why a model cannot be used, with the text the UI shows.
public struct ModelCacheError: LocalizedError, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case invalidManifest(String)
        case notInstalled
        case damaged(count: Int)
        /// Something a repair cannot fix: an item we must not touch, named relative to the
        /// models directory.
        case blocked(path: String)
        case downloadFailed(String)
        case writeFailed(String)
    }

    public let kind: Kind
    public let model: String

    public var errorDescription: String? {
        switch kind {
        case .invalidManifest(let entry):
            return "This build's \(model) list is invalid (\(entry))."
        case .notInstalled:
            return "The \(model) is not installed."
        case .damaged(let count):
            let files = count == 1 ? "1 file is" : "\(count) files are"
            return "The \(model) is damaged: \(files) missing or altered. Retry downloads only those files."
        case .blocked(let path):
            return "The \(model) cannot be used while \(path) is in the models folder. Remove that item, then retry."
        case .downloadFailed(let reason):
            return "Downloading the \(model) failed: \(reason). Retry keeps the files already downloaded."
        case .writeFailed(let path):
            return "Voice could not write \(path) in the models folder."
        }
    }
}

/// One release in one models directory. Checks the bytes on disk against the release, and
/// repairs only what the check found wrong. The model folder may itself be a symlink; below it
/// every directory must be real and every file regular, and nothing is ever followed or
/// written through a link.
public struct ModelCache: Sendable {
    /// What a check found. `presence()` fills the first three from stat alone; `audit()` also
    /// hashes, and reports how much.
    public struct Report: Sendable, Equatable {
        public var missing: [String] = []
        public var invalid: [String] = []
        public var blocked: [String] = []
        public var hashedBytes: Int64 = 0
        public var hashedFiles = 0

        public var isComplete: Bool { missing.isEmpty && invalid.isEmpty && blocked.isEmpty }
    }

    public static let stampName = ".voice-model-verified.json"
    static let temporaryDirectoryName = ".voice-download"
    static let alwaysHashUpTo: Int64 = 4 << 20
    private static let readChunk = 1 << 20

    public let release: ModelRelease
    public let modelsDirectory: URL

    public init(release: ModelRelease, modelsDirectory: URL) {
        self.release = release
        self.modelsDirectory = modelsDirectory
    }

    public var folder: URL { modelsDirectory.appendingPathComponent(release.folderName, isDirectory: true) }

    /// Stat only: safe on the main thread. Says what is absent, the wrong size, or blocked.
    public func presence() throws -> Report {
        try inspect(hashing: false, trusting: nil).report
    }

    /// The full check. Hashes every file the stamp does not vouch for, and every small file.
    public func audit() throws -> Report {
        try inspect(hashing: true, trusting: readStamp()).report
    }

    /// Audits, and with `download` fetches only the files found missing or invalid, then audits
    /// again, hashing every fetched file from disk. Once the cache is clean, on either path,
    /// writes the marker and stamp. `onDownload` runs once with those files, just before the first
    /// fetch, so a caller that started as a load can report a download. Throws with the user
    /// message when the cache cannot be used. A failed fetch leaves that file as it was, and files
    /// already installed by the same repair stay. Returns the first audit, so a caller can log how
    /// much was hashed.
    @discardableResult
    public func prepare(download: Bool, fetcher: ModelFetcher, onDownload: (@Sendable ([ModelFile]) -> Void)? = nil) async throws -> Report {
        defer { removeTemporaryDirectory() }
        var (report, verified) = try inspect(hashing: true, trusting: readStamp())
        let audited = report
        if let path = report.blocked.first { throw error(.blocked(path: path)) }
        let wanted = report.missing + report.invalid
        if !wanted.isEmpty {
            guard download else {
                throw error(report.missing.isEmpty ? .damaged(count: wanted.count) : .notInstalled)
            }
            let files = release.files.filter { wanted.contains($0.path) }
            onDownload?(files)
            let temporary = try prepareTemporaryDirectory()
            for file in files {
                let staged = temporary.appendingPathComponent(UUID().uuidString, isDirectory: false)
                do {
                    try await fetcher.fetch(file, of: release, to: staged)
                } catch {
                    throw self.error(.downloadFailed(error.localizedDescription))
                }
                try install(staged, at: file.path)
            }
            // A fetched file has no record yet, so this reads it from disk: the stream hash says
            // what arrived, not what is stored. Files the first audit passed keep their records.
            (report, verified) = try inspect(hashing: true, trusting: Stamp(revision: release.revision, files: verified))
            if let path = report.blocked.first { throw error(.blocked(path: path)) }
            guard report.isComplete else { throw error(.damaged(count: report.missing.count + report.invalid.count)) }
        }
        try writeMarkerIfNeeded()
        writeStampBestEffort(Stamp(revision: release.revision, files: verified))
        return audited
    }

    struct Stamp: Codable, Equatable {
        struct Record: Codable, Equatable {
            var size: Int64
            var mtimeNs: Int64
            var inode: UInt64
        }

        var revision: String
        var files: [String: Record]
    }

    private struct Stat {
        let isDirectory: Bool
        let isRegular: Bool
        let record: Stamp.Record

        init(_ status: stat) {
            let type = status.st_mode & S_IFMT
            isDirectory = type == S_IFDIR
            isRegular = type == S_IFREG
            record = Stamp.Record(
                size: Int64(status.st_size),
                mtimeNs: Int64(status.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(status.st_mtimespec.tv_nsec),
                inode: UInt64(status.st_ino))
        }
    }

    private enum Entry {
        case absent
        case present(Stat)
        case unreadable
    }

    private enum DirectoryState: Equatable {
        case absent, blocked, real
    }

    private func error(_ kind: ModelCacheError.Kind) -> ModelCacheError {
        ModelCacheError(kind: kind, model: release.displayName)
    }

    private func relative(_ path: String) -> String {
        "\(release.folderName)/\(path)"
    }

    private static func lstat(_ path: String) -> Entry {
        var status = stat()
        guard Darwin.lstat(path, &status) == 0 else {
            return errno == ENOENT || errno == ENOTDIR ? .absent : .unreadable
        }
        return .present(Stat(status))
    }

    private func inspect(hashing: Bool, trusting stamp: Stamp?) throws -> (report: Report, verified: [String: Stamp.Record]) {
        if let entry = release.invalidEntry { throw error(.invalidManifest(entry)) }
        var report = Report()
        var verified: [String: Stamp.Record] = [:]
        for shadow in release.shadows {
            if case .absent = Self.lstat(modelsDirectory.appendingPathComponent(shadow).path) { continue }
            report.blocked.append(shadow)
        }
        var folderStatus = stat()
        guard stat(folder.path, &folderStatus) == 0 else {
            report.missing = release.files.map(\.path)
            return (report, verified)
        }
        guard folderStatus.st_mode & S_IFMT == S_IFDIR else {
            report.blocked.append(release.folderName)
            return (report, verified)
        }

        var directories: [String: DirectoryState] = [:]
        func directory(_ components: ArraySlice<String>) -> DirectoryState {
            let path = components.joined(separator: "/")
            if let known = directories[path] { return known }
            let state: DirectoryState
            switch Self.lstat(folder.appendingPathComponent(path).path) {
            case .absent: state = .absent
            case .unreadable: state = .blocked
            case .present(let status): state = status.isDirectory ? .real : .blocked
            }
            if state == .blocked { report.blocked.append(relative(path)) }
            directories[path] = state
            return state
        }

        for file in release.files {
            let components = ModelPath.components(of: file.path) ?? []
            var parents = DirectoryState.real
            for end in 1..<max(components.count, 1) where parents == .real {
                parents = directory(components[0..<end])
            }
            if parents == .absent { report.missing.append(file.path) }
            guard parents == .real else { continue }
            let path = folder.appendingPathComponent(file.path).path
            switch Self.lstat(path) {
            case .absent:
                report.missing.append(file.path)
            case .unreadable:
                report.blocked.append(relative(file.path))
            case .present(let status):
                guard status.isRegular else { report.blocked.append(relative(file.path)); continue }
                guard status.record.size == file.size else { report.invalid.append(file.path); continue }
                guard hashing else { continue }
                if file.size > Self.alwaysHashUpTo, let trusted = stamp?.files[file.path], trusted == status.record {
                    verified[file.path] = trusted
                    continue
                }
                report.hashedBytes += file.size
                report.hashedFiles += 1
                guard let hashed = Self.sha256(ofRegularFileAt: path, expectedSize: file.size) else {
                    report.invalid.append(file.path)
                    continue
                }
                if hashed.digest == file.sha256 {
                    verified[file.path] = hashed.record
                } else {
                    report.invalid.append(file.path)
                }
            }
        }

        // Anything we did not list inside a required directory is a blocker: CoreML reads from
        // these bundles, and a repair never deletes them. The folder root is not walked, because
        // FluidAudio's own downloads leave extras there and nothing loads them.
        let listed = Set(release.files.map(\.path))
        let leftovers = Set(listed.flatMap(Self.fluidAudioLeftovers))
        for (directory, state) in directories.sorted(by: { $0.key < $1.key }) where state == .real {
            let entries = (try? FileManager.default.contentsOfDirectory(atPath: folder.appendingPathComponent(directory).path)) ?? []
            for name in entries where name != ".DS_Store" {
                let path = "\(directory)/\(name)"
                if listed.contains(path) || leftovers.contains(path) || directories[path] != nil { continue }
                report.blocked.append(relative(path))
            }
        }
        return (report, verified)
    }

    /// What an interrupted FluidAudio download leaves beside a file. CoreML never reads them, and
    /// a user upgrading mid-install must still be able to repair.
    private static func fluidAudioLeftovers(of path: String) -> [String] {
        ["\(path).partial", "\(path).partial.etag"]
    }

    private static func sha256(ofRegularFileAt path: String, expectedSize: Int64) -> (digest: String, record: Stamp.Record)? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var status = stat()
        guard fstat(fd, &status) == 0 else { return nil }
        let opened = Stat(status)
        guard opened.isRegular, opened.record.size == expectedSize else { return nil }
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: readChunk)
        var total: Int64 = 0
        while true {
            let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, readChunk) }
            if count < 0 { return nil }
            if count == 0 { break }
            buffer.withUnsafeBytes { hasher.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0[0..<count])) }
            total += Int64(count)
        }
        guard total == expectedSize else { return nil }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return (digest, opened.record)
    }

    private var stampURL: URL { folder.appendingPathComponent(Self.stampName, isDirectory: false) }

    func readStamp() -> Stamp? {
        guard let data = Self.readRegularFile(at: stampURL.path),
            let stamp = try? JSONDecoder().decode(Stamp.self, from: data),
            stamp.revision == release.revision
        else { return nil }
        return stamp
    }

    private func writeStampBestEffort(_ stamp: Stamp) {
        guard readStamp() != stamp, let data = try? JSONEncoder().encode(stamp) else { return }
        try? replaceFile(at: stampURL, with: data)
    }

    private func writeMarkerIfNeeded() throws {
        guard let marker = release.marker else { return }
        let url = folder.appendingPathComponent(marker, isDirectory: false)
        let contents = release.revision + "\n"
        if let data = Self.readRegularFile(at: url.path), String(decoding: data, as: UTF8.self) == contents { return }
        do {
            try replaceFile(at: url, with: Data(contents.utf8))
        } catch {
            throw self.error(.writeFailed(relative(marker)))
        }
    }

    /// O_NONBLOCK so a FIFO planted at the path cannot hang the open.
    private static func readRegularFile(at path: String) -> Data? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var status = stat()
        guard fstat(fd, &status) == 0, Stat(status).isRegular else { return nil }
        return try? FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd()
    }

    private func replaceFile(at url: URL, with data: Data) throws {
        let temporary = try prepareTemporaryDirectory().appendingPathComponent(UUID().uuidString, isDirectory: false)
        try data.write(to: temporary, options: [.withoutOverwriting])
        try Self.rename(temporary, to: url)
    }

    private var temporaryDirectory: URL { folder.appendingPathComponent(Self.temporaryDirectoryName, isDirectory: true) }

    private func prepareTemporaryDirectory() throws -> URL {
        let path = temporaryDirectory.path
        if case .present(let status) = Self.lstat(path) {
            guard status.isDirectory else { throw error(.blocked(path: relative(Self.temporaryDirectoryName))) }
            for name in (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? [] {
                unlink(temporaryDirectory.appendingPathComponent(name).path)
            }
            return temporaryDirectory
        }
        do {
            try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        } catch {
            throw self.error(.writeFailed(relative(Self.temporaryDirectoryName)))
        }
        return temporaryDirectory
    }

    private func removeTemporaryDirectory() {
        guard case .present(let status) = Self.lstat(temporaryDirectory.path), status.isDirectory else { return }
        try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    private func install(_ staged: URL, at path: String) throws {
        let components = ModelPath.components(of: path) ?? []
        let target = folder.appendingPathComponent(path, isDirectory: false)
        do {
            for end in 1..<max(components.count, 1) {
                let directory = folder.appendingPathComponent(components[0..<end].joined(separator: "/"), isDirectory: true)
                switch Self.lstat(directory.path) {
                case .absent: try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                case .present(let status) where status.isDirectory: continue
                default: throw error(.blocked(path: relative(components[0..<end].joined(separator: "/"))))
                }
            }
            try Self.rename(staged, to: target)
            for leftover in Self.fluidAudioLeftovers(of: path) {
                unlink(folder.appendingPathComponent(leftover).path)
            }
        } catch let error as ModelCacheError {
            unlink(staged.path)
            throw error
        } catch {
            unlink(staged.path)
            throw self.error(.writeFailed(relative(path)))
        }
    }

    private static func rename(_ source: URL, to target: URL) throws {
        guard Darwin.rename(source.path, target.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}
