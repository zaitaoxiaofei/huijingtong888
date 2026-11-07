const OZON_API_BASE = "https://api-seller.ozon.ru";

const MUTATION_PATHS = new Set([
  "/v1/carriage/create",
  "/v1/carriage/set-postings",
  "/v1/carriage/approve",
  "/v1/carriage/courier-contact/set",
  "/v1/carriage/cancel"
]);

export const OGL_CARRIAGE_ENDPOINTS = Object.freeze([
  ...MUTATION_PATHS,
  "/v2/carriage/delivery/list",
  "/v1/carriage/get",
  "/v2/posting/fbs/act/get-postings",
  "/v2/posting/fbs/act/check-status",
  "/v2/posting/fbs/act/get-container-labels",
  "/v2/posting/fbs/act/get-barcode"
]);
const ALLOWED_PATHS = new Set(OGL_CARRIAGE_ENDPOINTS);

function requestError(message, { code, statusCode = 502, unknown = false, remoteStatus } = {}) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    unknown,
    operationOutcome: unknown ? "unknown" : "failed",
    ...(remoteStatus ? { remoteStatus } : {})
  });
}

function credentials(shop) {
  const clientId = String(shop?.ozon_client_id || "").trim();
  const apiKey = String(shop?.ozon_api_key || shop?.api_key_hint || "").trim();
  if (!clientId || !apiKey || /^demo/i.test(apiKey) || /^demo/i.test(clientId)) {
    throw requestError("默认发运店铺缺少可用的 Ozon 授权（Client-Id / API Key），请在本企业店铺设置中补全真实授权后重试。", {
      code: "OGL_SHOP_CREDENTIALS_REQUIRED", statusCode: 400
    });
  }
  return { "Client-Id": clientId, "Api-Key": apiKey };
}

function parseJson(buffer, unknown) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw requestError("Ozon 发运接口返回了无法识别的响应，请先核对平台结果。", {
      code: "OGL_INVALID_RESPONSE", unknown
    });
  }
}

function binaryType(buffer) {
  if (buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "application/pdf";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  return null;
}

function decodeFileEnvelope(data) {
  const content = data?.file_content ?? data?.result?.file_content;
  if (typeof content !== "string" || !content.trim()) return null;
  // Official examples also return a binary string inside the JSON envelope.
  // Only Latin-1 code points have an unambiguous one-byte representation.
  if ([...content].every((char) => char.codePointAt(0) <= 255)) {
    const buffer = Buffer.from(content, "latin1");
    const contentType = binaryType(buffer);
    if (contentType) return { buffer, contentType };
  }
  const encoded = content.replace(/^data:(?:application\/pdf|image\/png);base64,/i, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null;
  const buffer = Buffer.from(encoded, "base64");
  const contentType = binaryType(buffer);
  return contentType ? { buffer, contentType } : null;
}

export function createOglCarriageClient({ fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");

  async function request(shop, path, body = {}, { binary = false, beforeRequest, afterRequest } = {}) {
    if (!ALLOWED_PATHS.has(path)) {
      throw requestError("不支持的 OGL 发运接口。", { code: "OGL_ENDPOINT_NOT_ALLOWED", statusCode: 400 });
    }
    if (beforeRequest) shop = await beforeRequest() || shop;
    const authorization = credentials(shop);
    const serializedBody = JSON.stringify(body);
    const mutation = MUTATION_PATHS.has(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let buffer;
    try {
      response = await fetchImpl(`${OZON_API_BASE}${path}`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Accept: binary ? "application/pdf, image/png, application/json" : "application/json" },
        body: serializedBody,
        redirect: "error",
        signal: controller.signal
      });
      buffer = Buffer.from(await response.arrayBuffer());
    } catch {
      // A failed connection/timeout cannot establish whether a mutation was applied.
      throw requestError(controller.signal.aborted
        ? "Ozon 发运请求超时，请先回读核对平台结果；不要直接重复创建或确认发运。"
        : "Ozon 发运请求连接失败，请先核对平台结果后再操作。", {
        code: controller.signal.aborted ? "OGL_REQUEST_TIMEOUT" : "OGL_REQUEST_CONNECTION_FAILED",
        statusCode: controller.signal.aborted ? 504 : 502,
        unknown: mutation
      });
    } finally {
      clearTimeout(timer);
    }
    if (afterRequest) await afterRequest();
    if (!response.ok) {
      // Never expose the raw response: it may echo credentials, phone numbers or postings.
      throw requestError(`Ozon 发运接口请求失败（HTTP ${response.status}），请检查店铺授权、接口权限与平台发运状态。`, {
        code: `OGL_API_HTTP_${response.status}`,
        remoteStatus: response.status,
        unknown: mutation && response.status >= 500
      });
    }
    // This method documents an HTTP 200 with no response body/schema.
    if (!binary && !buffer.length && path === "/v1/carriage/courier-contact/set") return {};
    if (!binary) return parseJson(buffer, mutation);

    const contentType = binaryType(buffer);
    if (contentType) return { buffer, contentType };
    const headerType = String(response.headers?.get("content-type") || "").toLowerCase();
    const looksLikeJson = /^[\s]*[\[{]/.test(buffer.subarray(0, 64).toString("ascii"));
    if (headerType.includes("json") || looksLikeJson) {
      const data = parseJson(buffer, false);
      const file = decodeFileEnvelope(data);
      if (file) return file;
      throw requestError("Ozon 货位标签或发运条码尚不可下载，请核对官方文档生成状态后重新下载。", {
        code: "OGL_FILE_NOT_READY"
      });
    }
    throw requestError("Ozon 返回的货位标签或发运条码格式无效，请稍后重新下载。", {
      code: "OGL_INVALID_FILE"
    });
  }

  async function deliveryMethods(shop, filter = {}, requestOptions = {}) {
    const methods = [];
    const seenCursors = new Set([""]);
    const requestFilter = {};
    for (const key of ["delivery_method_id", "departure_date"]) {
      if (filter[key] != null && filter[key] !== "") requestFilter[key] = filter[key];
    }
    let cursor = "";
    const maxPages=Math.min(100,Math.max(1,Math.floor(Number(requestOptions.maxPages)||100)));
    for (let page = 0; page < maxPages; page += 1) {
      const data = await request(shop, "/v2/carriage/delivery/list", { cursor, filter: requestFilter, limit: 1000 }, requestOptions);
      if (!Array.isArray(data?.methods) || typeof data.has_next !== "boolean") {
        throw requestError("Ozon 配送方式列表响应不完整，请稍后重新查询。", { code: "OGL_DELIVERY_INVALID_RESPONSE" });
      }
      methods.push(...data.methods);
      if (!data.has_next) return methods;
      if (typeof data.cursor !== "string" || !data.cursor || seenCursors.has(data.cursor)) {
        throw requestError("Ozon 配送方式分页未向前推进，请稍后重新查询。", { code: "OGL_DELIVERY_CURSOR_INVALID" });
      }
      cursor = data.cursor;
      seenCursors.add(cursor);
    }
    throw requestError("Ozon 配送方式分页超过查询上限，请缩小配送方式或发运日期范围。", { code: "OGL_DELIVERY_PAGE_LIMIT" });
  }

  return { request, deliveryMethods };
}

export const oglCarriageClient = createOglCarriageClient();
export default oglCarriageClient;
