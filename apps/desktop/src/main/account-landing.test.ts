import { runInNewContext } from "node:vm";

import { describe, expect, test } from "vite-plus/test";

import { landingPage } from "../../../api/src/landing.ts";
import { parseCallbackUrl, parseSignInCode } from "./account.ts";

// The only test that reads across the two apps. It pins the landing page's URL literal to the
// desktop's parsers, so neither side can change the code's shape alone.
// The API's landing page and the desktop's parsers agree on one code: the `better-auth.electron`
// cookie value as the page shows it. The server stores base64url JSON with padding and the cookie
// serializer percent-encodes the padding, so the value ends in %3D. The plugin's `authenticate`
// decodes it once (decodeURIComponent, then base64url).
describe("sign-in code across the landing page and the account module", () => {
  // The server's identifier is 32 characters and the plugin's state 16, which pads the base64;
  // an 18-character state does not, so both shapes are covered.
  test.each([
    { state: "ABCDEFGHIJKLMNOP", padded: true },
    { state: "ABCDEFGHIJKLMNOPQR", padded: false },
  ])(
    "the pasted code, the automatic callback and the Open Voice link carry one code the plugin can decode (padded: $padded)",
    ({ state, padded }) => {
      const claims = { identifier: "A".repeat(32), state };
      const cookieValue = encodeURIComponent(
        Buffer.from(JSON.stringify(claims)).toString("base64"),
      );
      expect(cookieValue.endsWith("%3D")).toBe(padded);

      const script = landingPage.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
      const elements: Record<string, Record<string, unknown>> = {
        "signed-in": { hidden: true },
        expired: { hidden: true },
        open: { href: "" },
        code: { textContent: "" },
        copy: { addEventListener() {} },
      };
      let opened = "";
      runInNewContext(script, {
        document: {
          cookie: `better-auth.state=s; better-auth.electron=${cookieValue}`,
          getElementById: (id: string) => elements[id],
        },
        fetch: () => Promise.resolve(new Response()),
        location: {
          replace: (url: string) => {
            opened = url;
          },
        },
      });

      const shown = elements.code?.textContent;
      expect(shown).toBe(cookieValue);
      expect(parseSignInCode(String(shown))).toEqual({ code: cookieValue, state });
      expect(parseCallbackUrl(opened)).toEqual({ code: cookieValue, state });
      expect(parseCallbackUrl(String(elements.open?.href))).toEqual({ code: cookieValue, state });
      expect(
        JSON.parse(Buffer.from(decodeURIComponent(cookieValue), "base64url").toString("utf8")),
      ).toEqual(claims);
    },
  );
});
