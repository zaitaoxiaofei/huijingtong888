function defaultHeaders(extra = {}) {
  return {
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...extra
  };
}

function serverTimingHeader(res) {
  const startedAt = Number(res?._serverTimingStartedAt || 0);
  if (!startedAt) return "";
  const now = performance.now();
  const marks = Array.isArray(res._serverTimingMarks) ? res._serverTimingMarks : [];
  const segments = [`total;dur=${Math.max(0, now - startedAt).toFixed(1)}`];
  let previousAt = startedAt;
  for (const mark of marks) {
    const label = String(mark?.label || "step").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "step";
    const at = Number(mark?.at || previousAt);
    if (!Number.isFinite(at)) continue;
    segments.push(`${label};dur=${Math.max(0, at - previousAt).toFixed(1)}`);
    previousAt = at;
  }
  if (previousAt < now) segments.push(`finish;dur=${Math.max(0, now - previousAt).toFixed(1)}`);
  return segments.join(", ");
}

export function appendSetCookie(res, cookieValue) {
  if (!res._setCookies) res._setCookies = [];
  res._setCookies.push(cookieValue);
}

export function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.secure) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

export function clearCookie(res, name, options = {}) {
  setCookie(res, name, "", { ...options, maxAge: 0 });
}

export function writeHead(res, status, headers = {}) {
  const finalHeaders = defaultHeaders(headers);
  if (!finalHeaders["Server-Timing"]) {
    const timing = serverTimingHeader(res);
    if (timing) finalHeaders["Server-Timing"] = timing;
  }
  if (res._setCookies?.length) {
    finalHeaders["Set-Cookie"] = res._setCookies;
    res._setCookies = [];
  }
  res.writeHead(status, finalHeaders);
}

export function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  writeHead(res, status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function html(res, markup, status = 200) {
  writeHead(res, status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(markup),
    "Cache-Control": "no-store"
  });
  res.end(markup);
}

export function text(res, content, status = 200, contentType = "text/plain; charset=utf-8") {
  writeHead(res, status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store"
  });
  res.end(content);
}

export function notFound(res) {
  json(res, { error: "Not found" }, 404);
}
