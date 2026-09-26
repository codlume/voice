import { readFileSync } from "node:fs";

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) throw new Error(`Invalid Voice release version: ${value}`);
  return {
    major: +match[1],
    minor: +match[2],
    patch: +match[3],
    nightly: match[4] === undefined ? null : +match[4],
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return Math.sign(a[field] - b[field]);
  }
  if (a.nightly === null) return b.nightly === null ? 0 : 1;
  if (b.nightly === null) return -1;
  return Math.sign(a.nightly - b.nightly);
}

export function nightlyVersion(stable, runNumber) {
  const base = parseVersion(stable);
  if (base.nightly !== null || !/^[1-9]\d*$/.test(String(runNumber))) {
    throw new Error("Nightly requires a stable base and positive workflow run number");
  }
  return `${base.major}.${base.minor}.${base.patch + 1}-nightly.${runNumber}`;
}

if (process.argv[1]?.endsWith("/release-version.mjs")) {
  const stable = JSON.parse(readFileSync("package.json", "utf8")).version;
  const desktop = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version;
  if (stable !== desktop) throw new Error("Root and desktop stable versions differ");
  const channel = process.argv[2];
  const version =
    channel === "nightly"
      ? nightlyVersion(stable, process.env.GITHUB_RUN_NUMBER)
      : channel === "stable"
        ? stable
        : (() => {
            throw new Error("Expected stable or nightly");
          })();
  console.log(version);
}
