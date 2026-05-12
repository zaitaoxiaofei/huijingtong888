import fs from "node:fs";
import path from "node:path";
import { notFound, writeHead } from "./response.js";

export function createStaticHandler(publicDir) {
  return function serveStatic(pathname, res) {
    const cleanPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.join(publicDir, cleanPath);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return notFound(res);
    }
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    const headers = { "Content-Type": types[ext] || "application/octet-stream" };
    if ([".html", ".css", ".js"].includes(ext)) headers["Cache-Control"] = "no-store";
    writeHead(res, 200, headers);
    fs.createReadStream(filePath).pipe(res);
  };
}
