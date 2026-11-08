// Serves the built frontend (dist/) so one Node process hosts both the site and the API.
// Unknown paths without a file extension get index.html, so game links like /k7m2qx work.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wasm": "application/wasm",
};

async function fileAt(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

export function createStaticHandler(distDirectory) {
  const root = path.resolve(distDirectory);
  const indexFile = path.join(root, "index.html");

  return async function serveStatic(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      return response.end();
    }

    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      relative = "/";
    }
    let filePath = path.join(root, path.normalize(relative));
    // Never serve anything outside dist/ (e.g. "/../server/data/rooms.json").
    if (filePath !== root && !filePath.startsWith(root + path.sep)) filePath = indexFile;

    let info = await fileAt(filePath);
    if (!info) {
      if (path.extname(relative)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return response.end("Not found");
      }
      filePath = indexFile; // client-side route such as /<game_id>
      info = await fileAt(filePath);
      if (!info) {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        return response.end("The site hasn't been built yet. Run `npm run build`.");
      }
    }

    const hashedAsset = relative.startsWith("/assets/"); // Vite adds content hashes to these
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(filePath).pipe(response);
    return undefined;
  };
}
