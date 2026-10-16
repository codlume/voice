import { readFileSync } from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { BROWSER_BUNDLE_IDS, parseBundleId } from "./app-categories.ts";

const SWIFT = "native/voice-helper/Sources/VoiceHelper/TargetHost.swift";

test("the browser list matches the helper's", () => {
  const source = readFileSync(NodePath.join(import.meta.dirname, "../../../..", SWIFT), "utf8");
  const literal = /browserBundleIds: Set<String> = \[([^\]]*)\]/.exec(source)?.[1];
  expect(literal, `browserBundleIds not found in ${SWIFT}`).toBeDefined();
  const swift = [...(literal ?? "").matchAll(/"([^"]+)"/g)].map(([, id = ""]) => parseBundleId(id));
  expect(
    new Set(swift),
    `BROWSER_BUNDLE_IDS in apps/desktop/src/shared/app-categories.ts must equal browserBundleIds in ${SWIFT}`,
  ).toEqual(BROWSER_BUNDLE_IDS);
});
