import Testing
@testable import VoiceHelperCore

private let longestLabel = String(repeating: "a", count: 63)
/// Four 61-character labels, four dots, and a 5-character label: 253 characters exactly.
private let longestHost = ([String](repeating: String(repeating: "a", count: 61), count: 4) + ["abcde"]).joined(separator: ".")

@Suite struct PageHostTests {
    @Test(arguments: [
        ("https://Mail.Google.com:443/u/0", "mail.google.com"),
        ("https://user:pw@Example.com./", "example.com"),
        ("HTTP://EXAMPLE.COM", "example.com"),
        ("https://duckduckgo.com/?q=voice#top", "duckduckgo.com"),
        ("http://localhost:3000/app", "localhost"),
        ("https://192.168.0.1/admin", "192.168.0.1"),
        ("https://xn--bcher-kva.example/", "xn--bcher-kva.example"),
        ("https://\(longestLabel).example/", "\(longestLabel).example"),
        ("https://\(longestHost)/", longestHost),
    ])
    func reducesHttpUrlsToTheirHost(url: String, host: String) {
        #expect(pageHost(url) == host)
    }

    @Test(arguments: [
        "about:blank",
        "file:///x",
        "chrome://settings",
        "",
        "garbage",
        "https://",
        "https:///path",
        "https://user@",
        "https://bücher.example/",
        "ftp://example.com/",
        "https://.",
        #"https://example.com\private\secret"#,
        "https://foo bar/",
        "https://mail%2Egoogle.com/",
        "http://[::1]:8080/",
        "https://-bad.example.com/",
        "https://bad-.example.com/",
        "https://a..b/",
        "https://\(longestLabel)a.example/",
        "https://\(longestHost)a/",
    ])
    func rejectsEverythingElse(url: String) {
        #expect(pageHost(url) == nil)
    }
}

@Suite struct HostReadTests {
    @Test func publishesAHostReadOnUnchangedInput() {
        var read = HostRead.pending
        read.publish("docs.google.com", inputUnchanged: true)
        #expect(read == .read("docs.google.com"))
        #expect(read.take() == "docs.google.com")
    }

    @Test func dropsAHostReadAfterInputChanged() {
        var read = HostRead.pending
        read.publish("other.example", inputUnchanged: false)
        #expect(read == .read(nil))
    }

    @Test func aReadLandingAfterTheTranscriptChangesNothing() {
        var read = HostRead.pending
        #expect(read.take() == nil)
        read.publish("late.example", inputUnchanged: true)
        #expect(read == .read(nil))
        #expect(read.take() == nil)
    }

    @Test func settlingKeepsAPublishedHostAndEndsAPendingRead() {
        var published = HostRead.read("docs.google.com")
        published.settle()
        #expect(published == .read("docs.google.com"))
        var pending = HostRead.pending
        pending.settle()
        pending.publish("late.example", inputUnchanged: true)
        #expect(pending == .read(nil))
    }

    @Test func publishesOnce() {
        var read = HostRead.pending
        read.publish("first.example", inputUnchanged: true)
        read.publish("second.example", inputUnchanged: true)
        #expect(read.take() == "first.example")
    }
}
