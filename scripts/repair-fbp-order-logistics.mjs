#!/usr/bin/env node
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { hasMeaningfulPostingMethod, mergeOrderPostingLogistics } from "../src/services/order-posting-logistics-merge.js";
import { saveOrderPostingLogistics } from "../src/services/mysql-order-posting-logistics.js";
import { retryProfitCalculationTransaction } from "../src/services/order-profit-calculation-versions.js";

const optionsError = (message) => Object.assign(new Error(message), { code: "INVALID_OPTIONS" });

export function parseFbpLogisticsRepairOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const match = /^--(shop-id|from|limit|backup)(?:=(.*))?$/.exec(args[index]);
    if (args[index] === "--write") values.write = true;
    else if (match) values[match[1]] = match[2] ?? args[++index];
    else throw optionsError("Use --shop-id=<id> --from=YYYY-MM-DD [--limit=200] [--write --backup=<new path>]");
  }
  const shopId = Number(values["shop-id"]);
  const limit = Number(values.limit ?? 200);
  const from = String(values.from || "");
  if (!Number.isSafeInteger(shopId) || shopId <= 0) throw optionsError("--shop-id must be a positive integer");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`))
    || new Date(`${from}T00:00:00Z`).toISOString().slice(0, 10) !== from) throw optionsError("--from must be a valid YYYY-MM-DD");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5000) throw optionsError("--limit must be between 1 and 5000");
  if (values.write && !values.backup) throw optionsError("--write requires --backup=<new path>");
  return { shopId, from, limit, write: Boolean(values.write), backup: values.backup,
    fromUtc: new Date(`${from}T00:00:00+08:00`).toISOString().slice(0, 19).replace("T", " ") };
}

const rawOf = (posting) => posting.raw && typeof posting.raw === "object" ? posting.raw : posting;
const text = (value) => value === undefined || value === null ? "" : String(value).trim();
function providerId(posting) {
  const raw = rawOf(posting);
  return [raw.delivery_method?.tpl_provider_id, raw.delivery_method?.provider_id, raw.tpl_provider_id,
    raw.provider_id, raw.analytics_data?.tpl_provider_id, raw.analytics_data?.provider_id].map(text).find(Boolean) || "";
}

function planRepair(current, detail, postingNumber) {
  for (const posting of [current, detail]) {
    if (text(posting?.posting_number) !== postingNumber || (rawOf(posting).posting_number && text(rawOf(posting).posting_number) !== postingNumber)) return null;
  }
  if (hasMeaningfulPostingMethod(current) || !hasMeaningfulPostingMethod(detail)) return null;
  if (!providerId(current) || providerId(current) !== providerId(detail)) return null;
  const merged = mergeOrderPostingLogistics(detail, current);
  return hasMeaningfulPostingMethod(merged) ? merged : null;
}

function preview(row, posting) {
  const raw = rawOf(posting);
  return { id: Number(row.id), posting_number: row.posting_number, method: text(raw.delivery_method?.name),
    warehouse: text(raw.delivery_method?.warehouse || raw.analytics_data?.warehouse || raw.warehouse_name),
    provider: text(raw.delivery_method?.tpl_provider || raw.analytics_data?.tpl_provider || raw.tpl_provider || providerId(posting)) };
}

async function protectedProfitRows(connection, orderId, tenantKey) {
  const [items] = await connection.query("SELECT * FROM order_items WHERE order_id = ? ORDER BY id FOR UPDATE", [orderId]);
  if (!items.length) return { items, profits: [], states: [], revisions: [] };
  const ids = items.map((item) => item.id);
  const marks = ids.map(() => "?").join(",");
  const [profits] = await connection.query(`SELECT * FROM order_profit_items WHERE order_item_id IN (${marks}) ORDER BY order_item_id`, ids);
  const [states] = await connection.query(`SELECT * FROM order_profit_calc_state
    WHERE tenant_key = ? AND order_item_id IN (${marks}) AND order_id = ? ORDER BY order_item_id`, [tenantKey, ...ids, orderId]);
  const [revisions] = await connection.query(`SELECT * FROM order_profit_calc_revisions
    WHERE tenant_key = ? AND order_item_id IN (${marks}) AND order_id = ? ORDER BY order_item_id, revision_no`, [tenantKey, ...ids, orderId]);
  return { items, profits, states, revisions };
}

export async function repairFbpOrderLogistics(options, { pool, transaction, fetchPosting, serialize }) {
  const backup = options.write ? await open(options.backup, "wx", 0o600) : null;
  try {
    if (backup) {
      await backup.chmod(0o600);
      await backup.writeFile(`${JSON.stringify({ type: "scope", shop_id: options.shopId, from: options.from, captured_at: new Date().toISOString() })}\n`);
      await backup.sync();
    }
    const [shops] = await pool.query("SELECT id, tenant_id, name, ozon_client_id, api_key_hint FROM shops WHERE id = ?", [options.shopId]);
    if (!shops[0]) throw new Error("The scoped shop does not exist");
    const shop = shops[0];
    const tenantKey = Number(shop.tenant_id) > 0 ? String(shop.tenant_id) : "admin";
    const [candidates] = await pool.query(`SELECT o.id, o.posting_number, raw.raw_json
      FROM orders o JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      WHERE o.shop_id = ? AND o.ordered_at >= ? AND raw.query_stock_location = 'FBP'
        AND UPPER(TRIM(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw.raw_json, '$.raw.delivery_method.name')), 'null'),
          NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw.raw_json, '$.delivery_method.name')), 'null'), ''))) REGEXP '^(FBP[[:space:]]*)*$'
      ORDER BY o.id LIMIT ?`, [options.shopId, options.fromUtc, options.limit]);
    const orders = [];
    let failed = 0;
    let skipped = 0;
    for (const row of candidates) {
      let detail;
      try { detail = await fetchPosting(shop, row.posting_number, { signal: AbortSignal.timeout(20000) }); }
      catch { failed++; continue; }
      if (!detail || !planRepair(JSON.parse(row.raw_json), detail, row.posting_number)) { skipped++; continue; }
      if (!options.write) {
        orders.push(preview(row, planRepair(JSON.parse(row.raw_json), detail, row.posting_number)));
        continue;
      }
      let attempt = 0;
      const repaired = await retryProfitCalculationTransaction(transaction, async (connection) => {
        attempt++;
        const [rawRows] = await connection.query(`SELECT * FROM ozon_orders_raw
          WHERE store_id = ? AND posting_number = ? AND query_stock_location = 'FBP' FOR UPDATE`, [options.shopId, row.posting_number]);
        if (!rawRows[0]) return null;
        const [orderRows] = await connection.query(`SELECT id, tracking_number, external_tracking_url FROM orders
          WHERE id = ? AND shop_id = ? AND posting_number = ? AND ordered_at >= ? FOR UPDATE`, [row.id, options.shopId, row.posting_number, options.fromUtc]);
        if (!orderRows[0]) return null;
        const current = JSON.parse(rawRows[0].raw_json);
        const merged = planRepair(current, detail, row.posting_number);
        if (!merged) return null;
        const before = await protectedProfitRows(connection, row.id, tenantKey);
        await backup.writeFile(`${JSON.stringify({ type: "order", attempt, id: row.id, shop_id: options.shopId,
          posting_number: row.posting_number, raw: rawRows[0], order_tracking: orderRows[0] })}\n`);
        await backup.sync();
        const saved = await saveOrderPostingLogistics({ transaction: (callback) => callback(connection),
          shopId: options.shopId, posting: merged, supplement: detail, serialize });
        const assignments = [];
        const params = [];
        for (const field of ["tracking_number", "external_tracking_url"]) {
          const evidence = text(detail[field] || rawOf(detail)[field]);
          if (evidence && text(saved[field]) === evidence && evidence !== text(orderRows[0][field])) {
            assignments.push(`${field} = ?`);
            params.push(evidence);
          }
        }
        if (assignments.length) await connection.execute(`UPDATE orders SET ${assignments.join(", ")}
          WHERE id = ? AND shop_id = ? AND posting_number = ?`, [...params, row.id, options.shopId, row.posting_number]);
        assert.deepEqual(await protectedProfitRows(connection, row.id, tenantKey), before, "Protected profit amounts, locks or calculation revisions changed");
        return preview(row, saved);
      }, { maxAttempts: 3 }).catch((error) => {
        error.repair_order_id = row.id;
        error.repair_posting_number = row.posting_number;
        throw error;
      });
      if (repaired) orders.push(repaired);
      else skipped++;
    }
    return { [options.write ? "repaired_orders" : "repairable_orders"]: orders.length, failed_orders: failed, skipped_orders: skipped, orders };
  } finally { await backup?.close(); }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/repair-fbp-order-logistics.mjs --shop-id=<id> --from=YYYY-MM-DD [--limit=200] [--write --backup=<new path>]");
    return;
  }
  const options = parseFbpLogisticsRepairOptions(process.argv.slice(2));
  const [{ getMysqlPool, withMysqlTransaction, closeMysqlPool }, { fetchOzonPostingByNumber }, { compactOnlineProductRawJson }] = await Promise.all([
    import("../src/mysql-pool.js"), import("../src/ozonClient.js"), import("../src/services/online-product-media-storage.js")
  ]);
  try {
    const result = await repairFbpOrderLogistics(options, { pool: getMysqlPool(), transaction: withMysqlTransaction,
      fetchPosting: fetchOzonPostingByNumber, serialize: compactOnlineProductRawJson });
    console.log(JSON.stringify(result, null, 2));
  } finally { await closeMysqlPool(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.code === "INVALID_OPTIONS" ? error.message : "FBP logistics repair failed; inspect the backup before retrying",
      code: String(error.code || error.name || "ERROR").replace(/[^A-Za-z0-9_]/g, "").slice(0, 64),
      errno: Number(error.errno) || undefined, order_id: error.repair_order_id, posting_number: error.repair_posting_number }));
    process.exitCode = 1;
  });
}
