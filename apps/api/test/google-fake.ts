// Google's token endpoint, faked at the outbound HTTP boundary. The authorization
// code picks the user, so `ada-lovelace` signs in Ada Lovelace, ada-lovelace@example.com.
export const googleTokenUrl = "https://oauth2.googleapis.com/token";

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export function fakeGoogleToken(body: URLSearchParams) {
  const code = body.get("code") ?? "";
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com",
    aud: body.get("client_id"),
    iat: now,
    exp: now + 3600,
    email_verified: true,
    sub: `google-${code}`,
    email: `${code}@example.com`,
    name: code
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
  };
  return {
    access_token: "fake-access",
    expires_in: 3599,
    scope: "openid email profile",
    token_type: "Bearer",
    id_token: `${base64Url({ alg: "RS256", kid: "fake" })}.${base64Url(claims)}.unsigned`,
  };
}
