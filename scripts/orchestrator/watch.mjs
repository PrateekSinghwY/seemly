// `run.mjs watch`: the live view. A small HTTP server that streams each discovery dir's
// events.jsonl to watch.html over server-sent events, from the first line and then every line
// appended while a walk or a build runs. It only reads files, so it can run beside any command.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Complete lines appended to `file` since byte `from`; returns the lines and the new offset. */
export function readNew(file, from) {
  if (!existsSync(file)) return { lines: [], offset: from };
  const size = statSync(file).size;
  if (size < from) from = 0; // rewritten (a fresh init): start over
  if (size === from) return { lines: [], offset: from };
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(size - from);
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  const text = buf.toString("utf8");
  const end = text.lastIndexOf("\n");
  if (end < 0) return { lines: [], offset: from };
  return { lines: text.slice(0, end).split("\n").filter(Boolean), offset: from + Buffer.byteLength(text.slice(0, end + 1)) };
}

export function serve({ dirs, port = 4777, say = console.log }) {
  // A seemly-video run lives at <video root>/frames_raw/_live: name it after the video root.
  const runs = dirs.map((d) => ({ dir: resolve(d), name: basename(resolve(d)) === "_live" ? `video: ${basename(dirname(dirname(resolve(d))))}` : basename(resolve(d)) }));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(join(here, "watch.html"), "utf8"));
    }
    if (url.pathname === "/runs") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(runs.map((r, i) => ({ id: i, name: r.name, dir: r.dir }))));
    }
    if (url.pathname === "/events") {
      const run = runs[+(url.searchParams.get("run") ?? 0)];
      if (!run) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const file = join(run.dir, "events.jsonl");
      let offset = 0;
      const pump = () => {
        const r = readNew(file, offset);
        offset = r.offset;
        // In slices, so a long log reaches the page as a stream it can draw while it loads.
        for (let i = 0; i < r.lines.length; i += 2000) res.write(`data: [${r.lines.slice(i, i + 2000).join(",")}]\n\n`);
      };
      pump();
      res.write("event: caught-up\ndata: {}\n\n");
      const tick = setInterval(pump, 400);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(tick);
        clearInterval(ping);
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((ok) =>
    server.listen(port, "127.0.0.1", () => {
      say(`watch: http://127.0.0.1:${port}/  (${runs.map((r) => r.name).join(", ")})`);
      ok(server);
    }),
  );
}
