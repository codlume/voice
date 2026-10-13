// The snippet HTML contract: what the editor writes, what loading accepts, and what a paste
// composes, all from one tag list and one link rule.

const TAGS = ["p", "br", "strong", "em", "ul", "ol", "li", "a"];

export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const unescapeHtml = (html: string) =>
  html
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");

/**
 * The link to store for `raw`, or null unless it is an http, https, or mailto URL. The scheme is
 * checked as literal text, so what a URL parser would ignore around it (a pasted " https://x" or
 * "ht\ttps://x") is removed first, and the cleaned link is what gets stored.
 */
export function allowedHref(raw: string): string | null {
  // As the URL parser does: tabs and newlines anywhere, spaces and controls at the ends.
  // eslint-disable-next-line no-control-regex
  const href = raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  return /^(?:https?:|mailto:.)/i.test(href) && URL.canParse(href) ? href : null;
}

const SNIPPET_TAG = new RegExp(`</?(?:${TAGS.join("|")})>|<a href="([^"<>]*)">`, "gi");

// The editor escapes every < and > in text, so markup outside the allowed tags is not ours.
export function isSnippetHtml(html: string): boolean {
  let links = true;
  const rest = html.replace(SNIPPET_TAG, (_tag, attribute?: string) => {
    if (attribute !== undefined) {
      const href = unescapeHtml(attribute);
      links &&= allowedHref(href) === href;
    }
    return "";
  });
  return links && !/[<>]/.test(rest);
}

// Cocoa targets give each pasted paragraph spacing and end the last one with a newline the plain
// text lacks. Paragraphs become lines joined by <br>; lists stay blocks. The editor ends a line
// with a filler <br> that is redundant before another line or at the snippet's end.
export function paragraphsAsLines(html: string): string {
  return html
    .replace(/<br><\/p>(?=<p>|$)/gi, "</p>")
    .replace(/<\/p><p>/gi, "<br>")
    .replace(/<\/?p>/gi, "");
}
