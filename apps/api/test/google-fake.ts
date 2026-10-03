import { http, HttpResponse } from "msw";

const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export const fakeIdToken = (claims: Record<string, unknown>) =>
  `${b64url({ alg: "RS256", kid: "fake" })}.${b64url({
    iss: "https://accounts.google.com",
    aud: "test-client.apps.googleusercontent.com",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    email_verified: true,
    ...claims,
  })}.sig`;

export const tokenRequests: URLSearchParams[] = [];

export const googleTokenHandler = (claims: Record<string, unknown>) =>
  http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
    tokenRequests.push(new URLSearchParams(await request.text()));
    return HttpResponse.json({
      access_token: "fake-access",
      expires_in: 3599,
      scope: "openid email profile",
      token_type: "Bearer",
      id_token: fakeIdToken(claims),
    });
  });
