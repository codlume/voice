# Permissions

Dictation needs two macOS permissions: Accessibility, so the helper's event tap hears the shortcut, and the microphone, so capture can start. When either one is missing, Voice says so where the user already looks and offers the fix there. Home's setup checklist covers first-time setup. This file covers a permission that is missing later.

## Sub-features

- `permission-mic-refused`: a session whose capture fails with `capture.failed` reason `permission` ends in the Flow Bar's `allow` look, "Microphone is off. Click to allow". It stays for 6 s, instead of the usual 2.5 s for an error. Clicking it asks for the microphone, or opens System Settings > Privacy & Security > Microphone once the user has said no. The session's outcome is `permissionMissing`, and main asks the helper for permissions again so the tray learns about it.
- `permission-tray`: while Accessibility or the microphone is not `granted`, the tray icon shows a dot and the menu opens with `Shortcut off: allow Accessibility…` (`allow-accessibility`) and `Microphone off: allow access…` (`allow-microphone`), shortcut first, then a separator. It works with the Voice window closed. Nothing shows before the helper's first `permissions` report.
- `permission-watch`: the helper checks `AXIsProcessTrusted` every 2 s. When the answer changes it removes or installs the hotkey tap and emits `permissions`. Removing the tap ends a held shortcut, so the mic does not stay open. A grant takes up to about 3 s to register.

## How to get to it (user POV)

- Turn off Voice's microphone access in System Settings, then press the dictation shortcut.
- Turn off Voice's Accessibility access, then open the menu bar icon.

## Driving it with voice-verify

A test instance never reads the microphone, and only a person can grant Accessibility, so run the fake helper. Its control socket takes a `permissions` line and merges it into what `permissions.check` answers. `captureFailure` makes every `capture.start` fail.

```sh
V=.claude/skills/verify/scripts/voice-verify.mjs
S="$TMPDIR/vf-perm.sock"
VOICE_HELPER_PATH=$PWD/apps/desktop/src/main/testing/fake-helper.ts \
VOICE_FAKE_HELPER="{\"control\":\"$S\",\"permissions\":{\"microphone\":\"denied\"},\"captureFailure\":{\"reason\":\"permission\",\"message\":\"microphone access is not granted\"}}" \
  node $V launch
```

### Microphone refused

`permission-mic-refused`:

```sh
printf 'down\n' | nc -U -w1 "$S"
node $V wait pill 'document.querySelector("[role=status]")?.dataset.view === "allow"' 3000
node $V shot mic-refused pill
printf 'up\n' | nc -U -w1 "$S"
node $V click "Microphone is off. Click to allow" pill
grep "permissions: opening System Settings for microphone" "$LOG"   # main.log from the launch output
```

A test instance logs instead of opening System Settings. Without the click the pill goes back to `idle` after about 6 s.

### Tray

`permission-tray`, with the window closed:

```sh
node $V eval hub 'window.close()'
printf '{"type":"permissions","microphone":"granted","accessibility":"denied"}\n' | nc -U -w1 "$S"
node $V tray                        # allow-accessibility first, then the usual items
node $V tray allow-accessibility    # logs "opening System Settings for accessibility"
printf '{"type":"permissions","accessibility":"notDetermined"}\n' | nc -U -w1 "$S"
node $V tray allow-accessibility    # the fake helper answers Allow, and the item goes away
```

`globalThis.voiceTest.trayIconPng()` in main returns the tray icon as base64 PNG, so you can see the dot.

Stop with `node $V stop`.

`permission-watch` has no live recipe. `swift test --filter PermissionsWatchTests` covers revoke, grant, and no change with an injected `isTrusted`. To watch the real helper's timer, run it under `disclaim`, as the comment in `native/voice-helper/scripts/start-latency.mjs` shows, so Electron answers for the grant. Do not reset the TCC grants of the installed Voice.app or of the host app.
