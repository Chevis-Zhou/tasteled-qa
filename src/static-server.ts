import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

/**
 * Serves a static build directory the way most static hosts do: `/` → `index.html`,
 * `/foo` → `foo.html` or `foo/index.html`, anything else → `404.html` with a 404 status.
 *
 * Covers Next.js `output: "export"` (where `next start` refuses to run), Astro, Eleventy,
 * Vite and hand-written HTML without adding a dependency.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function resolveFile(root: string, urlPath: string): string | null {
  const clean = urlPath.split("?")[0].split("#")[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\//, "");

  const candidates =
    rel === "" ? ["index.html"] : [rel, `${rel.replace(/\/$/, "")}.html`, path.join(rel, "index.html")];

  for (const candidate of candidates) {
    const full = path.resolve(root, candidate);
    if (full !== root && !full.startsWith(root + path.sep)) continue; // no path escape
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

export interface StaticServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function serveStatic(dir: string, port = 0): Promise<StaticServer> {
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, "index.html"))) {
    throw new Error(`No index.html in ${root}. Point tasteled-qa at your build output (e.g. out/, dist/).`);
  }

  const server = http.createServer((req, res) => {
    const file = resolveFile(root, req.url ?? "/");

    if (!file) {
      const notFound = path.join(root, "404.html");
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : "404 Not Found");
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    // The 127.0.0.1 literal, not "localhost": sandboxed Chromium's hostname resolution is
    // unreliable enough to surface as `Page.navigate` "Target closed" under Lighthouse.
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${boundPort}`,
        port: boundPort,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
