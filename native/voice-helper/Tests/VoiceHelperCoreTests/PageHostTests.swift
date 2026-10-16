import Testing
@testable import VoiceHelperCore

@Suite struct PageHostTests {
    @Test(arguments: [
        ("https://Mail.Google.com:443/u/0", "mail.google.com"),
        ("https://user:pw@Example.com./", "example.com"),
        ("HTTP://EXAMPLE.COM", "example.com"),
        ("https://duckduckgo.com/?q=voice#top", "duckduckgo.com"),
        ("http://localhost:3000/app", "localhost"),
        ("http://[::1]:8080/", "[::1]"),
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
    ])
    func rejectsEverythingElse(url: String) {
        #expect(pageHost(url) == nil)
    }
}
