/// Reduces a page URL to its host so the full URL never leaves the helper: http(s) only, no
/// userinfo, port, path, query, fragment, or trailing dot. `isRFC1123Hostname` keeps non-hosts
/// (spaces, percent-encoding, IPv6 brackets) off the wire; an IPv4 literal passes because it is
/// valid hostname syntax. Main parses the host again at its protocol boundary and owns the rule
/// for what classification may key on.
public func pageHost(_ url: String) -> String? {
    guard let schemeEnd = url.range(of: "://") else { return nil }
    let scheme = url[..<schemeEnd.lowerBound].lowercased()
    guard scheme == "http" || scheme == "https" else { return nil }
    var authority = url[schemeEnd.upperBound...]
    if let end = authority.firstIndex(where: { "/?#".contains($0) }) {
        authority = authority[..<end]
    }
    if let at = authority.lastIndex(of: "@") {
        authority = authority[authority.index(after: at)...]
    }
    var host = authority[..<(authority.firstIndex(of: ":") ?? authority.endIndex)].lowercased()
    if host.last == "." { host.removeLast() }
    return isRFC1123Hostname(host) ? host : nil
}

private func isRFC1123Hostname(_ host: String) -> Bool {
    guard !host.isEmpty, host.utf8.count <= 253 else { return false }
    return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
        (1...63).contains(label.count) && label.first != "-" && label.last != "-"
            && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }
}

/// The page host of a session's target. The read runs off main after the focus snapshot and
/// publishes here; the transcript takes whatever is known when it goes out.
public enum HostRead: Equatable, Sendable {
    case pending
    case read(String?)

    /// A read keyed on input that has since changed may describe another tab, so it publishes
    /// nil. A read that lands after the transcript took the target changes nothing.
    public mutating func publish(_ host: String?, inputUnchanged: Bool) {
        guard case .pending = self else { return }
        self = .read(inputUnchanged ? host : nil)
    }

    /// A read still running is unknown from here on, and whatever it publishes later is dropped.
    public mutating func settle() {
        if case .pending = self { self = .read(nil) }
    }

    public mutating func take() -> String? {
        settle()
        guard case .read(let host) = self else { return nil }
        return host
    }
}
