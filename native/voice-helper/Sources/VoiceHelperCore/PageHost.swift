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
    var host: Substring
    if authority.first == "[", let close = authority.firstIndex(of: "]") {
        host = authority[...close]
    } else if let colon = authority.firstIndex(of: ":") {
        host = authority[..<colon]
    } else {
        host = authority
    }
    if host.last == "." { host.removeLast() }
    guard !host.isEmpty, host.allSatisfy(\.isASCII) else { return nil }
    return host.lowercased()
}
