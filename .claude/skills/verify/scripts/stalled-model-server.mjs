#!/usr/bin/env node
// A cleanup-model host whose weights download stalls: serves LICENSE and NOTICE, then answers the
// weights with the real content-length, sends about 8 MB, and holds the socket open for good.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9461);
const S1_MINI_BYTES = 484_219_808;

createServer((req, res) => {
  if (/\/(LICENSE|NOTICE)$/.test(req.url ?? "")) return res.end("synthetic legal text");
  res.writeHead(200, { "content-length": String(S1_MINI_BYTES) });
  res.write(Buffer.alloc(8 * 1024 * 1024));
}).listen(port, "127.0.0.1", () => console.log(`stalled model server on http://127.0.0.1:${port}`));
