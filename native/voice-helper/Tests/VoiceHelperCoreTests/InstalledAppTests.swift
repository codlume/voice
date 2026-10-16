import Testing
@testable import VoiceHelperCore

@Suite struct InstalledAppTests {
    private let path = "/Applications/Slack.app"
    private let notABrowser: (String) -> Bool = { _ in false }

    @Test func usesTheDisplayNameWhenPresent() {
        let info: [String: Any] = ["CFBundleIdentifier": "com.tinyspeck.slackmacgap", "CFBundleDisplayName": " Slack ", "CFBundleName": "SlackName"]
        #expect(installedApp(info: info, path: path, modifiedMs: 1, isBrowser: notABrowser) == InstalledApp(bundleId: "com.tinyspeck.slackmacgap", name: "Slack", path: path, modifiedMs: 1, browser: false))
    }

    @Test func stripsInvisibleFormatCharactersFromTheName() {
        let info: [String: Any] = ["CFBundleIdentifier": "net.whatsapp.WhatsApp", "CFBundleDisplayName": "\u{200E}WhatsApp", "CFBundleName": "WhatsApp"]
        #expect(installedApp(info: info, path: "/Applications/WhatsApp.app", modifiedMs: 1, isBrowser: notABrowser)?.name == "WhatsApp")
    }

    @Test func fallsBackToTheBundleName() {
        let info: [String: Any] = ["CFBundleIdentifier": "com.tinyspeck.slackmacgap", "CFBundleName": "SlackName"]
        #expect(installedApp(info: info, path: path, modifiedMs: 1, isBrowser: notABrowser)?.name == "SlackName")
    }

    @Test func skipsABlankOrNonStringDisplayName() {
        for displayName: Any in [" ", "", "\n", "\u{200E}", 42] {
            let info: [String: Any] = ["CFBundleIdentifier": "com.tinyspeck.slackmacgap", "CFBundleDisplayName": displayName, "CFBundleName": "SlackName"]
            #expect(installedApp(info: info, path: path, modifiedMs: 1, isBrowser: notABrowser)?.name == "SlackName")
        }
    }

    @Test func fallsBackToTheFileNameWithoutTheAppExtension() {
        let info: [String: Any] = ["CFBundleIdentifier": "com.microsoft.teams2", "CFBundleDisplayName": "", "CFBundleName": "  "]
        #expect(installedApp(info: info, path: "/Applications/Microsoft Teams.app", modifiedMs: 1, isBrowser: notABrowser)?.name == "Microsoft Teams")
    }

    @Test func flagsABrowserByItsBundleId() {
        let chrome: [String: Any] = ["CFBundleIdentifier": "com.google.Chrome", "CFBundleName": "Google Chrome"]
        let isBrowser = { (id: String) in id == "com.google.Chrome" }
        #expect(installedApp(info: chrome, path: "/Applications/Google Chrome.app", modifiedMs: 1, isBrowser: isBrowser)?.browser == true)
        let slack: [String: Any] = ["CFBundleIdentifier": "com.tinyspeck.slackmacgap", "CFBundleName": "Slack"]
        #expect(installedApp(info: slack, path: path, modifiedMs: 1, isBrowser: isBrowser)?.browser == false)
    }

    @Test func keepsTheBundleIdCase() {
        let info: [String: Any] = ["CFBundleIdentifier": "net.WhatsApp.WhatsApp", "CFBundleName": "WhatsApp"]
        #expect(installedApp(info: info, path: "/Applications/WhatsApp.app", modifiedMs: 1, isBrowser: notABrowser)?.bundleId == "net.WhatsApp.WhatsApp")
    }

    @Test func skipsABundleWithoutAUsableId() {
        #expect(installedApp(info: ["CFBundleName": "Slack"], path: path, modifiedMs: 1, isBrowser: notABrowser) == nil)
        for bundleId: Any in ["", "   ", 7] {
            #expect(installedApp(info: ["CFBundleIdentifier": bundleId, "CFBundleName": "Slack"], path: path, modifiedMs: 1, isBrowser: notABrowser) == nil)
        }
    }
}
