// Spike for #163. Runs the Better Auth Electron client in a bare Electron main process
// against local `wrangler dev` Workers, with a scratch userData folder.
import electron from "electron";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const { app, shell, safeStorage } = electron;
const scenario = process.env.SCENARIO;
const userData = process.env.SPIKE_USER_DATA;
if (!userData || !userData.startsWith("/tmp/"))
  throw new Error("SPIKE_USER_DATA must be a scratch folder under /tmp");
app.setName("VoiceSpike163");
app.setPath("userData", userData);

const log = (...args) => console.log(`[${scenario}]`, ...args);
const fingerprint = (value) =>
  value ? createHash("sha256").update(value).digest("hex").slice(0, 10) : "<none>";

let opened = [];
shell.openExternal = async (url) => {
  opened.push(url);
};

const encryption = process.env.SAFE_STORAGE ?? "fake";
if (encryption === "off") {
  safeStorage.isEncryptionAvailable = () => false;
} else if (encryption === "fake") {
  // Stand-in cipher so the spike never writes to the login Keychain.
  safeStorage.isEncryptionAvailable = () => true;
  safeStorage.encryptString = (s) => Buffer.from(`FAKEENC:${Buffer.from(s).toString("base64")}`);
  safeStorage.decryptString = (b) => Buffer.from(b.toString().slice(8), "base64").toString();
}

const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const cookie = request.headers.get("cookie") ?? "";
  const token = /better-auth\.session_token=([^;]+)/.exec(cookie)?.[1];
  outbound.push({
    url: request.url,
    sessionCookie: fingerprint(token && decodeURIComponent(token).split(".")[0]),
  });
  return realFetch(input, init);
};

const { createAuthClient } = await import("better-auth/client");
const { electronClient } = await import("@better-auth/electron/client");
const { storage } = await import("@better-auth/electron/storage");

const makeClient = (baseURL, storagePrefix) =>
  createAuthClient({
    baseURL,
    plugins: [
      electronClient({
        protocol: "com.codlume.voice",
        storagePrefix,
        storage: storage(),
        userImageProxy: { enabled: false },
      }),
    ],
  });

// Plays the system browser: init-oauth-proxy, Google (faked by the Worker), callback.
async function browser(url, googleCode) {
  const jar = new Map();
  const keep = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const header = () =>
    [...jar]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  const init = await realFetch(url, { redirect: "manual" });
  keep(init);
  const google = new URL(init.headers.get("location"));
  const api = new URL(url).origin;
  const callback = await realFetch(
    `${api}/api/auth/callback/google?code=${googleCode}&state=${google.searchParams.get("state")}`,
    { headers: { cookie: header() }, redirect: "manual" },
  );
  keep(callback);
  return {
    initStatus: init.status,
    googleHost: google.host,
    callbackStatus: callback.status,
    electronCookie: jar.get("better-auth.electron"),
  };
}

const verifierMap = () => globalThis[Symbol.for("better-auth:electron")];

function dumpUserData() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(userData);
  return files.map((p) => ({ file: p.slice(userData.length + 1), bytes: statSync(p).size }));
}

function grepUserData(needles) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const text = readFileSync(p, "latin1");
        for (const [label, needle] of Object.entries(needles))
          if (needle && text.includes(needle))
            hits.push(`${label} in ${p.slice(userData.length + 1)}`);
      }
    }
  };
  walk(userData);
  return hits;
}

async function signIn(client, code) {
  opened = [];
  await client.requestAuth({ provider: "google" });
  const flow = await browser(opened[0], code);
  const result = await client.authenticate({
    token: flow.electronCookie,
    fetchOptions: { throw: true },
  });
  return { flow, result };
}

const scenarios = {
  async q4() {
    const client = makeClient(process.env.NIGHTLY_URL, "voice.nightly");
    await client.requestAuth({ provider: "google" });
    log("requestAuth opened", new URL(opened[0]).pathname, "verifiers in map:", verifierMap().size);
    const flow = await browser(opened[0], "ada");
    log("browser", {
      init: flow.initStatus,
      google: flow.googleHost,
      callback: flow.callbackStatus,
      electronCookie: Boolean(flow.electronCookie),
    });

    const decoded = JSON.parse(
      Buffer.from(decodeURIComponent(flow.electronCookie), "base64url").toString(),
    );
    log(
      "cookie decodes to keys",
      Object.keys(decoded),
      "state matches map:",
      verifierMap().has(decoded.state),
    );
    try {
      await client.authenticate({ token: decoded.identifier, fetchOptions: { throw: true } });
      log("bare electron_authorization_code: UNEXPECTED success");
    } catch (error) {
      log("bare electron_authorization_code rejected:", JSON.stringify(error.message));
    }
    log("verifier still in map after bare attempt:", verifierMap().has(decoded.state));

    const result = await client.authenticate({
      token: flow.electronCookie,
      fetchOptions: { throw: true },
    });
    log(
      "authenticate(cookie value) user:",
      result.user?.email,
      "token returned:",
      Boolean(result.token),
    );
    log("verifier removed after use:", !verifierMap().has(decoded.state));
    const session = await client.getSession();
    log("getSession user:", session.data?.user?.email);
    const replay = await client
      .authenticate({ token: flow.electronCookie })
      .catch((e) => ({ error: e.message }));
    log("replaying the same cookie value:", JSON.stringify(replay.error ?? replay));
  },

  async q5() {
    const client = makeClient(process.env.NIGHTLY_URL, "voice.nightly");
    await client.requestAuth({ provider: "google" });
    const abandoned = opened[0];
    log(
      "user clicked Sign in, then cancelled in Voice. No plugin API removes the verifier. map size:",
      verifierMap().size,
    );
    const waitMs = Number(process.env.LATE_MS ?? 61000);
    await new Promise((r) => setTimeout(r, waitMs));
    log(`${waitMs / 1000}s later the user finishes in the browser`);
    const flow = await browser(abandoned, "late");
    const result = await client.authenticate({
      token: flow.electronCookie,
      fetchOptions: { throw: true },
    });
    log("late callback signed in as:", result.user?.email);
    log("getSession:", (await client.getSession()).data?.user?.email);
  },

  async q7() {
    const nightly = makeClient(process.env.NIGHTLY_URL, "voice.nightly");
    const stable = makeClient(process.env.STABLE_URL, "voice.stable");
    const n = await signIn(nightly, "nina");
    log("nightly signed in as", n.result.user.email);
    outbound.length = 0;
    const stableBefore = await stable.getSession();
    log(
      "stable getSession before its own sign-in:",
      stableBefore.data,
      "requests:",
      JSON.stringify(outbound),
    );
    const s = await signIn(stable, "sam");
    log("stable signed in as", s.result.user.email);
    outbound.length = 0;
    const ns = await nightly.getSession();
    const ss = await stable.getSession();
    log("nightly getSession:", ns.data?.user?.email, "| stable getSession:", ss.data?.user?.email);
    log("cookies sent:", JSON.stringify(outbound));
    log(
      "nightly auth session token fp",
      fingerprint(n.result.token),
      "stable auth session token fp",
      fingerprint(s.result.token),
    );
    log("files:", JSON.stringify(dumpUserData()));
    const conf = JSON.parse(readFileSync(join(userData, "config.json"), "utf8"));
    log(
      "config.json shape:",
      JSON.stringify(conf, (k, v) =>
        typeof v === "string" ? `<${v.slice(0, 8)}... ${v.length} chars>` : v,
      ),
    );
    log(
      "plaintext token on disk:",
      grepUserData({
        nightlyToken: n.result.token,
        stableToken: s.result.token,
        session_token: "session_token",
      }),
    );
  },

  async q8() {
    const client = makeClient(process.env.NIGHTLY_URL, "voice.nightly");
    log("isEncryptionAvailable:", safeStorage.isEncryptionAvailable());
    const { result } = await signIn(client, "mona");
    log("signed in as", result.user.email);
    log("getSession (memory):", (await client.getSession()).data?.user?.email);
    log("files:", JSON.stringify(dumpUserData()));
    log(
      "token or cookie on disk:",
      grepUserData({
        token: result.token,
        session_token: "session_token",
        email: "mona@example.com",
      }),
    );
  },

  async q8restart() {
    const client = makeClient(process.env.NIGHTLY_URL, "voice.nightly");
    log(
      "after restart, cookie:",
      JSON.stringify(client.getCookie()),
      "getSession:",
      (await client.getSession()).data,
    );
  },
};

app.whenReady().then(async () => {
  try {
    await scenarios[scenario]();
  } catch (error) {
    console.error(`[${scenario}] FAILED`, error);
    process.exitCode = 1;
  }
  app.quit();
});
