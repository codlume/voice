import WebSocket from "ws";
import { Transcript, deepgramUrl } from "./asr";
import type { Attempt, ProviderEvent, ProviderFailure } from "@voice/contracts/session";

export function startStream(
  input: Attempt & { key: string },
  emit: (event: ProviderEvent) => void,
  fixtureUrl?: string,
) {
  // Overrides are restricted to loopback, and composition enables them only in isolated tests.
  if (fixtureUrl && !/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(fixtureUrl))
    throw new Error("Invalid fixture URL");
  const identity = { session: input.session, attempt: input.attempt };
  const socket = new WebSocket(fixtureUrl ?? deepgramUrl, {
    headers: { Authorization: `Token ${input.key}` },
    followRedirects: false,
    handshakeTimeout: 10_000,
    maxPayload: 1_000_000,
    perMessageDeflate: false,
  });
  const transcript = new Transcript();
  const queue: Uint8Array[] = [];
  let receivedSamples = 0;
  let receivedFrames = 0;
  let sentSamples = 0;
  let opened = false;
  let stopped = false;
  let closeSent = false;
  let ended = false;
  let due = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    ended = true;
    clearTimeout(timer);
    queue.length = 0;
    socket.terminate();
  }
  function fail(reason: ProviderFailure) {
    if (ended) return;
    cancel();
    emit({ type: "failed", ...identity, reason });
  }
  function pump() {
    if (ended || !opened || timer) return;
    const frame = queue[0];
    if (!frame) {
      if (stopped && !closeSent) {
        closeSent = true;
        socket.send(JSON.stringify({ type: "CloseStream" }));
      }
      return;
    }
    // No accumulated token bucket: after a stall each frame must earn its own send interval.
    // Live frames arrive at 1x; a backlog drains at no more than 1.25x.
    due = Math.max(due, performance.now()) + frame.byteLength / 32 / 1.25;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (ended) return;
        if (socket.bufferedAmount > 64_000) {
          pump();
          return;
        }
        queue.shift();
        sentSamples += frame.byteLength / 2;
        socket.send(frame, (error) => {
          if (error) fail("connection");
        });
        pump();
      },
      Math.max(0, Math.ceil(due - performance.now())),
    );
  }
  socket.on("open", () => {
    opened = true;
    pump();
  });
  socket.on("unexpected-response", (_request, response) => {
    // An HTTP 429 is rate limiting, never evidence of exhausted account quota.
    response.resume();
    fail(
      response.statusCode === 401 || response.statusCode === 403
        ? "rejected"
        : response.statusCode === 402
          ? "quota"
          : response.statusCode === 429
            ? "rate-limit"
            : "connection",
    );
  });
  socket.on("error", () => fail("connection"));
  socket.on("message", (data, binary) => {
    if (ended) return;
    try {
      if (binary) throw new Error("binary-provider-event");
      const before = transcript.availableText();
      transcript.accept(JSON.parse(data.toString()));
      const text = transcript.availableText();
      if (text.length > 100_000) throw new Error("transcript-limit");
      if (before !== text)
        emit({ type: text === transcript.text() ? "stable" : "partial", ...identity, text });
    } catch {
      fail("protocol");
    }
  });
  socket.on("close", (code) => {
    if (ended) return;
    try {
      if (!closeSent || code !== 1000 || sentSamples !== receivedSamples)
        throw new Error("incomplete-stream");
      const text = transcript.finish(sentSamples / 16_000);
      ended = true;
      clearTimeout(timer);
      emit({ type: "complete", ...identity, text, samples: sentSamples });
    } catch {
      fail("incomplete");
    }
  });
  return {
    audio(sequence: number, pcm: Uint8Array) {
      if (ended) return;
      if (
        stopped ||
        sequence !== receivedFrames ||
        !pcm.byteLength ||
        pcm.byteLength % 2 ||
        pcm.byteLength > 4096 ||
        receivedSamples + pcm.byteLength / 2 > 4_800_000
      ) {
        fail("protocol");
        return;
      }
      receivedFrames++;
      receivedSamples += pcm.byteLength / 2;
      queue.push(pcm);
      pump();
    },
    stop(frames: number, samples: number) {
      if (ended || stopped) return;
      if (frames !== receivedFrames || samples !== receivedSamples) {
        fail("incomplete");
        return;
      }
      stopped = true;
      pump();
    },
    cancel,
  };
}
