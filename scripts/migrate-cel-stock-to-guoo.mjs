#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { fetchOzonFbsStocksByWarehouse, fetchOzonProductRefs, fetchOzonProductsByIds, fetchOzonProductStocks, fetchOzonWarehouses, updateOzonProductStocks } from "../src/ozonClient.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = path.join(ROOT_DIR, ".deploy-artifacts", "ozon-stock-migration");
const UPDATE_CHUNK_SIZE = 100;

export const CONFIRMED_WAREHOUSE_MAPPINGS = [
  { shopId: 4, shopName: "RuVibe Mart", sourceId: "1020005000714808", targetId: "1020005028670620", rule: "陆运 1-500g → 合肥 GUOO 陆运超级轻小件" },
  { shopId: 4, shopName: "RuVibe Mart", sourceId: "1020005000714924", targetId: "1020005028674220", rule: "陆空 1-500g → 合肥 GUOO 陆空超级轻小件" },
  { shopId: 4, shopName: "RuVibe Mart", sourceId: "1020005000714986", targetId: "1020005028914450", rule: "陆运低客单 → 合肥 GUOO 陆运低客单轻小件" },
  { shopId: 4, shopName: "RuVibe Mart", sourceId: "1020005001848200", targetId: "1020005028914600", rule: "陆运 1-2000g 高客单 → 合肥 GUOO 陆运小件" },
  { shopId: 4, shopName: "RuVibe Mart", sourceId: "1020005018348580", targetId: "1020005028914600", rule: "陆空 1-2000g 高客单 → 合肥 GUOO 陆运小件" },
  { shopId: 4, shopName: "RuVibe Mart", sourceId: "1020005008712990", targetId: "1020005028915190", rule: "陆运 2-30kg 高客单 → 合肥 GUOO 陆运大件" },
  { shopId: 5, shopName: "RuVibe Mart S", sourceId: "1020005008696340", targetId: "1020005028674670", rule: "陆运 1-500g → 合肥 GUOO 陆运超级轻小件" },
  { shopId: 5, shopName: "RuVibe Mart S", sourceId: "1020005008695620", targetId: "1020005028674900", rule: "陆空 1-500g → 合肥 GUOO 陆空超级轻小件" },
  { shopId: 5, shopName: "RuVibe Mart S", sourceId: "1020005008699960", targetId: "1020005028918410", rule: "陆运低客单 → 合肥 GUOO 陆运低客单轻小件" },
  { shopId: 5, shopName: "RuVibe Mart S", sourceId: "1020005008696890", targetId: "1020005028918180", rule: "陆运 1-2000g 高客单 → 合肥 GUOO 陆运小件" },
  { shopId: 5, shopName: "RuVibe Mart S", sourceId: "1020005018381080", targetId: "1020005028918180", rule: "陆空 1-2000g 高客单 → 合肥 GUOO 陆运小件" },
  { shopId: 5, shopName: "RuVibe Mart S", sourceId: "1020005008712540", targetId: "1020005027185390", rule: "陆运 2-30kg 高客单 → 合肥 GUOO 陆运大件" },
  { shopId: 6, shopName: "RuVibe Mart X", sourceId: "1020005001922570", targetId: "1020005028673860", rule: "陆运 1-500g → 合肥 GUOO 陆运超级轻小件" },
  { shopId: 6, shopName: "RuVibe Mart X", sourceId: "1020005001922840", targetId: "1020005028674530", rule: "陆空 1-500g → 合肥 GUOO 陆空超级轻小件" },
  { shopId: 6, shopName: "RuVibe Mart X", sourceId: "1020005001923260", targetId: "1020005028915610", rule: "陆运低客单 → 合肥 GUOO 陆运低客单轻小件" },
  { shopId: 6, shopName: "RuVibe Mart X", sourceId: "1020005018381320", targetId: "1020005028915750", rule: "陆空 1-2000g 高客单 → 合肥 GUOO 陆运小件" },
  { shopId: 6, shopName: "RuVibe Mart X", sourceId: "1020005008712110", targetId: "1020005028916770", rule: "陆运 2-30kg 高客单 → 合肥 GUOO 陆运大件" },
  { shopId: 7, shopName: "RuVibe Mart Z", sourceId: "1020005021432970", targetId: "1020005028920480", rule: "陆运 1-500g → 合肥 GUOO 陆运超级轻小件" },
  { shopId: 7, shopName: "RuVibe Mart Z", sourceId: "1020005012407580", targetId: "1020005028920560", rule: "陆空 1-500g → 合肥 GUOO 陆空超级轻小件" },
  { shopId: 7, shopName: "RuVibe Mart Z", sourceId: "1020005018348500", targetId: "1020005028920770", rule: "陆空 1-2000g 高客单 → 合肥 GUOO 陆运小件" },
  { shopId: 7, shopName: "RuVibe Mart Z", sourceId: "1020005023265570", targetId: "1020005028921030", rule: "陆运 2-30kg 高客单 → 合肥 GUOO 陆运大件" }
];

function productKey(row = {}) {
  const offerId = String(row.offer_id || "").trim();
  const productId = String(row.ozon_product_id || row.product_id || "").trim();
  return offerId ? `offer:${offerId}` : productId ? `product:${productId}` : "";
}

function normalizedStock(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

export function buildCopyPlan(stockRows = [], mappings = CONFIRMED_WAREHOUSE_MAPPINGS) {
  const mappingByTarget = new Map();
  for (const mapping of mappings) {
    const targetKey = `${mapping.shopId}:${mapping.targetId}`;
    const group = mappingByTarget.get(targetKey) || { ...mapping, sourceIds: [] };
    group.sourceIds.push(String(mapping.sourceId));
    mappingByTarget.set(targetKey, group);
  }

  const rowsByShopProduct = new Map();
  for (const row of stockRows) {
    const key = productKey(row);
    if (!key || !row.shop_id) continue;
    const groupKey = `${row.shop_id}:${key}`;
    const group = rowsByShopProduct.get(groupKey) || [];
    group.push(row);
    rowsByShopProduct.set(groupKey, group);
  }

  const plan = [];
  for (const target of mappingByTarget.values()) {
    const relevantWarehouseIds = new Set([...target.sourceIds, String(target.targetId)]);
    for (const [groupKey, productRows] of rowsByShopProduct) {
      if (!groupKey.startsWith(`${target.shopId}:`)) continue;
      if (!productRows.some((row) => relevantWarehouseIds.has(String(row.warehouse_id)))) continue;
      const identity = productRows.find((row) => productKey(row)) || {};
      const sourceRows = productRows.filter((row) => target.sourceIds.includes(String(row.warehouse_id)));
      const currentTargetRows = productRows.filter((row) => String(row.warehouse_id) === String(target.targetId));
      plan.push({
        shop_id: Number(target.shopId),
        shop_name: target.shopName,
        product_key: productKey(identity),
        offer_id: String(identity.offer_id || ""),
        product_id: Number(identity.ozon_product_id || identity.product_id || 0),
        target_warehouse_id: String(target.targetId),
        source_warehouse_ids: [...target.sourceIds],
        source_present: sourceRows.reduce((sum, row) => sum + normalizedStock(row.present), 0),
        source_reserved: sourceRows.reduce((sum, row) => sum + normalizedStock(row.reserved), 0),
        source_available: sourceRows.reduce((sum, row) => sum + normalizedStock(row.available), 0),
        current_target_present: currentTargetRows.reduce((sum, row) => sum + normalizedStock(row.present), 0),
        current_target_available: currentTargetRows.reduce((sum, row) => sum + normalizedStock(row.available), 0)
      });
    }
  }
  return plan.sort((left, right) => left.shop_id - right.shop_id || left.target_warehouse_id.localeCompare(right.target_warehouse_id) || left.product_key.localeCompare(right.product_key));
}

export function buildCelClearPlan(stockRows = [], mappings = CONFIRMED_WAREHOUSE_MAPPINGS) {
  const sourceByShop = new Map();
  for (const mapping of mappings) {
    const ids = sourceByShop.get(Number(mapping.shopId)) || new Set();
    ids.add(String(mapping.sourceId));
    sourceByShop.set(Number(mapping.shopId), ids);
  }
  const unique = new Map();
  for (const row of stockRows) {
    const shopId = Number(row.shop_id || 0);
    const warehouseId = String(row.warehouse_id || "");
    const key = productKey(row);
    if (!key || !sourceByShop.get(shopId)?.has(warehouseId) || normalizedStock(row.available) <= 0) continue;
    unique.set(`${shopId}:${warehouseId}:${key}`, {
      shop_id: shopId,
      shop_name: String(row.shop_name || ""),
      product_key: key,
      offer_id: String(row.offer_id || ""),
      product_id: Number(row.ozon_product_id || row.product_id || 0),
      warehouse_id: warehouseId,
      available_before: normalizedStock(row.available),
      present_before: normalizedStock(row.present),
      reserved_before: normalizedStock(row.reserved),
      stock: 0
    });
  }
  return [...unique.values()].sort((left, right) => left.shop_id - right.shop_id || left.warehouse_id.localeCompare(right.warehouse_id) || left.product_key.localeCompare(right.product_key));
}

function beijingTimestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(new Date()).reduce((result, item) => ({ ...result, [item.type]: item.value }), {});
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

async function activeMigrationShops() {
  const shopIds = [...new Set(CONFIRMED_WAREHOUSE_MAPPINGS.map((item) => item.shopId))];
  const rows = await mysqlQuery(`SELECT * FROM shops WHERE id IN (${shopIds.map(() => "?").join(",")}) AND status <> 'deleted' ORDER BY id`, shopIds);
  return rows.map((shop) => ({ ...shop, ozon_api_key: shop.ozon_api_key || shop.api_key_hint }));
}

function assertWarehouseMappings(shop, warehouses) {
  const availableIds = new Set(warehouses.map((item) => String(item.warehouse_id)));
  const missing = CONFIRMED_WAREHOUSE_MAPPINGS
    .filter((item) => item.shopId === Number(shop.id))
    .flatMap((item) => [item.sourceId, item.targetId])
    .filter((id, index, all) => !availableIds.has(String(id)) && all.indexOf(id) === index);
  if (missing.length) throw new Error(`${shop.name} 缺少已确认仓库：${missing.join(", ")}`);
}

async function prepareBackup() {
  const shops = await activeMigrationShops();
  if (shops.length !== 4) throw new Error(`预期4个迁移店铺，实际读取到${shops.length}个`);
  const backupRows = [];
  const warehouseSnapshots = [];
  for (const shop of shops) {
    const warehouses = await fetchOzonWarehouses(shop);
    assertWarehouseMappings(shop, warehouses);
    warehouseSnapshots.push({ shop_id: Number(shop.id), shop_name: shop.name, warehouses });
    const aggregateRows = await fetchOzonProductStocks(shop, { limit: 1000 });
    const skus = aggregateRows.map((row) => row.ozon_sku).filter(Boolean);
    const rows = await fetchOzonFbsStocksByWarehouse(shop, { skus, limit: 1000 });
    backupRows.push(...rows.map((row) => ({ shop_id: Number(shop.id), shop_name: shop.name, ...row })));
  }
  const plan = buildCopyPlan(backupRows);
  const batchId = `cel-to-guoo-${beijingTimestamp()}`;
  const batchDir = path.join(OUTPUT_ROOT, batchId);
  await mkdir(batchDir, { recursive: true });
  const metadata = {
    batch_id: batchId,
    created_at: new Date().toISOString(),
    purpose: "CEL库存复制到GUOO，CEL暂不清零",
    shop_ids: shops.map((shop) => Number(shop.id)),
    mapping_count: CONFIRMED_WAREHOUSE_MAPPINGS.length,
    stock_row_count: backupRows.length,
    copy_target_count: plan.length,
    source_available_total: plan.reduce((sum, item) => sum + item.source_available, 0),
    source_reserved_total: plan.reduce((sum, item) => sum + item.source_reserved, 0),
    target_available_before_total: plan.reduce((sum, item) => sum + item.current_target_available, 0)
  };
  await Promise.all([
    writeFile(path.join(batchDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    writeFile(path.join(batchDir, "warehouse-mappings.json"), `${JSON.stringify(CONFIRMED_WAREHOUSE_MAPPINGS, null, 2)}\n`, "utf8"),
    writeFile(path.join(batchDir, "warehouses-before.json"), `${JSON.stringify(warehouseSnapshots, null, 2)}\n`, "utf8"),
    writeFile(path.join(batchDir, "stocks-before.json"), `${JSON.stringify(backupRows, null, 2)}\n`, "utf8"),
    writeFile(path.join(batchDir, "copy-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8")
  ]);
  return { batchDir, metadata, plan };
}

async function fetchActiveAndArchivedWarehouseStocks(shop) {
  const aggregateRows = await fetchOzonProductStocks(shop, { limit: 1000 });
  const activeSkus = aggregateRows.map((row) => row.ozon_sku).filter(Boolean);
  const activeRows = activeSkus.length ? await fetchOzonFbsStocksByWarehouse(shop, { skus: activeSkus, limit: 1000 }) : [];
  const archivedRefs = await fetchOzonProductRefs(shop, { visibilityFilters: ["ARCHIVED"], visibilityConcurrency: 1 });
  const archivedProducts = await fetchOzonProductsByIds(shop, archivedRefs.map((item) => item.id), {
    visibilityById: new Map(archivedRefs.map((item) => [String(item.id), "ARCHIVED"]))
  });
  const archivedSkus = archivedProducts.map((row) => row.ozon_sku).filter((value) => /^\d+$/.test(String(value || "")));
  const archivedRows = archivedSkus.length ? await fetchOzonFbsStocksByWarehouse(shop, { skus: archivedSkus, limit: 1000 }) : [];
  return { activeRows, archivedRows, archivedProductCount: archivedProducts.length };
}

async function prepareCelClearBackup() {
  const shops = await activeMigrationShops();
  const stockRows = [];
  const shopSummary = [];
  for (const shop of shops) {
    const warehouses = await fetchOzonWarehouses(shop);
    assertWarehouseMappings(shop, warehouses);
    const result = await fetchActiveAndArchivedWarehouseStocks(shop);
    stockRows.push(...result.activeRows.map((row) => ({ shop_id: Number(shop.id), shop_name: shop.name, product_state: "active", ...row })));
    stockRows.push(...result.archivedRows.map((row) => ({ shop_id: Number(shop.id), shop_name: shop.name, product_state: "archived", ...row })));
    shopSummary.push({ shop_id: Number(shop.id), shop_name: shop.name, active_stock_rows: result.activeRows.length, archived_stock_rows: result.archivedRows.length, archived_product_count: result.archivedProductCount });
  }
  const plan = buildCelClearPlan(stockRows);
  const batchId = `cel-clear-${beijingTimestamp()}`;
  const batchDir = path.join(OUTPUT_ROOT, batchId);
  await mkdir(batchDir, { recursive: true });
  const metadata = {
    batch_id: batchId,
    created_at: new Date().toISOString(),
    purpose: "将已确认映射范围内的CEL源仓库存清零，GUOO保持不变",
    shop_ids: shops.map((shop) => Number(shop.id)),
    clear_target_count: plan.length,
    available_before_total: plan.reduce((sum, item) => sum + item.available_before, 0),
    shop_summary: shopSummary
  };
  await Promise.all([
    writeFile(path.join(batchDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    writeFile(path.join(batchDir, "warehouse-mappings.json"), `${JSON.stringify(CONFIRMED_WAREHOUSE_MAPPINGS, null, 2)}\n`, "utf8"),
    writeFile(path.join(batchDir, "stocks-before-clear.json"), `${JSON.stringify(stockRows, null, 2)}\n`, "utf8"),
    writeFile(path.join(batchDir, "clear-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8")
  ]);
  return { batchDir, metadata };
}

async function applyCopy(batchDir, confirmation) {
  const absoluteBatchDir = path.resolve(batchDir);
  const [metadata, plan] = await Promise.all([
    readFile(path.join(absoluteBatchDir, "metadata.json"), "utf8").then(JSON.parse),
    readFile(path.join(absoluteBatchDir, "copy-plan.json"), "utf8").then(JSON.parse)
  ]);
  if (confirmation !== metadata.batch_id) throw new Error(`写入确认不匹配。必须使用 --confirm=${metadata.batch_id}`);
  const shops = await activeMigrationShops();
  const shopById = new Map(shops.map((shop) => [Number(shop.id), shop]));
  const results = [];
  for (const shopId of metadata.shop_ids) {
    const shop = shopById.get(Number(shopId));
    if (!shop) throw new Error(`找不到迁移店铺 ${shopId}`);
    const targets = plan.filter((item) => Number(item.shop_id) === Number(shopId)).map((item) => ({
      offer_id: item.offer_id,
      product_id: item.product_id,
      warehouse_id: item.target_warehouse_id,
      stock: item.source_available
    }));
    for (let index = 0; index < targets.length; index += UPDATE_CHUNK_SIZE) {
      const chunk = targets.slice(index, index + UPDATE_CHUNK_SIZE);
      const response = await updateOzonProductStocks(shop, chunk);
      results.push({ shop_id: Number(shopId), offset: index, count: chunk.length, response });
    }
  }
  await writeFile(path.join(absoluteBatchDir, "copy-api-results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  return { metadata, updated_count: plan.length, result_file: path.join(absoluteBatchDir, "copy-api-results.json") };
}

async function applyCelClear(batchDir, confirmation) {
  const absoluteBatchDir = path.resolve(batchDir);
  const [metadata, plan] = await Promise.all([
    readFile(path.join(absoluteBatchDir, "metadata.json"), "utf8").then(JSON.parse),
    readFile(path.join(absoluteBatchDir, "clear-plan.json"), "utf8").then(JSON.parse)
  ]);
  if (confirmation !== metadata.batch_id) throw new Error(`清零确认不匹配。必须使用 --confirm=${metadata.batch_id}`);
  const shops = await activeMigrationShops();
  const shopById = new Map(shops.map((shop) => [Number(shop.id), shop]));
  const results = [];
  for (const shopId of metadata.shop_ids) {
    const shop = shopById.get(Number(shopId));
    if (!shop) throw new Error(`找不到迁移店铺 ${shopId}`);
    const targets = plan.filter((item) => Number(item.shop_id) === Number(shopId)).map((item) => ({
      offer_id: item.offer_id,
      product_id: item.product_id,
      warehouse_id: item.warehouse_id,
      stock: 0
    }));
    for (let index = 0; index < targets.length; index += UPDATE_CHUNK_SIZE) {
      const chunk = targets.slice(index, index + UPDATE_CHUNK_SIZE);
      const response = await updateOzonProductStocks(shop, chunk);
      results.push({ shop_id: Number(shopId), offset: index, count: chunk.length, response });
    }
  }
  const resultFile = path.join(absoluteBatchDir, "clear-api-results.json");
  await writeFile(resultFile, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  return { metadata, requested_count: plan.length, result_file: resultFile };
}

function argValue(name, fallback = "") {
  const direct = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

async function main() {
  if (process.argv.includes("--prepare-clear")) {
    const result = await prepareCelClearBackup();
    console.log(JSON.stringify({ batch_dir: result.batchDir, ...result.metadata }, null, 2));
    return;
  }
  if (process.argv.includes("--clear-cel")) {
    const batchDir = argValue("batch-dir");
    if (!batchDir) throw new Error("清零模式必须提供 --batch-dir");
    const result = await applyCelClear(batchDir, argValue("confirm"));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const apply = process.argv.includes("--apply");
  if (apply) {
    const batchDir = argValue("batch-dir");
    if (!batchDir) throw new Error("写入模式必须提供 --batch-dir");
    const result = await applyCopy(batchDir, argValue("confirm"));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const result = await prepareBackup();
  console.log(JSON.stringify({ batch_dir: result.batchDir, ...result.metadata }, null, 2));
}

const isDirectRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error(error?.stack || error?.message || error);
      process.exitCode = 1;
    })
    .finally(closeMysqlPool);
}
