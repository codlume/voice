import { describe, expect, test } from "vite-plus/test";

import { allowedHref, escapeHtml, isSnippetHtml } from "./snippet-html.ts";

const link = (href: string) => `<p><a href="${escapeHtml(href)}">x</a></p>`;

describe("allowedHref", () => {
  test.each([" https://example.com", "\nhttps://example.com", "ht\ttps://example.com"])(
    "a pasted link %j is stored without its whitespace",
    (raw) => {
      expect(allowedHref(raw)).toBe("https://example.com");
    },
  );

  test("keeps http, https, and mailto links as written", () => {
    for (const href of [
      "http://example.com",
      "HTTPS://Example.com/a?b=1&c=2",
      "mailto:ada@example.com",
    ]) {
      expect(allowedHref(href)).toBe(href);
    }
  });

  test.each([
    "javascript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "ftp://example.com",
    "data:text/html,x",
    "example.com",
    "https://",
    "mailto:",
    " mailto: ",
    "",
  ])("refuses %j", (raw) => {
    expect(allowedHref(raw)).toBeNull();
  });
});

describe("isSnippetHtml", () => {
  test("accepts every link allowedHref returns, as the editor writes it", () => {
    for (const raw of [
      " https://example.com",
      '\nhttps://example.com/?q="x"&r=<y>',
      "ht\ttps://example.com",
      "mailto:ada@example.com",
      "https:example.com",
    ]) {
      const href = allowedHref(raw);
      expect(href).not.toBeNull();
      expect(isSnippetHtml(link(href!))).toBe(true);
    }
  });

  test("refuses a link allowedHref would change or refuse", () => {
    for (const href of [" https://example.com", "https://exa\tmple.com", "javascript:x"]) {
      expect(isSnippetHtml(link(href))).toBe(false);
    }
  });

  test("refuses tags and attributes outside the subset", () => {
    expect(isSnippetHtml("<p><strong>a</strong><br><em>b</em></p><ul><li>c</li></ul>")).toBe(true);
    expect(isSnippetHtml('<p style="color:red">x</p>')).toBe(false);
    expect(isSnippetHtml('<img src="x" onerror="y">')).toBe(false);
    expect(isSnippetHtml('<a href="https://example.com" target="_blank">x</a>')).toBe(false);
  });
});
