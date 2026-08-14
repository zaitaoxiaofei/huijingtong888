import { performance } from "node:perf_hooks";

import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const OZON_API_BASE = "https://api-seller.ozon.ru";

const DEFAULT_ENDPOINTS = [
  "warehouse-v2",
  "product-prices-v5",
  "finance-cash-flow-list",
  "product-info-limit"
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    live: false,
    shopId: 0,
    endpoints: [],
    timeoutMs: 15000,
    from: dateKeyDaysAgo(7),
    to: todayDateKey()
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--live") options.live = true;
    else if (arg === "--shop-id") options.shopId = numberArg(next(), 0);
    else if (arg === "--endpoint") options.endpoints.push(String(next() || "").trim());
    else if (arg === "--timeout-ms") options.timeoutMs = numberArg(next(), options.timeoutMs);
    else if (arg === "--from") options.from = String(next() || options.from).slice(0, 10);
    else if (arg === "--to") options.to = String(next() || options.to).slice(0, 10);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.endpoints = options.endpoints.length ? options.endpoints : DEFAULT_ENDPOINTS;
  return options;
}

function printHelp() {
  console.log(`
Usage:
  npm run probe:ozon-api -- --live
  npm run probe:ozon-api -- --live --shop-id 1 --endpoint finance-cash-flow-list

Options:
  --live                 Request real Ozon Seller API. Without this flag the script only prints the probe plan.
  --shop-id ID           Use a specific active shop credential.
  --endpoint NAME        Probe one endpoint. Repeatable.
  --from YYYY-MM-DD      Start date for finance probes. Default: 7 days ago.
  --to YYYY-MM-DD        End date for finance probes. Default: today.
  --timeout-ms N         Per-request timeout. Default: 15000.
`);
}

function numberArg(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateKeyDaysAgo(days) {
  const date = new Date(Date.now() - Number(days || 0) * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function resolveShop(options) {
  const params = [];
  const where = [
    "status <> 'deleted'",
    "COALESCE(ozon_client_id, '') <> ''",
    "COALESCE(NULLIF(ozon_api_key, ''), NULLIF(api_key_hint, ''), '') <> ''",
    "COALESCE(NULLIF(ozon_api_key, ''), NULLIF(api_key_hint, ''), '') NOT LIKE 'demo%'"
  ];
  if (options.shopId) {
    where.push("id = ?");
    params.push(options.shopId);
  }
  const rows = await mysqlQuery(`
    SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key
    FROM shops
    WHERE ${where.join(" AND ")}
    ORDER BY id DESC
    LIMIT 1
  `, params);
  if (!rows[0]) throw new Error("No active shop with real Ozon Seller API credentials was found.");
  return rows[0];
}

function endpointDefinitions(options) {
  const fromIso = `${options.from}T00:00:00.000Z`;
  const toIso = `${options.to}T23:59:59.999Z`;
  return {
    "warehouse-v2": [
      { path: "/v2/warehouse/list", payload: {} }
    ],
    "product-prices-v5": [
      { path: "/v5/product/info/prices", payload: { cursor: "", filter: { visibility: "ALL" }, limit: 1 } },
      { path: "/v5/product/info/prices", payload: { cursor: "", filter: {}, limit: 1 } }
    ],
    "finance-cash-flow-list": [
      { path: "/v1/finance/cash-flow-statement/list", payload: { date: { from: fromIso, to: toIso }, page: 1, page_size: 1 } },
      { path: "/v1/finance/cash-flow-statement/list", payload: { filter: { date: { from: fromIso, to: toIso } }, page: 1, page_size: 1 } },
      { path: "/v1/finance/cash-flow-statement/list", payload: { date: { from: options.from, to: options.to }, page: 1, page_size: 1 } }
    ],
    "product-info-limit": [
      { path: "/v4/product/info/limit", payload: {} },
      { path: "/v3/product/info/limit", payload: {} }
    ]
  };
}

async function requestOzon(shop, candidate, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs || 15000)));
  const startedAt = performance.now();
  try {
    const response = await fetch(`${OZON_API_BASE}${candidate.path}`, {
      method: "POST",
      headers: {
        "Client-Id": String(shop.ozon_client_id),
        "Api-Key": String(shop.api_key),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(candidate.payload),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      path: candidate.path,
      payloadShape: summarizeShape(candidate.payload),
      responseShape: summarizeShape(data),
      itemCount: countLikelyItems(data),
      error: response.ok ? "" : String(data.message || data.error || text || `HTTP ${response.status}`).slice(0, 220)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      path: candidate.path,
      payloadShape: summarizeShape(candidate.payload),
      responseShape: "",
      itemCount: 0,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error).slice(0, 220)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeEndpoint(shop, name, candidates, options) {
  const attempts = [];
  for (const candidate of candidates) {
    const result = await requestOzon(shop, candidate, options);
    attempts.push(result);
    if (result.ok) break;
  }
  const best = attempts.find((item) => item.ok) || attempts[attempts.length - 1];
  return {
    name,
    ok: Boolean(best?.ok),
    status: best?.status || 0,
    elapsedMs: best?.elapsedMs || 0,
    path: best?.path || "",
    itemCount: best?.itemCount || 0,
    payloadShape: best?.payloadShape || "",
    responseShape: best?.responseShape || "",
    error: best?.error || "",
    attempts: attempts.length
  };
}

function summarizeShape(value) {
  if (!value || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `array(${value.length})`;
  const keys = Object.keys(value).slice(0, 10);
  return keys.map((key) => {
    const child = value[key];
    if (Array.isArray(child)) return `${key}:array`;
    if (child && typeof child === "object") return `${key}:{${Object.keys(child).slice(0, 5).join(",")}}`;
    return `${key}:${typeof child}`;
  }).join(", ");
}

function countLikelyItems(data) {
  const candidates = [
    data?.result?.items,
    data?.result?.operations,
    data?.result?.rows,
    data?.result?.warehouses,
    data?.items,
    data?.warehouses
  ];
  const found = candidates.find(Array.isArray);
  return found ? found.length : 0;
}

function printPlan(options) {
  console.log("Ozon Seller API probe plan");
  console.log(`live=${options.live ? "yes" : "no"} endpoints=${options.endpoints.join(", ")} from=${options.from} to=${options.to}`);
  if (!options.live) console.log("Add --live to request api-seller.ozon.ru with the first matching active shop credential.");
}

function printResults(shop, results) {
  console.log(`Shop: ${shop.id} ${shop.name || ""}`);
  for (const result of results) {
    const status = result.ok ? "OK" : "FAIL";
    console.log(`${status} ${result.name} ${result.path} status=${result.status} elapsed=${result.elapsedMs}ms items=${result.itemCount} attempts=${result.attempts}`);
    console.log(`  payload: ${result.payloadShape || "-"}`);
    console.log(`  response: ${result.responseShape || "-"}`);
    if (result.error) console.log(`  error: ${result.error}`);
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }
  printPlan(options);
  if (!options.live) return;
  const shop = await resolveShop(options);
  const definitions = endpointDefinitions(options);
  const results = [];
  for (const name of options.endpoints) {
    const candidates = definitions[name];
    if (!candidates) throw new Error(`Unknown endpoint probe: ${name}`);
    results.push(await probeEndpoint(shop, name, candidates, options));
  }
  printResults({ id: shop.id, name: shop.name }, results);
  if (results.some((item) => !item.ok)) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMysqlPool();
  });
