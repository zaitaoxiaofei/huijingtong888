import { performance } from "node:perf_hooks";

import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import {
  fetchOzonCategoryAttributeValues,
  searchOzonCategoryAttributeValues
} from "../src/ozonClient.js";

const DEFAULT_LIMIT = 12;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_VALUE_LIMIT = 120;

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    live: false,
    mode: "search",
    limit: DEFAULT_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    valueLimit: DEFAULT_VALUE_LIMIT,
    shopId: 0,
    descriptionCategoryId: 0,
    typeId: 0,
    attributeIds: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--live") options.live = true;
    else if (arg === "--mode") options.mode = String(next() || options.mode).trim();
    else if (arg === "--limit") options.limit = numberArg(next(), options.limit);
    else if (arg === "--concurrency") options.concurrency = numberArg(next(), options.concurrency);
    else if (arg === "--value-limit") options.valueLimit = numberArg(next(), options.valueLimit);
    else if (arg === "--shop-id") options.shopId = numberArg(next(), options.shopId);
    else if (arg === "--description-category-id") options.descriptionCategoryId = numberArg(next(), options.descriptionCategoryId);
    else if (arg === "--type-id") options.typeId = numberArg(next(), options.typeId);
    else if (arg === "--attribute-id") options.attributeIds.push(numberArg(next(), 0));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.mode = ["search", "full", "both"].includes(options.mode) ? options.mode : "search";
  options.limit = clampInteger(options.limit, 1, 100);
  options.concurrency = clampInteger(options.concurrency, 1, 12);
  options.valueLimit = clampInteger(options.valueLimit, 1, 5000);
  options.attributeIds = [...new Set(options.attributeIds.filter(Boolean))];
  return options;
}

function numberArg(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, min, max) {
  return Math.min(Math.max(Math.trunc(Number(value || min)), min), max);
}

function printHelp() {
  console.log(`
Usage:
  npm run benchmark:ozon-values
  npm run benchmark:ozon-values -- --live --mode search --concurrency 6
  npm run benchmark:ozon-values -- --live --mode full --description-category-id 17028922 --type-id 971082 --attribute-id 85

Options:
  --live                         Request Ozon Seller API. Without this flag only local MySQL cache is measured.
  --mode search|full|both         Live mode. search uses /values/search; full uses /values pagination.
  --limit N                      Number of dictionary attributes to sample. Default ${DEFAULT_LIMIT}.
  --concurrency N                Parallel Ozon attribute requests. Default ${DEFAULT_CONCURRENCY}, max 12.
  --value-limit N                Ozon value page size / local value limit. Default ${DEFAULT_VALUE_LIMIT}.
  --shop-id ID                   Use a specific shop credential.
  --description-category-id ID   Restrict sample to one Ozon description category.
  --type-id ID                   Restrict sample to one Ozon type.
  --attribute-id ID              Restrict sample to one attribute. Repeatable.
`);
}

async function timed(label, fn) {
  const startedAt = performance.now();
  try {
    const value = await fn();
    return { label, ok: true, elapsedMs: roundMs(performance.now() - startedAt), value };
  } catch (error) {
    return { label, ok: false, elapsedMs: roundMs(performance.now() - startedAt), error };
  }
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

async function querySampleAttributes(options) {
  const params = [];
  const where = ["a.status = 'active'", "a.dictionary_id > 0"];
  if (options.descriptionCategoryId) {
    where.push("a.description_category_id = ?");
    params.push(options.descriptionCategoryId);
  }
  if (options.typeId) {
    where.push("a.type_id = ?");
    params.push(options.typeId);
  }
  if (options.attributeIds.length) {
    where.push(`a.attribute_id IN (${options.attributeIds.map(() => "?").join(",")})`);
    params.push(...options.attributeIds);
  }
  params.push(options.limit);
  const rows = await mysqlQuery(`
    SELECT
      a.description_category_id,
      a.type_id,
      a.attribute_id,
      a.name,
      a.name_zh,
      a.dictionary_id,
      COALESCE(v.value_count, 0) AS cached_value_count,
      v.sample_value,
      v.sample_dictionary_value_id
    FROM ozon_category_attributes a
    LEFT JOIN (
      SELECT
        description_category_id,
        type_id,
        attribute_id,
        COUNT(*) AS value_count,
        MIN(value) AS sample_value,
        MIN(NULLIF(dictionary_value_id, 0)) AS sample_dictionary_value_id
      FROM ozon_attribute_values
      WHERE status = 'active'
      GROUP BY description_category_id, type_id, attribute_id
    ) v ON v.description_category_id = a.description_category_id
      AND v.type_id = a.type_id
      AND v.attribute_id = a.attribute_id
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(v.value_count, 0) DESC, a.is_required DESC, a.updated_at DESC, a.attribute_id ASC
    LIMIT ?
  `, params);
  return rows.map((row) => ({
    descriptionCategoryId: Number(row.description_category_id || 0),
    typeId: Number(row.type_id || 0),
    attributeId: Number(row.attribute_id || 0),
    name: row.name_zh || row.name || "",
    dictionaryId: Number(row.dictionary_id || 0),
    cachedValueCount: Number(row.cached_value_count || 0),
    sampleValue: row.sample_value || "",
    sampleDictionaryValueId: Number(row.sample_dictionary_value_id || 0)
  }));
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
    SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint
    FROM shops
    WHERE ${where.join(" AND ")}
    ORDER BY id DESC
    LIMIT 1
  `, params);
  if (!rows[0]) throw new Error("No shop with real Ozon Seller API credentials was found.");
  return rows[0];
}

async function measureLocalCache(attributes, options) {
  return runConcurrent(attributes, options.concurrency, async (attribute) => {
    const result = await timed("local", () => mysqlQuery(`
      SELECT dictionary_value_id, value, display_value_zh
      FROM ozon_attribute_values
      WHERE description_category_id = ?
        AND type_id = ?
        AND attribute_id = ?
        AND status = 'active'
      ORDER BY value ASC, dictionary_value_id ASC
      LIMIT ?
    `, [
      attribute.descriptionCategoryId,
      attribute.typeId,
      attribute.attributeId,
      options.valueLimit
    ]));
    return {
      ...attribute,
      source: "local_cache",
      ok: result.ok,
      elapsedMs: result.elapsedMs,
      values: result.value?.length || 0,
      error: result.error?.message || ""
    };
  });
}

async function measureLiveSearch(attributes, shop, options) {
  const searchable = attributes.filter((item) => item.sampleValue);
  return runConcurrent(searchable, options.concurrency, async (attribute) => {
    const result = await timed("ozon_search", () => searchOzonCategoryAttributeValues(shop, {
      descriptionCategoryId: attribute.descriptionCategoryId,
      typeId: attribute.typeId,
      attributeId: attribute.attributeId,
      value: attribute.sampleValue,
      limit: Math.min(options.valueLimit, 1000),
      language: "ZH_HANS"
    }));
    return {
      ...attribute,
      source: "ozon_search",
      ok: result.ok,
      elapsedMs: result.elapsedMs,
      values: result.value?.length || 0,
      query: attribute.sampleValue,
      error: result.error?.message || ""
    };
  });
}

async function measureLiveFull(attributes, shop, options) {
  return runConcurrent(attributes, options.concurrency, async (attribute) => {
    const result = await timed("ozon_full", () => fetchOzonCategoryAttributeValues(shop, {
      descriptionCategoryId: attribute.descriptionCategoryId,
      typeId: attribute.typeId,
      attributeId: attribute.attributeId,
      limit: options.valueLimit,
      language: "ZH_HANS"
    }));
    return {
      ...attribute,
      source: "ozon_full",
      ok: result.ok,
      elapsedMs: result.elapsedMs,
      values: result.value?.length || 0,
      error: result.error?.message || ""
    };
  });
}

async function runConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results.filter(Boolean);
}

function summarize(group = {}) {
  const { label = "", rows = [], batchMs = 0 } = group;
  const elapsed = rows.map((item) => Number(item.elapsedMs || 0)).sort((a, b) => a - b);
  const okRows = rows.filter((item) => item.ok);
  const failedRows = rows.filter((item) => !item.ok);
  const values = okRows.map((item) => Number(item.values || 0));
  return {
    label,
    requests: rows.length,
    ok: okRows.length,
    failed: failedRows.length,
    batchMs: roundMs(batchMs),
    totalMs: roundMs(elapsed.reduce((sum, value) => sum + value, 0)),
    avgMs: roundMs(avg(elapsed)),
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    maxMs: roundMs(elapsed.at(-1) || 0),
    totalValues: values.reduce((sum, value) => sum + value, 0),
    avgValues: roundMs(avg(values))
  };
}

async function measureGroup(label, fn) {
  const startedAt = performance.now();
  const rows = await fn();
  return { label, rows, batchMs: performance.now() - startedAt };
}

function avg(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values = [], ratio = 0.5) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return roundMs(values[index]);
}

function printDetails(rows = []) {
  console.table(rows.map((item) => ({
    source: item.source,
    category: `${item.descriptionCategoryId}:${item.typeId}`,
    attribute: item.attributeId,
    name: String(item.name || "").slice(0, 32),
    cached: item.cachedValueCount,
    values: item.values,
    elapsedMs: item.elapsedMs,
    ok: item.ok,
    error: item.error ? String(item.error).slice(0, 90) : ""
  })));
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const attributes = await querySampleAttributes(options);
  if (!attributes.length) {
    console.log("No cached dictionary attributes matched the benchmark filters.");
    return;
  }

  console.log("Ozon attribute value benchmark");
  console.log("------------------------------");
  console.log(JSON.stringify({
    live: options.live,
    mode: options.mode,
    sample: attributes.length,
    concurrency: options.concurrency,
    valueLimit: options.valueLimit
  }, null, 2));

  const resultGroups = [
    await measureGroup("local_cache", () => measureLocalCache(attributes, options))
  ];

  if (options.live) {
    const shop = await resolveShop(options);
    console.log(`Live Ozon shop: ${shop.name || shop.id} (#${shop.id})`);
    if (options.mode === "search" || options.mode === "both") {
      resultGroups.push(await measureGroup("ozon_search", () => measureLiveSearch(attributes, shop, options)));
    }
    if (options.mode === "full" || options.mode === "both") {
      resultGroups.push(await measureGroup("ozon_full", () => measureLiveFull(attributes, shop, options)));
    }
  }

  console.log("\nSummary");
  console.table(resultGroups.map((group) => summarize(group)));
  console.log("\nDetails");
  for (const group of resultGroups) printDetails(group.rows);
}

try {
  await main();
} finally {
  await closeMysqlPool();
}
