import rules from "../public/_headers?raw";

export function parseSingleRule(file: string): Record<string, string> {
  const [path, ...lines] = file.trim().split("\n");
  if (path !== "/*" || lines.some((line) => !/^\s+[^\s:]+:\s*\S/.test(line)))
    throw new Error("public/_headers must hold exactly one rule, for /*");
  return Object.fromEntries(
    lines.map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

// Workers Assets applies public/_headers to the prerendered pages and files it serves. The
// server-rendered page comes from the Worker instead, so the middleware sets the same headers.
export const securityHeaders = parseSingleRule(rules);
