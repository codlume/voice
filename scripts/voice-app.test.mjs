import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { announcedPorts } from "./voice-app.mjs";

const child = () => ({ stderr: new PassThrough() });

test("reads the ports Chromium and Node announce, in either order", async () => {
  const electron = child();
  const ports = announcedPorts(electron, ["DevTools", "Debugger"]);
  electron.stderr.write("[1234:ERROR:gpu_init.cc] unrelated\n");
  electron.stderr.write("Debugger listening on ws://127.0.0.1:49209/ba26db94\n");
  electron.stderr.write("DevTools listening on ws://127.0.0.1:49210/devtools/browser/91fb\n");
  assert.deepEqual(await ports, { DevTools: 49210, Debugger: 49209 });
});

test("fails when the process ends before announcing every port", async () => {
  const electron = child();
  const ports = announcedPorts(electron, ["DevTools", "Debugger"]);
  electron.stderr.write("DevTools listening on ws://127.0.0.1:49210/devtools/browser/91fb\n");
  electron.stderr.end();
  await assert.rejects(ports, /exited before announcing its Debugger port/);
});

test("fails when no port is announced in time", async () => {
  const ports = announcedPorts(child(), ["DevTools"], { timeoutMs: 20 });
  await assert.rejects(ports, /no DevTools port announced after 20 ms/);
});
