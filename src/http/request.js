const DEFAULT_JSON_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const DEFAULT_FORM_BODY_LIMIT_BYTES = 1024 * 1024;

function readLimitEnv(key, fallback) {
  const value = Number(process.env[key] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createPayloadTooLargeError(limitBytes) {
  const error = new Error(`Request body is too large; limit is ${limitBytes} bytes`);
  error.status = 413;
  error.code = "REQUEST_BODY_TOO_LARGE";
  return error;
}

function assertContentLengthWithinLimit(req, limitBytes) {
  const raw = req?.headers?.["content-length"];
  if (!raw || !Number.isFinite(Number(raw))) return;
  if (Number(raw) > limitBytes) throw createPayloadTooLargeError(limitBytes);
}

export async function readText(req, options = {}) {
  const limitBytes = Math.max(1, Number(options.limitBytes || readLimitEnv("HTTP_JSON_BODY_LIMIT_BYTES", DEFAULT_JSON_BODY_LIMIT_BYTES)));
  assertContentLengthWithinLimit(req, limitBytes);

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) throw createPayloadTooLargeError(limitBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function readJson(req, options = {}) {
  const limitBytes = options.limitBytes || readLimitEnv("HTTP_JSON_BODY_LIMIT_BYTES", DEFAULT_JSON_BODY_LIMIT_BYTES);
  const body = await readText(req, { limitBytes });
  return body ? JSON.parse(body) : {};
}

export async function readForm(req) {
  const raw = await readText(req, { limitBytes: readLimitEnv("HTTP_FORM_BODY_LIMIT_BYTES", DEFAULT_FORM_BODY_LIMIT_BYTES) });
  return Object.fromEntries(new URLSearchParams(raw));
}

export function isRequestCancelledError(error) {
  const message = String(error?.message || "");
  return error?.name === "AbortError"
    || message.includes("client disconnected")
    || message.includes("request cancelled")
    || message.includes("client closed")
    || message.includes("客户端已取消")
    || message.includes("客户端连接已关闭");
}
