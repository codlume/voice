// No fuse covers Chromium's own switches (--remote-debugging-port, --gpu-launcher,
// --browser-subprocess-path and the like), and its parser takes a single dash as well as two, so
// every dashed argument is refused unless it is one of the three a packaged launch is known to get.
const ALLOWED_LAUNCH_ARGUMENTS: ReadonlyArray<(argument: string) => boolean> = [
  (argument) => /^--user-data-dir=.+/.test(argument),
  (argument) => argument === "-ApplePersistenceIgnoreState",
  (argument) => argument.startsWith("-psn_"),
];

export function refusedLaunchArguments(args: readonly string[]): string[] {
  return args.filter(
    (argument) =>
      argument.startsWith("-") && !ALLOWED_LAUNCH_ARGUMENTS.some((allows) => allows(argument)),
  );
}

// FluidAudio reads http_proxy and https_proxy for its model downloads; they see only the CONNECT
// host of HTTPS traffic. Its other overrides (REGISTRY_URL, HF_TOKEN and so on) stay out.
const HELPER_ENV_NAMES = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TZ",
  "__CF_USER_TEXT_ENCODING",
  "http_proxy",
  "https_proxy",
]);

export function packagedHelperEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => HELPER_ENV_NAMES.has(name) || name.startsWith("LC_")),
  );
}
