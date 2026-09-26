import { readFileSync } from "node:fs";

// Nightlies are `-nightly.<YYYYMMDD>.<run>`. The feed may still serve the older `-nightly.<run>`.
export function parseVersion(value) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?))?$/.exec(
      value,
    );
  if (!match) throw new Error(`Invalid Voice release version: ${value}`);
  return {
    major: +match[1],
    minor: +match[2],
    patch: +match[3],
    nightly: match[4] === undefined ? null : match[4].split(".").map(Number),
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
  for (let index = 0; index < Math.min(a.nightly.length, b.nightly.length); index += 1) {
    if (a.nightly[index] !== b.nightly[index])
      return Math.sign(a.nightly[index] - b.nightly[index]);
  }
  return Math.sign(a.nightly.length - b.nightly.length);
}

export function nightlyVersion(stable, date, runNumber) {
  const base = parseVersion(stable);
  if (base.nightly !== null || !/^2\d{7}$/.test(date) || !/^[1-9]\d*$/.test(String(runNumber))) {
    throw new Error("Nightly requires a stable base, a YYYYMMDD date, and a positive run number");
  }
  return `${base.major}.${base.minor}.${base.patch + 1}-nightly.${date}.${runNumber}`;
}

if (process.argv[1]?.endsWith("/release-version.mjs")) {
  const stable = JSON.parse(readFileSync("package.json", "utf8")).version;
  const desktop = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version;
  if (stable !== desktop) throw new Error("Root and desktop stable versions differ");
  const channel = process.argv[2];
  const version =
    channel === "nightly"
      ? nightlyVersion(
          stable,
          new Date().toISOString().slice(0, 10).replaceAll("-", ""),
          process.env.GITHUB_RUN_NUMBER,
        )
      : channel === "stable"
        ? stable
        : (() => {
            throw new Error("Expected stable or nightly");
          })();
  console.log(version);
}
