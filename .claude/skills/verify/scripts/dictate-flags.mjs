const flag = (flags, name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);

export function parseDictateFlags(flags) {
  const end = flag(flags, "end") ?? "audio";
  if (!["audio", "escape", "immediate"].includes(end)) {
    throw new Error("--end must be audio, escape, or immediate");
  }
  const mode = flag(flags, "key") ?? "hold";
  if (!["hold", "toggle"].includes(mode)) throw new Error("--key must be hold or toggle");
  const appFlag = flag(flags, "app");
  if (appFlag === undefined) return { end, mode, app: null };
  const [bundleId, host, ...rest] = appFlag.split("@");
  if (!bundleId || host === "" || rest.length > 0) {
    throw new Error("--app must be <bundleId> or <bundleId>@<host>");
  }
  return { end, mode, app: { bundleId, host: host ?? null } };
}
