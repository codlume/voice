import { createHeadlessEditor } from "@lexical/headless";
import { withDOM } from "@lexical/headless/dom";
import { $createLinkNode } from "@lexical/link";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vite-plus/test";

import { isSnippetHtml } from "../shared/snippets.ts";

import {
  $readSnippetText,
  $writeSnippetText,
  hrefFromInput,
  snippetNodes,
  type SnippetText,
} from "./snippetText.ts";

function editor() {
  return createHeadlessEditor({
    nodes: snippetNodes,
    onError: (error) => {
      throw error;
    },
  });
}

function reload(text: SnippetText): SnippetText {
  const loaded = editor();
  withDOM(() => loaded.update(() => $writeSnippetText(text), { discrete: true }));
  const written = loaded.read($readSnippetText);
  if (written.expansionHtml !== null) expect(isSnippetHtml(written.expansionHtml)).toBe(true);
  return written;
}

const html = (expansionHtml: string) => reload({ expansion: "", expansionHtml });

describe("snippet text", () => {
  it("keeps plain multi-line text plain", () => {
    const text = { expansion: "Ada Lovelace\n\n  12 Marylebone Road\nLondon", expansionHtml: null };
    expect(reload(text)).toEqual(text);
  });

  it("round trips every supported format unchanged", () => {
    const saved = {
      expansion: [
        "Hi Ada, see both",
        "- one",
        "- two",
        "1. first",
        "2. second",
        "",
        "Visit our site (https://example.com/a?b=1&c=2), mail a@example.com",
      ].join("\n"),
      expansionHtml:
        "<p>Hi <strong>Ada</strong>, <em>see</em> <strong><em>both</em></strong></p>" +
        "<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol><p><br></p>" +
        '<p>Visit <a href="https://example.com/a?b=1&amp;c=2">our site</a>, mail ' +
        '<a href="mailto:a@example.com">a@example.com</a></p>',
    };
    expect(reload(saved)).toEqual(saved);
    expect(reload(reload(saved))).toEqual(saved);
  });

  it("keeps empty lines, trailing line breaks, and repeated spaces through a reload", () => {
    const saved = {
      expansion: "a\n\n\n  b  c ",
      expansionHtml: "<p>a<br><br></p><p><br></p><p>  <strong>b  c</strong> </p>",
    };
    expect(reload(saved)).toEqual(saved);
  });

  it("escapes text and attribute values", () => {
    expect(html('<p><strong>a &lt; b &amp; "c" &gt; d</strong></p>')).toEqual({
      expansion: 'a < b & "c" > d',
      expansionHtml: "<p><strong>a &lt; b &amp; &quot;c&quot; &gt; d</strong></p>",
    });
    expect(html('<p><a href="https://example.com/?q=&quot;x&quot;">x</a></p>').expansionHtml).toBe(
      '<p><a href="https://example.com/?q=&quot;x&quot;">x</a></p>',
    );
  });

  it("drops links whose scheme cannot be stored to plain text", () => {
    const written = editor();
    written.update(
      () => {
        const paragraph = $createParagraphNode();
        for (const url of ["javascript:alert(1)", "ftp://example.com", "file:///etc/passwd"]) {
          paragraph.append($createLinkNode(url).append($createTextNode("go")));
        }
        $getRoot().clear().append(paragraph);
      },
      { discrete: true },
    );
    expect(written.read($readSnippetText)).toEqual({ expansion: "gogogo", expansionHtml: null });
  });

  it("writes a link as its URL when the text is the URL, else as text (url)", () => {
    expect(
      html(
        '<p><a href="https://example.com">https://example.com</a> ' +
          '<a href="https://example.com">site</a> <a href="mailto:a@example.com">mail me</a></p>',
      ).expansion,
    ).toBe("https://example.com site (https://example.com) mail me (a@example.com)");
  });

  it("marks list items in the plain text and flattens nested lists", () => {
    expect(
      html("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol><li>x</li><li>y</li></ol>"),
    ).toEqual({
      expansion: "- a\n- b\n- c\n1. x\n2. y",
      expansionHtml: "<ul><li>a</li><li>b</li><li>c</li></ul><ol><li>x</li><li>y</li></ol>",
    });
  });

  it("keeps only the supported subset of foreign HTML", () => {
    expect(
      html(
        '<h1 class="t" style="color:red">Title</h1><p dir="ltr"><u>under</u> <s>struck</s> ' +
          '<code>code</code> <b style="color:red">bold</b></p>',
      ),
    ).toEqual({
      expansion: "Title\nunder struck code bold",
      expansionHtml: "<p>Title</p><p>under struck code <strong>bold</strong></p>",
    });
  });

  it("is plain when the only content is unformatted, and empty when there is none", () => {
    expect(html("<p>just text</p><p><br></p>")).toEqual({
      expansion: "just text\n",
      expansionHtml: null,
    });
    expect(reload({ expansion: "", expansionHtml: null })).toEqual({
      expansion: "",
      expansionHtml: null,
    });
  });
});

describe("link row input", () => {
  it("adds a scheme the user left out and refuses ones that cannot be stored", () => {
    expect(hrefFromInput(" example.com/docs ")).toBe("https://example.com/docs");
    expect(hrefFromInput("ada@example.com")).toBe("mailto:ada@example.com");
    expect(hrefFromInput("http://example.com")).toBe("http://example.com");
    expect(hrefFromInput("javascript:alert(1)")).toBeNull();
    expect(hrefFromInput("ftp://example.com")).toBeNull();
    expect(hrefFromInput("   ")).toBeNull();
  });
});
