// Plays the system browser's part of a sign-in: init-oauth-proxy, the faked Google callback,
// then, as the landing page's script does, the page itself, the browser's sign-out and a
// get-session that must come back null. The workerd tests pass the Worker, the script passes fetch.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Jar = Map<string, string>;

export function storeCookies(response: Response, jar: Jar = new Map()): Jar {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    const value = pair.slice(at + 1);
    if (value) jar.set(pair.slice(0, at), value);
    else jar.delete(pair.slice(0, at));
  }
  return jar;
}

export const cookieHeader = (jar: Jar) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

export async function playBrowser(
  fetch: FetchLike,
  {
    base,
    initUrl,
    googleCode,
    signOut,
  }: {
    base: string;
    initUrl: string;
    googleCode: string;
    /** Also load the landing page and end the browser's own auth session, as the page does. */
    signOut: boolean;
  },
) {
  const jar: Jar = new Map();
  const browse = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...init.headers, ...(jar.size > 0 && { cookie: cookieHeader(jar) }) },
    });
    storeCookies(response, jar);
    return response;
  };

  const init = await browse(initUrl);
  const google = new URL(init.headers.get("location") ?? "about:blank");
  const callback = await browse(
    `${base}/api/auth/callback/google?code=${encodeURIComponent(googleCode)}&state=${google.searchParams.get("state")}`,
  );
  const electronCookie = jar.get("better-auth.electron") ?? null;
  if (!signOut) return { jar, init, google, callback, electronCookie };

  const landing = await browse(`${base}/`);
  const signedOut = await browse(`${base}/api/auth/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: "{}",
  });
  const session = await browse(`${base}/api/auth/get-session`);
  return {
    jar,
    init,
    google,
    callback,
    electronCookie,
    landing,
    signOut: signedOut,
    browserSessionAfterSignOut: (await session.json()) as unknown,
  };
}
