import { expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { startStream } from "./stream";
import type { ProviderEvent } from "@voice/contracts/session";
import { result } from "./fixture";
it("streams nonempty PCM through a local WebSocket and completes only after CloseStream and orderly close", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("missing address");
  const audio: Buffer[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (data, binary) => {
      if (binary) audio.push(Buffer.from(data.toString("hex"), "hex"));
      else if (JSON.parse(data.toString()).type === "CloseStream") {
        socket.send(JSON.stringify(result(0, 0.04, "Hello, Priya.")));
        socket.send(JSON.stringify({ type: "Metadata", duration: 0.04, channels: 1 }));
        socket.close(1000);
      }
    }),
  );
  const done = Promise.withResolvers<ProviderEvent>();
  const stream = startStream(
    { session: "one", attempt: "one", key: "synthetic" },
    (event) => {
      if (event.type !== "stable") done.resolve(event);
    },
    `ws://127.0.0.1:${address.port}`,
  );
  try {
    stream.audio(0, new Uint8Array(640).fill(1));
    stream.audio(1, new Uint8Array(640).fill(2));
    stream.stop(2, 640);
    expect(await done.promise).toMatchObject({
      type: "complete",
      text: "Hello, Priya.",
      samples: 640,
    });
    expect(Buffer.concat(audio)).toEqual(
      Buffer.concat([Buffer.alloc(640, 1), Buffer.alloc(640, 2)]),
    );
  } finally {
    stream.cancel();
    server.close();
  }
});
it.each(["missing-tail", "malformed", "early-close", "wrong-duration"])(
  "retains stable text but never completes on %s",
  async (fault) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("missing address");
    server.on("connection", (socket) =>
      socket.on("message", (_data, binary) => {
        if (!binary) return;
        socket.send(JSON.stringify(result(0, 0.02, "Keep this.")));
        if (fault === "malformed") socket.send("{bad");
        else if (fault === "missing-tail")
          socket.send(JSON.stringify({ type: "Metadata", duration: 1, channels: 1 }));
        else if (fault === "wrong-duration")
          socket.send(JSON.stringify({ type: "Metadata", duration: 4, channels: 1 }));
        socket.close(1000);
      }),
    );
    const events: ProviderEvent[] = [];
    const done = Promise.withResolvers<ProviderEvent>();
    const stream = startStream(
      { session: "fault", attempt: "fault", key: "synthetic" },
      (event) => {
        events.push(event);
        if (event.type !== "stable") done.resolve(event);
      },
      `ws://127.0.0.1:${address.port}`,
    );
    try {
      stream.audio(0, new Uint8Array(640).fill(1));
      expect(await done.promise).toMatchObject({ type: "failed" });
      expect(events).toContainEqual({
        type: "stable",
        session: "fault",
        attempt: "fault",
        text: "Keep this.",
      });
      expect(events.some((event) => event.type === "complete")).toBe(false);
    } finally {
      stream.cancel();
      server.close();
    }
  },
);
it.each([
  [401, "rejected"],
  [402, "quota"],
  [429, "rate-limit"],
] as const)(
  "classifies HTTP %s without exposing provider response bodies",
  async (status, reason) => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end("sensitive provider detail");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const done = Promise.withResolvers<ProviderEvent>();
    const stream = startStream(
      { session: "access", attempt: "one", key: "synthetic" },
      (event) => done.resolve(event),
      `ws://127.0.0.1:${address.port}`,
    );
    try {
      expect(await done.promise).toEqual({
        type: "failed",
        session: "access",
        attempt: "one",
        reason,
      });
    } finally {
      stream.cancel();
      server.close();
    }
  },
);
it("paces buffered audio at no more than 1.25x under a controlled clock", async () => {
  const { vi } = await import("vite-plus/test");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const connected = once(server, "connection");
  const stream = startStream(
    { session: "pace", attempt: "one", key: "synthetic" },
    () => {},
    `ws://127.0.0.1:${address.port}`,
  );
  try {
    stream.audio(0, new Uint8Array(640).fill(1));
    stream.audio(1, new Uint8Array(640).fill(2));
    const [socket] = await connected;
    const pong = once(socket, "pong");
    socket.ping();
    await pong;
    const frames: number[] = [];
    socket.on("message", () => frames.push(performance.now()));
    await vi.advanceTimersByTimeAsync(15);
    expect(frames).toEqual([]);
    const first = once(socket, "message");
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(frames).toEqual([16]);
    const second = once(socket, "message");
    await vi.advanceTimersByTimeAsync(16);
    await second;
    expect(frames).toEqual([16, 32]);
  } finally {
    stream.cancel();
    vi.useRealTimers();
    for (const client of server.clients) client.terminate();
    server.close();
  }
});
