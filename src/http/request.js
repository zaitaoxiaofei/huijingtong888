export async function readText(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

export async function readJson(req) {
  const body = await readText(req);
  return body ? JSON.parse(body) : {};
}

export async function readForm(req) {
  const raw = await readText(req);
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
