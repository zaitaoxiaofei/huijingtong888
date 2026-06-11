import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { notFound, writeHead } from "./response.js";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm"
};

function sendStaticNotFound(res, cleanPath) {
  const ext = path.extname(cleanPath);
  const contentType = CONTENT_TYPES[ext] || "text/plain; charset=utf-8";
  const body = ext === ".js"
    ? "throw new Error(\"Failed to fetch dynamically imported module: static asset not found. Refresh the ERP page to load the latest build.\");\n"
    : "Static asset not found. Refresh the ERP page to load the latest build.\n";
  writeHead(res, 404, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store, must-revalidate"
  });
  res.end(body);
}

export function createStaticHandler(publicDir, options = {}) {
  const extraRoots = Array.isArray(options.extraRoots) ? options.extraRoots.map((root) => path.resolve(root)) : [];
  const extraRouteRoots = Array.isArray(options.extraRouteRoots) ? options.extraRouteRoots : [];
  function preferredEncoding(req) {
    const acceptEncoding = String(req.headers["accept-encoding"] || "").toLowerCase();
    if (acceptEncoding.includes("br")) return "br";
    if (acceptEncoding.includes("gzip")) return "gzip";
    return "";
  }

  function sendFile(filePath, cleanPath, req, res) {
    const ext = path.extname(filePath);
    const headers = { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" };
    const isVueAppAsset = /\/vue-apps\/assets\/.+\.(css|js)$/i.test(cleanPath);
    const isVersionedAsset = /\/vue-apps\/assets\/.+-[a-z0-9_-]{6,}\.(css|js)$/i.test(cleanPath);
    const isMutableEntryAsset = /\/vue-apps\/assets\/(admin-view|config-view|admin|config)\.(js|css)$/i.test(cleanPath);
    if (cleanPath === "/admin.html" || cleanPath === "/release.json" || ext === ".html") {
      headers["Cache-Control"] = "no-store, must-revalidate";
    } else if (isMutableEntryAsset) {
      headers["Cache-Control"] = "no-store, must-revalidate";
    } else if (isVersionedAsset) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
      headers["CDN-Cache-Control"] = "public, max-age=31536000, immutable";
      headers["Cloudflare-CDN-Cache-Control"] = "public, max-age=31536000, immutable";
    } else if (isVueAppAsset) {
      headers["Cache-Control"] = "public, max-age=600, must-revalidate";
    } else if ([".css", ".js"].includes(ext)) {
      headers["Cache-Control"] = "public, max-age=600, must-revalidate";
    }
    const shouldCompress = [".html", ".css", ".js", ".json", ".svg", ".txt", ".md"].includes(ext);
    const encoding = shouldCompress ? preferredEncoding(req) : "";
    const stat = fs.statSync(filePath);
    const encodedPath = encoding ? `${filePath}.${encoding}` : "";
    const hasPrecompressedFile = Boolean(encodedPath && fs.existsSync(encodedPath));
    const responsePath = hasPrecompressedFile ? encodedPath : filePath;
    const responseStat = hasPrecompressedFile ? fs.statSync(encodedPath) : stat;
    const lastModified = stat.mtime.toUTCString();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    headers["ETag"] = etag;
    headers["Last-Modified"] = lastModified;
    const ifNoneMatch = String(req.headers["if-none-match"] || "");
    const ifModifiedSince = String(req.headers["if-modified-since"] || "");
    if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= Math.floor(stat.mtimeMs))) {
      writeHead(res, 304, headers);
      return res.end();
    }
    if (!encoding && String(req.headers.range || "").startsWith("bytes=")) {
      const match = String(req.headers.range).match(/bytes=(\d*)-(\d*)/);
      const start = Number(match?.[1] || 0);
      const end = match?.[2] ? Number(match[2]) : stat.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
        const safeEnd = Math.min(end, stat.size - 1);
        headers["Accept-Ranges"] = "bytes";
        headers["Content-Range"] = `bytes ${start}-${safeEnd}/${stat.size}`;
        headers["Content-Length"] = safeEnd - start + 1;
        writeHead(res, 206, headers);
        return fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
      }
    }
    if (!encoding) {
      headers["Accept-Ranges"] = "bytes";
      headers["Content-Length"] = stat.size;
    }
    if (encoding) {
      headers["Content-Encoding"] = encoding;
      headers["Vary"] = "Accept-Encoding";
      if (hasPrecompressedFile) headers["Content-Length"] = responseStat.size;
    }
    writeHead(res, 200, headers);
    const stream = fs.createReadStream(responsePath);
    if (hasPrecompressedFile) return stream.pipe(res);
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

    for (const routeRoot of extraRouteRoots) {
      const prefix = String(routeRoot.prefix || "");
      const roots = Array.isArray(routeRoot.roots) ? routeRoot.roots.map((root) => path.resolve(root)) : [];
      if (!prefix || !cleanPath.startsWith(prefix)) continue;
      const relativePath = cleanPath.slice(prefix.length).replace(/^\/+/, "");
      for (const root of roots) {
        const targetPath = path.resolve(root, relativePath);
        if (!targetPath.startsWith(root) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) continue;
        return sendFile(targetPath, cleanPath, req, res);
      }
    }

    for (const root of extraRoots) {
      const targetPath = path.join(root, cleanPath);
      if (!targetPath.startsWith(root) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) continue;
      return sendFile(targetPath, cleanPath, req, res);
    }

    if (!isFileRequest) {
      const adminPath = path.join(publicDir, "admin.html");
      if (adminPath.startsWith(publicDir) && fs.existsSync(adminPath) && !fs.statSync(adminPath).isDirectory()) {
        return sendFile(adminPath, "/admin.html", req, res);
      }
    }

    if (isFileRequest) return sendStaticNotFound(res, cleanPath);
    return notFound(res);
  };
}
