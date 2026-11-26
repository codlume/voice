const flag = (flags, name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);

export function parseDictateFlags(flags) {
  const end = flag(flags, "end") ?? "audio";
  if (!["audio", "escape", "escape-processing", "immediate"].includes(end)) {
    throw new Error("--end must be audio, escape, escape-processing, or immediate");
  }
  const mode = flag(flags, "key") ?? "hold";
  if (!["hold", "toggle"].includes(mode)) throw new Error("--key must be hold or toggle");
  const delayFlag = flag(flags, "asr-delay");
  const asrDelayMs = delayFlag === undefined ? null : Number(delayFlag);
  if (asrDelayMs !== null && !(Number.isInteger(asrDelayMs) && asrDelayMs >= 0)) {
    throw new Error("--asr-delay must be a whole number of ms");
  }
  const appFlag = flag(flags, "app");
  if (appFlag === undefined) return { end, mode, app: null, asrDelayMs };
  const [bundleId, host, ...rest] = appFlag.split("@");
  if (!bundleId || host === "" || rest.length > 0) {
    throw new Error("--app must be <bundleId> or <bundleId>@<host>");
  }
  return { end, mode, app: { bundleId, host: host ?? null }, asrDelayMs };
}
