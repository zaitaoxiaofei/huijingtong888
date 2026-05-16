import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { notFound, writeHead } from "./response.js";

export function createStaticHandler(publicDir) {
  function preferredEncoding(req) {
    const acceptEncoding = String(req.headers["accept-encoding"] || "").toLowerCase();
    if (acceptEncoding.includes("br")) return "br";
    if (acceptEncoding.includes("gzip")) return "gzip";
    return "";
  }

  function sendFile(filePath, cleanPath, req, res) {
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    const headers = { "Content-Type": types[ext] || "application/octet-stream" };
    const isVersionedAsset = /\/vue-apps\/assets\/.+\.[a-z0-9_-]+\.(css|js)$/i.test(cleanPath)
      || /[?&]v=\d+/i.test(cleanPath);
    const isMutableEntryAsset = /\/vue-apps\/assets\/(admin-view|config-view|admin|config)\.(js|css)$/i.test(cleanPath);
    if (cleanPath === "/admin.html" || ext === ".html") {
      headers["Cache-Control"] = "no-store, must-revalidate";
    } else if (isMutableEntryAsset) {
      headers["Cache-Control"] = "no-store, must-revalidate";
    } else if (isVersionedAsset) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else if ([".css", ".js"].includes(ext)) {
      headers["Cache-Control"] = "public, max-age=600, must-revalidate";
    }
    const shouldCompress = [".html", ".css", ".js", ".json", ".svg", ".txt", ".md"].includes(ext);
    const encoding = shouldCompress ? preferredEncoding(req) : "";
    if (encoding) {
      headers["Content-Encoding"] = encoding;
      headers["Vary"] = "Accept-Encoding";
    }
    writeHead(res, 200, headers);
    const stream = fs.createReadStream(filePath);
    if (encoding === "br") return stream.pipe(zlib.createBrotliCompress()).pipe(res);
    if (encoding === "gzip") return stream.pipe(zlib.createGzip()).pipe(res);
    return stream.pipe(res);
  }

  return function serveStatic(pathname, req, res) {
    const cleanPath = pathname === "/" || pathname === "/index.html" ? "/admin.html" : pathname;
    const filePath = path.join(publicDir, cleanPath);
    const isFileRequest = path.posix.extname(cleanPath) !== "";

    if (!filePath.startsWith(publicDir)) {
      return notFound(res);
    }

    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      return sendFile(filePath, cleanPath, req, res);
    }

    if (!isFileRequest) {
      const adminPath = path.join(publicDir, "admin.html");
      if (adminPath.startsWith(publicDir) && fs.existsSync(adminPath) && !fs.statSync(adminPath).isDirectory()) {
        return sendFile(adminPath, "/admin.html", req, res);
      }
    }

    return notFound(res);
  };
}
