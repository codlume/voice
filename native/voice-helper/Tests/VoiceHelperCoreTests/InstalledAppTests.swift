import Testing
@testable import VoiceHelperCore

@Suite struct InstalledAppTests {
    private let path = "/Applications/Slack.app"

    @Test func usesTheDisplayNameWhenPresent() {
        let info: [String: Any] = ["CFBundleIdentifier": "com.tinyspeck.slackmacgap", "CFBundleDisplayName": " Slack ", "CFBundleName": "SlackName"]
        #expect(installedApp(info: info, path: path) == InstalledApp(bundleId: "com.tinyspeck.slackmacgap", name: "Slack", path: path))
    }

    @Test func stripsInvisibleFormatCharactersFromTheName() {
        let info: [String: Any] = ["CFBundleIdentifier": "net.whatsapp.WhatsApp", "CFBundleDisplayName": "\u{200E}WhatsApp", "CFBundleName": "WhatsApp"]
        #expect(installedApp(info: info, path: "/Applications/WhatsApp.app")?.name == "WhatsApp")
    }

    @Test func fallsBackToTheBundleName() {
        let info: [String: Any] = ["CFBundleIdentifier": "com.tinyspeck.slackmacgap", "CFBundleName": "SlackName"]
        #expect(installedApp(info: info, path: path)?.name == "SlackName")
    }

    @Test func skipsABlankOrNonStringDisplayName() {
        for displayName: Any in [" ", "", "\n", "\u{200E}", 42] {
            let info: [String: Any] = ["CFBundleIdentifier": "com.tinyspeck.slackmacgap", "CFBundleDisplayName": displayName, "CFBundleName": "SlackName"]
            #expect(installedApp(info: info, path: path)?.name == "SlackName")
        }
    }

    @Test func fallsBackToTheFileNameWithoutTheAppExtension() {
        let info: [String: Any] = ["CFBundleIdentifier": "com.microsoft.teams2", "CFBundleDisplayName": "", "CFBundleName": "  "]
        #expect(installedApp(info: info, path: "/Applications/Microsoft Teams.app")?.name == "Microsoft Teams")
    }

    @Test func keepsTheBundleIdCase() {
        let info: [String: Any] = ["CFBundleIdentifier": "net.WhatsApp.WhatsApp", "CFBundleName": "WhatsApp"]
        #expect(installedApp(info: info, path: "/Applications/WhatsApp.app")?.bundleId == "net.WhatsApp.WhatsApp")
    }

    @Test func skipsABundleWithoutAUsableId() {
        #expect(installedApp(info: ["CFBundleName": "Slack"], path: path) == nil)
        for bundleId: Any in ["", "   ", 7] {
            #expect(installedApp(info: ["CFBundleIdentifier": bundleId, "CFBundleName": "Slack"], path: path) == nil)
        }
    }
}
