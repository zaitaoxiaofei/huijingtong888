function defaultHeaders(extra = {}) {
  return {
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...extra
  };
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

export function notFound(res) {
  json(res, { error: "Not found" }, 404);
}
