#!/usr/bin/env node
// Serves the fixture plus the built package, so the demo imports it exactly as
// a real site would. localhost is a secure context, which is what WebMCP needs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8788);
const TYPES = { ".html": "text/html", ".js": "text/javascript" };

createServer(async (req, res) => {
  const path = normalize(new URL(req.url ?? "/", "http://localhost").pathname);
  const file = path === "/" ? join(here, "fixture.html") : join(here, path.replace(/^\//, ""));
  if (!file.startsWith(here)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] ?? "text/plain" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`fixture on http://localhost:${port}`));
