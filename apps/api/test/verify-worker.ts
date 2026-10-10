// The real Worker with Google's token endpoint faked, for wrangler.verify.jsonc only.
// It lives under test/ so no fake code reaches the deployed bundle.
import worker from "../src/index.ts";
import { fakeGoogleToken, googleTokenUrl } from "./google-fake.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== googleTokenUrl) return realFetch(request);
  return Response.json(fakeGoogleToken(new URLSearchParams(await request.text())));
};

export default worker;
