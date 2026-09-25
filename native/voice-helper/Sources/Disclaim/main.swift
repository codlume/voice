import Darwin

// Runs a command as its own responsible process:
//   disclaim <command> [args...]
// Stdio is inherited, SIGTERM, SIGINT and SIGHUP are forwarded, and the exit code is the
// child's (128 + signal when it was killed).
//
// macOS charges every microphone or accessibility request to the responsible process. For a
// terminal-launched Electron that is the terminal app, and a hardened-runtime terminal without
// the audio-input entitlement makes tccd deny the request before any prompt. Disclaiming
// responsibility is the private spawn attribute Chromium uses so the child answers for itself.
// There is no public API for it.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(
    _ attributes: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32
) -> Int32

let command = Array(CommandLine.arguments.dropFirst())
guard let executable = command.first else {
    fputs("usage: disclaim <command> [args...]\n", stderr)
    exit(64)
}

var attributes: posix_spawnattr_t?
posix_spawnattr_init(&attributes)
guard responsibility_spawnattrs_setdisclaim(&attributes, 1) == 0 else {
    fputs("disclaim: responsibility_spawnattrs_setdisclaim failed\n", stderr)
    exit(70)
}

var argv: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) } + [nil]
nonisolated(unsafe) var child: pid_t = 0
let spawnError = posix_spawnp(&child, executable, nil, &attributes, &argv, environ)
guard spawnError == 0 else {
    fputs("disclaim: \(executable): \(String(cString: strerror(spawnError)))\n", stderr)
    exit(127)
}

for forwarded in [SIGTERM, SIGINT, SIGHUP] {
    signal(forwarded) { received in kill(child, received) }
}

var status: Int32 = 0
while waitpid(child, &status, 0) < 0 {
    guard errno == EINTR else {
        perror("disclaim: waitpid")
        exit(70)
    }
}
let terminatingSignal = status & 0x7f
exit(terminatingSignal == 0 ? (status >> 8) & 0xff : 128 + terminatingSignal)
