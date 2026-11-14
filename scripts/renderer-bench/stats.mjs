export function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const spread = (values) => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
});

/** Least-squares growth per step of evenly spaced samples. */
export function slope(values) {
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  const rise = values.reduce((sum, value, x) => sum + (x - meanX) * (value - meanY), 0);
  const run = values.reduce((sum, _value, x) => sum + (x - meanX) ** 2, 0);
  return rise / run;
}

/** The methods one of the app's preloads (apps/desktop/src/preload/*.ts) puts on `window.voice`. */
export function bridgeMethods(preloadSource) {
  const bridge = /^const voice: \w+ = \{\n(.*?)^\};/ms.exec(preloadSource)?.[1] ?? "";
  return Array.from(bridge.matchAll(/^ {2}(\w+): \(/gm), ([, name = ""]) => name);
}

/** The JS and CSS files a built page loads before it runs: its script, preloads and stylesheets. */
export function entryAssets(html) {
  const tags = html.match(/<(?:script|link)\b[^>]*>/g) ?? [];
  const files = tags.flatMap((tag) => {
    const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    const loads = tag.startsWith("<script") || /\brel="(?:modulepreload|stylesheet)"/.test(tag);
    return url && loads ? [url.replace(/^\.\//, "")] : [];
  });
  return {
    js: files.filter((file) => file.endsWith(".js")),
    css: files.filter((file) => file.endsWith(".css")),
  };
}

export function format(value) {
  const digits = Number.isInteger(value) || Math.abs(value) >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const range = (side) =>
  side.min === side.max
    ? format(side.median)
    : `${format(side.median)} (${format(side.min)}–${format(side.max)})`;

/**
 * One markdown row per metric: its median, its range over the runs, and the build it came from.
 * A metric is named `scenario | metric`, which fills the first two columns.
 */
export function table(metrics) {
  const rows = Object.entries(metrics).map(
    ([name, { build, values }]) => `| ${name} | ${range(spread(values))} | ${build} |`,
  );
  const head = ["| scenario | metric | median (min–max) | build |", "| --- | --- | ---: | --- |"];
  return [...head, ...rows].join("\n");
}

/**
 * Before and after, metric by metric. Two sides whose ranges over the runs overlap show no
 * measurable difference, whatever their medians say. A metric only one side has is `missing`,
 * never a match.
 */
export function compare(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(names, (name) => {
    const a = before[name] && spread(before[name].values);
    const b = after[name] && spread(after[name].values);
    if (!a || !b) return { name, a, b, change: null, verdict: "missing" };
    const change = a.median === 0 ? null : (b.median - a.median) / a.median;
    const apart = b.max < a.min ? "lower" : b.min > a.max ? "higher" : null;
    const verdict = apart ?? (a.median === b.median ? "same" : "no measurable difference");
    return { name, a, b, change, verdict };
  });
}

const percent = (change) =>
  change === null ? "n/a" : `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;

export function compareTable(rows) {
  const lines = rows.map(
    ({ name, a, b, change, verdict }) =>
      `| ${name} | ${a ? range(a) : "missing"} | ${b ? range(b) : "missing"} | ${a && b ? percent(change) : "n/a"} | ${verdict} |`,
  );
  const head = [
    "| scenario | metric | before, median (min–max) | after, median (min–max) | change | verdict |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  ];
  return [...head, ...lines].join("\n");
}
