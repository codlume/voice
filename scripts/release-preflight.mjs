import { appendFileSync } from "node:fs";
import { preflightRelease, r2Store } from "./release-publish.mjs";

const {
  RELEASE_CHANNEL: channel,
  RELEASE_VERSION: version,
  RELEASE_BASE_URL: baseUrl,
  R2_BUCKET: bucket,
  R2_ACCOUNT_ID: account,
} = process.env;
if (
  !["stable", "nightly"].includes(channel) ||
  !version ||
  !baseUrl ||
  !bucket ||
  !account ||
  !process.env.AWS_ACCESS_KEY_ID ||
  !process.env.AWS_SECRET_ACCESS_KEY
) {
  throw new Error("Release channel, version, and R2 credentials are required");
}
if (await preflightRelease({ store: r2Store(bucket), channel, version, baseUrl })) {
  appendFileSync(process.env.GITHUB_OUTPUT, "skip=true\n");
  console.log(`Skipping ${version}; a complete release is already published`);
}
