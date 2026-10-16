export const CATEGORIES = ["personal", "work", "email", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export type BundleId = string & { readonly __brand: "BundleId" };
export type Host = string & { readonly __brand: "Host" };

// Validating before lowercasing keeps characters like the Kelvin sign from lowercasing into ASCII.
export function parseBundleId(input: string): BundleId | null {
  const trimmed = input.trim();
  return /^[\x21-\x7e]+$/.test(trimmed) ? (trimmed.toLowerCase() as BundleId) : null;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

// Hand-rolled rather than `new URL`, whose IDNA and per-scheme rules would accept hosts we refuse.
export function parseHost(input: string): Host | null {
  let rest = input.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? "";
    rest = rest.slice(rest.lastIndexOf("@") + 1);
  } else if (/[@/]/.test(rest)) {
    return null;
  }
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    if (!/^\d+$/.test(rest.slice(colon + 1))) return null;
    rest = rest.slice(0, colon);
  }
  if (rest.endsWith(".")) rest = rest.slice(0, -1);
  const valid =
    rest.length >= 1 &&
    rest.length <= 253 &&
    rest.split(".").every((label) => label.length <= 63 && LABEL.test(label));
  return valid ? (rest.toLowerCase() as Host) : null;
}

type Rows = Record<Category, readonly (readonly [key: string, name: string])[]>;

const APPS: Rows = {
  personal: [
    ["com.apple.MobileSMS", "Messages"],
    ["net.whatsapp.WhatsApp", "WhatsApp"],
    ["ru.keepcoder.Telegram", "Telegram"],
    ["com.tdesktop.Telegram", "Telegram"],
    ["org.whispersystems.signal-desktop", "Signal"],
    ["com.facebook.archon", "Messenger"],
    ["im.beeper", "Beeper"],
    ["com.kishanbagaria.jack", "Texts"],
    ["com.tencent.xinWeChat", "WeChat"],
    ["com.hnc.Discord", "Discord"],
    ["com.discordapp.Discord", "Discord"],
  ],
  work: [
    ["com.tinyspeck.slackmacgap", "Slack"],
    ["com.slack.Slack", "Slack"],
    ["com.microsoft.teams", "Microsoft Teams"],
    ["com.microsoft.teams2", "Microsoft Teams"],
    ["us.zoom.xos", "Zoom"],
  ],
  email: [
    ["com.apple.mail", "Mail"],
    ["com.microsoft.Outlook", "Outlook"],
    ["com.google.Gmail", "Gmail"],
    ["com.superhuman.electron", "Superhuman"],
    ["com.mimestream.Mimestream", "Mimestream"],
    ["org.mozilla.thunderbird", "Thunderbird"],
    ["it.bloop.airmail2", "Airmail"],
    ["com.readdle.SparkDesktop", "Spark"],
    ["com.readdle.smartemail-Mac", "Spark"],
    ["com.mailspring.mailspring", "Mailspring"],
    ["com.edisonmail.edisonmail", "Edison Mail"],
    ["com.frontapp.Front", "Front"],
    ["com.hey.app.desktop", "HEY"],
    ["io.canarymail.mac", "Canary Mail"],
    ["com.missiveapp.osx", "Missive"],
    ["com.emclient.mail.client", "eM Client"],
    ["com.postbox-inc.postbox", "Postbox"],
  ],
  other: [],
};

const SITES: Rows = {
  personal: [
    ["web.whatsapp.com", "WhatsApp"],
    ["messages.google.com", "Google Messages"],
    ["messenger.com", "Messenger"],
    ["web.telegram.org", "Telegram"],
    ["discord.com", "Discord"],
    ["instagram.com", "Instagram"],
    ["x.com", "X"],
    ["facebook.com", "Facebook"],
    ["reddit.com", "Reddit"],
    ["voice.google.com", "Google Voice"],
    ["chat.beeper.com", "Beeper"],
  ],
  work: [
    ["slack.com", "Slack"],
    ["teams.microsoft.com", "Microsoft Teams"],
    ["teams.cloud.microsoft", "Microsoft Teams"],
    ["linkedin.com", "LinkedIn"],
    ["chat.google.com", "Google Chat"],
    ["meet.google.com", "Google Meet"],
    ["zoom.us", "Zoom"],
    ["fb.workplace.com", "Workplace"],
  ],
  email: [
    ["mail.google.com", "Gmail"],
    ["mail.superhuman.com", "Superhuman"],
    ["outlook.live.com", "Outlook"],
    ["outlook.office.com", "Outlook"],
    ["outlook.office365.com", "Outlook"],
    ["mail.yahoo.com", "Yahoo Mail"],
    ["mail.proton.me", "Proton Mail"],
    ["mail.zoho.com", "Zoho Mail"],
    ["mail.zoho.eu", "Zoho Mail"],
    ["app.hey.com", "HEY"],
    ["app.fastmail.com", "Fastmail"],
    ["app.tuta.com", "Tuta"],
    ["mail.aol.com", "AOL Mail"],
    ["app.frontapp.com", "Front"],
    ["app.shortwave.com", "Shortwave"],
  ],
  other: [],
};

function parsed<K>(parse: (key: string) => K | null, key: string): K {
  const value = parse(key);
  if (value === null) throw new Error(`Invalid built-in app category key: ${key}`);
  return value;
}

export const BUILT_IN_APPS: readonly { bundleId: BundleId; name: string; category: Category }[] =
  CATEGORIES.flatMap((category) =>
    APPS[category].map(([key, name]) => ({ bundleId: parsed(parseBundleId, key), name, category })),
  );
export const BUILT_IN_SITES: readonly { host: Host; name: string; category: Category }[] =
  CATEGORIES.flatMap((category) =>
    SITES[category].map(([key, name]) => ({ host: parsed(parseHost, key), name, category })),
  );

export const APP_CATEGORIES: ReadonlyMap<BundleId, Category> = new Map(
  BUILT_IN_APPS.map(({ bundleId, category }) => [bundleId, category]),
);
export const SITE_CATEGORIES: ReadonlyMap<Host, Category> = new Map(
  BUILT_IN_SITES.map(({ host, category }) => [host, category]),
);
