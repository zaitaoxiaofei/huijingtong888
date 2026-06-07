import { createMysqlConnection, closeMysqlConnection } from "./mysql-runtime.mjs";

function parseArgs(argv = []) {
  return {
    apply: argv.includes("--apply")
  };
}

function parseJson(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function strictSkuValue(item = {}) {
  const candidate = String(
    item.sku
      || item.fbo_sku
      || item.fbs_sku
      || item.product_sku
      || item.productSku
      || item.ozon_sku
      || ""
  ).trim();
  if (!candidate || candidate === "0" || candidate.startsWith("__MISSING_SKU__:")) return "";
  return candidate;
}

function missingSkuMarker(row = {}) {
  const productId = String(row.ozon_product_id || "").trim();
  const offerId = String(row.offer_id || "").trim();
  const seed = productId || offerId || String(row.id || "unknown");
  return `__MISSING_SKU__:${seed}`.slice(0, 128);
}

function replacementSku(row = {}) {
  const raw = parseJson(row.raw_json);
  return strictSkuValue(raw) || strictSkuValue(row) || "";
}

async function loadRows(connection) {
  const [rows] = await connection.execute(`
    SELECT id, shop_id, ozon_sku, offer_id, ozon_product_id, raw_json, updated_at
    FROM online_products
    ORDER BY id ASC
  `);
  return rows;
}

function analyzeRows(rows = []) {
  const byIdentity = new Map();
  for (const row of rows) {
    const key = `${row.shop_id}#${row.offer_id || ""}#${row.ozon_product_id || ""}`;
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(row);
  }

  const actions = [];
  const stats = {
    total: rows.length,
    pollutedOfferFallback: 0,
    updateToRealSku: 0,
    updateToMissingMarker: 0,
    deleteMergedDuplicate: 0,
    unchanged: 0
  };

  for (const row of rows) {
    const storedSku = String(row.ozon_sku || "").trim();
    const offerId = String(row.offer_id || "").trim();
    const productId = String(row.ozon_product_id || "").trim();
    const isOfferFallback = Boolean(storedSku && offerId && storedSku === offerId);
    if (!isOfferFallback) {
      stats.unchanged += 1;
      continue;
    }
    stats.pollutedOfferFallback += 1;

    const identityKey = `${row.shop_id}#${offerId}#${productId}`;
    const siblings = (byIdentity.get(identityKey) || []).filter((item) => Number(item.id) !== Number(row.id));
    const realSibling = siblings
      .filter((item) => {
        const siblingSku = String(item.ozon_sku || "").trim();
        return siblingSku && siblingSku !== offerId && !siblingSku.startsWith("__MISSING_SKU__:");
      })
      .sort((left, right) => Number(new Date(right.updated_at || 0)) - Number(new Date(left.updated_at || 0)) || Number(right.id) - Number(left.id))[0];

    if (realSibling) {
      actions.push({
        type: "delete",
        id: Number(row.id),
        reason: "merged_into_real_sku_sibling",
        sibling_id: Number(realSibling.id),
        next_sku: String(realSibling.ozon_sku || "")
      });
      stats.deleteMergedDuplicate += 1;
      continue;
    }

    const realSku = replacementSku(row);
    if (realSku && realSku !== storedSku) {
      actions.push({
        type: "update",
        id: Number(row.id),
        reason: "replace_offer_fallback_with_real_sku",
        next_sku: realSku
      });
      stats.updateToRealSku += 1;
      continue;
    }

    const marker = missingSkuMarker(row);
    if (marker !== storedSku) {
      actions.push({
        type: "update",
        id: Number(row.id),
        reason: "replace_offer_fallback_with_missing_marker",
        next_sku: marker
      });
      stats.updateToMissingMarker += 1;
      continue;
    }

    stats.unchanged += 1;
  }

  return { actions, stats };
}

async function applyActions(connection, actions = []) {
  if (!actions.length) return;
  await connection.beginTransaction();
  try {
    for (const action of actions) {
      if (action.type === "delete") {
        await connection.execute("DELETE FROM online_products WHERE id = ?", [action.id]);
        continue;
      }
      await connection.execute(
        "UPDATE online_products SET ozon_sku = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [action.next_sku, action.id]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connection = await createMysqlConnection();
  try {
    const rows = await loadRows(connection);
    const result = analyzeRows(rows);
    if (options.apply) await applyActions(connection, result.actions);
    console.log(JSON.stringify({
      mode: options.apply ? "apply" : "dry-run",
      ...result.stats,
      actionCount: result.actions.length,
      samples: result.actions.slice(0, 20)
    }, null, 2));
  } finally {
    await closeMysqlConnection(connection);
  }
}

await main();
