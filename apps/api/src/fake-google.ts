// Spike only: answers Google's token endpoint so `wrangler dev` can finish a sign-in without a Google account.
const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export function installFakeGoogle(clientId: string) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://oauth2.googleapis.com/token") return realFetch(input, init);
    const body = new URLSearchParams(await request.text());
    console.log(
      `[fake-google] token request code=${body.get("code")} has_verifier=${body.has("code_verifier")}`,
    );
    const now = Math.floor(Date.now() / 1000);
    const sub = body.get("code") ?? "default";
    const claims = {
      iss: "https://accounts.google.com",
      aud: clientId,
      iat: now,
      exp: now + 3600,
      sub: `google-${sub}`,
      email: `${sub}@example.com`,
      email_verified: true,
      name: `Test ${sub}`,
    };
    return Response.json({
      access_token: "fake-access",
      expires_in: 3599,
      scope: "openid email profile",
      token_type: "Bearer",
      id_token: `${b64url({ alg: "RS256", kid: "fake" })}.${b64url(claims)}.sig`,
    });
  };
}
