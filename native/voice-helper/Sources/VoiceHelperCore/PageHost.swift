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
    return isHostname(host) ? host : nil
}

/// A DNS hostname per RFC 1123: labels of letters, digits, and hyphens, 1 to 63 characters, no
/// hyphen at either end, 253 characters in all. Anything else, including IP literals and
/// percent-encoding, is not a host that classification can key on.
private func isHostname(_ host: String) -> Bool {
    guard !host.isEmpty, host.utf8.count <= 253 else { return false }
    return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
        (1...63).contains(label.count) && label.first != "-" && label.last != "-"
            && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }
}
