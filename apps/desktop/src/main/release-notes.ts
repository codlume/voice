const MAX_ITEMS = 30;
const MAX_ITEM_LENGTH = 240;

export function releaseNoteItems(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const items: string[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#+\s*New Contributors\b/i.test(line)) break;
    const bullet = /^[*-] (.*)$/.exec(line)?.[1];
    if (bullet === undefined) continue;
    const item = plainText(bullet);
    if (!item || items.includes(item)) continue;
    items.push(item);
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

function plainText(markdown: string): string {
  const text = markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\S*/g, "#$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ITEM_LENGTH ? `${text.slice(0, MAX_ITEM_LENGTH - 1).trimEnd()}…` : text;
}
