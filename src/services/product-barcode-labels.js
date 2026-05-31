import bwipjs from "bwip-js";
import fs from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  fetchOzonProductStocks,
  fetchOzonProductsByIds,
  generateOzonBarcodes
} from "../ozonClient.js";
import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const MM_TO_PT = 72 / 25.4;
const LABEL_LAYOUT_TYPE = "ozon_compact_vector_v1";
const THERMAL_LABEL = {
  width: 121.88,
  height: 70.86
};

let productBarcodeLabelCacheReady = false;

function ensureMysqlCutoverEnabled() {
  if (!isMysqlPrimaryEnabled()) {
    throw new Error("MySQL cutover routes are not enabled");
  }
}

async function ensureProductBarcodeLabelCacheSchemaMysql() {
  if (productBarcodeLabelCacheReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS product_barcode_label_cache (
      online_product_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      shop_id BIGINT UNSIGNED NOT NULL,
      ozon_product_id VARCHAR(128) NOT NULL DEFAULT '',
      barcode_value VARCHAR(128) NOT NULL DEFAULT '',
      layout_type VARCHAR(32) NOT NULL DEFAULT 'thermal',
      product_name VARCHAR(255) NOT NULL DEFAULT '',
      label_pdf LONGBLOB NOT NULL,
      label_size INT NOT NULL DEFAULT 0,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fetch_source VARCHAR(32) NOT NULL DEFAULT 'render',
      KEY idx_product_barcode_label_cache_shop (shop_id, fetched_at),
      KEY idx_product_barcode_label_cache_barcode (barcode_value)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  productBarcodeLabelCacheReady = true;
}

export async function ensureProductBarcodeLabelCacheReadyMysql() {
  await ensureProductBarcodeLabelCacheSchemaMysql();
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function chooseBarcode(barcodes = []) {
  const list = [...new Set((barcodes || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!list.length) return "";
  return list.find((item) => /^OZN/i.test(item)) || list[0];
}

function hasOzonBarcode(barcodes = []) {
  return (barcodes || []).some((item) => /^OZN/i.test(String(item || "").trim()));
}

function filenameSafeText(value, fallback = "barcode") {
  const cleaned = String(value || "").trim().replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function safePdfText(value, fallback = "") {
  const text = String(value || "").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function decodeInputItems(body = {}) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const normalized = rawItems
    .map((item) => ({
      online_product_id: Number(item?.online_product_id || item?.onlineProductId || 0),
      shop_id: Number(item?.shop_id || item?.shopId || 0),
      ozon_sku: String(item?.ozon_sku || item?.ozonSku || "").trim(),
      offer_id: String(item?.offer_id || item?.offerId || "").trim(),
      quantity: Math.max(1, Math.round(Number(item?.quantity || 1))),
      name: String(item?.name || "").trim()
    }))
    .filter((item) => item.online_product_id || (item.shop_id && (item.ozon_sku || item.offer_id)));
  if (normalized.length) return normalized;
  const singleId = Number(body.online_product_id || body.onlineProductId || 0);
  if (singleId) {
    return [{ online_product_id: singleId, quantity: Math.max(1, Math.round(Number(body.quantity || 1))) }];
  }
  const fallbackShopId = Number(body.shop_id || body.shopId || 0);
  const fallbackSku = String(body.ozon_sku || body.ozonSku || "").trim();
  const fallbackOffer = String(body.offer_id || body.offerId || "").trim();
  return fallbackShopId && (fallbackSku || fallbackOffer)
    ? [{
      online_product_id: 0,
      shop_id: fallbackShopId,
      ozon_sku: fallbackSku,
      offer_id: fallbackOffer,
      quantity: Math.max(1, Math.round(Number(body.quantity || 1)))
    }]
    : [];
}

function sortRowsByInput(rows = [], ids = []) {
  const order = new Map(ids.map((id, index) => [String(id), index]));
  return [...rows].sort((a, b) => (order.get(String(a.online_product_id)) ?? 0) - (order.get(String(b.online_product_id)) ?? 0));
}

async function resolveOnlineProductsForBarcodeLabels(inputItems = []) {
  if (!inputItems.length) throw new Error("Select products to download barcodes");
  const ids = [...new Set(inputItems.map((item) => Number(item.online_product_id)).filter(Boolean))];
  const directRows = ids.length ? await mysqlQuery(`
    SELECT
      op.id AS online_product_id,
      op.shop_id,
      op.ozon_sku,
      op.offer_id,
      op.ozon_product_id,
      op.name,
      op.primary_image,
      op.image_url,
      op.barcodes_json,
      s.name AS shop_name,
      s.ozon_client_id,
      s.api_key_hint,
      s.ozon_api_key
    FROM online_products op
    JOIN shops s ON s.id = op.shop_id
    WHERE op.id IN (${ids.map(() => "?").join(",")})
  `, ids) : [];
  const rowsById = new Map(directRows.map((row) => [String(row.online_product_id), row]));
  const resolved = [];
  for (const item of inputItems) {
    let row = item.online_product_id ? rowsById.get(String(item.online_product_id)) : null;
    if (!row && item.shop_id && (item.ozon_sku || item.offer_id)) {
      const fallbackRows = await mysqlQuery(`
        SELECT
          op.id AS online_product_id,
          op.shop_id,
          op.ozon_sku,
          op.offer_id,
          op.ozon_product_id,
          op.name,
          op.primary_image,
          op.image_url,
          op.barcodes_json,
          s.name AS shop_name,
          s.ozon_client_id,
          s.api_key_hint,
          s.ozon_api_key
        FROM online_products op
        JOIN shops s ON s.id = op.shop_id
        WHERE op.shop_id = ?
          AND (op.ozon_sku = ? OR op.offer_id = ?)
        ORDER BY CASE WHEN op.ozon_sku = ? THEN 0 WHEN op.offer_id = ? THEN 1 ELSE 2 END, op.id DESC
        LIMIT 1
      `, [
        Number(item.shop_id),
        String(item.ozon_sku || ""),
        String(item.offer_id || ""),
        String(item.ozon_sku || ""),
        String(item.offer_id || "")
      ]);
      row = fallbackRows[0] || null;
    }
    if (!row) {
      const label = item.ozon_sku || item.offer_id || item.online_product_id || "unknown";
      throw new Error(`Online product not found for ${label}`);
    }
    resolved.push({
      ...row,
      quantity: item.quantity || 1
    });
  }
  return resolved;
}

async function resolveOzonProductIdFromStocks(shop, row) {
  const offerIds = [row.offer_id, row.ozon_sku].map((item) => String(item || "").trim()).filter(Boolean);
  if (!offerIds.length) return 0;
  const stockRows = await fetchOzonProductStocks(shop, { offerIds, limit: 1000 });
  const matched = stockRows.find((item) => offerIds.includes(String(item.offer_id || "").trim()) || offerIds.includes(String(item.ozon_sku || "").trim()));
  return Number(matched?.ozon_product_id || 0);
}

async function resolveEffectiveOzonProductId(shop, row) {
  const resolved = await resolveOzonProductIdFromStocks(shop, row);
  if (resolved) return resolved;
  return Number(row.ozon_product_id || 0);
}

async function syncOnlineProductBarcodeData(shop, row, options = {}) {
  let ozonProductId = await resolveEffectiveOzonProductId(shop, row);
  if (!ozonProductId) {
    throw new Error(`Product ${row.name || row.offer_id || row.ozon_sku || row.online_product_id} is missing Ozon product_id`);
  }

  const fetched = await fetchOzonProductsByIds(shop, [ozonProductId]);
  const matched = fetched.find((item) => Number(item.ozon_product_id || 0) === ozonProductId)
    || fetched.find((item) => String(item.offer_id || "") === String(row.offer_id || ""))
    || null;
  const barcodes = matched ? parseJsonArray(matched.barcodes_json) : [];
  const fallbackBarcode = String(options.generatedBarcode || "").trim();
  const nextBarcodes = barcodes.length ? barcodes : (fallbackBarcode ? [fallbackBarcode] : []);
  await mysqlExecute(`
    UPDATE online_products
    SET
      ozon_product_id = ?,
      name = COALESCE(NULLIF(?, ''), name),
      primary_image = COALESCE(NULLIF(?, ''), primary_image),
      image_url = COALESCE(NULLIF(?, ''), image_url),
      barcodes_json = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    String(ozonProductId),
    matched?.name || row.name || "",
    matched?.primary_image || row.primary_image || "",
    matched?.image_url || row.image_url || "",
    JSON.stringify(nextBarcodes),
    Number(row.online_product_id)
  ]);
  return {
    ...row,
    ozon_product_id: String(ozonProductId),
    name: matched?.name || row.name || "",
    primary_image: matched?.primary_image || row.primary_image || "",
    image_url: matched?.image_url || row.image_url || "",
    barcodes_json: JSON.stringify(nextBarcodes)
  };
}

async function ensureProductBarcode(row, options = {}) {
  const currentBarcodes = parseJsonArray(row.barcodes_json);
  const existing = chooseBarcode(currentBarcodes);
  if (existing && hasOzonBarcode(currentBarcodes) && !options.forceGenerate) {
    return { row, barcode: existing, generated: false };
  }

  const shop = {
    id: row.shop_id,
    name: row.shop_name,
    ozon_client_id: row.ozon_client_id,
    api_key_hint: row.api_key_hint,
    ozon_api_key: row.ozon_api_key
  };
  let ozonProductId = await resolveEffectiveOzonProductId(shop, row);
  if (!ozonProductId) {
    throw new Error(`Product ${row.name || row.offer_id || row.ozon_sku || row.online_product_id} cannot generate a barcode without Ozon product_id`);
  }
  const generated = await generateOzonBarcodes(shop, [ozonProductId]);
  const generatedBarcode = String(
    generated?.result?.[0]?.barcode
    || generated?.result?.barcode
    || generated?.barcode
    || ""
  ).trim();
  const syncedRow = await syncOnlineProductBarcodeData(shop, { ...row, ozon_product_id: String(ozonProductId) }, { generatedBarcode });
  const nextBarcode = chooseBarcode(parseJsonArray(syncedRow.barcodes_json)) || generatedBarcode;
  if (!nextBarcode) throw new Error(`Ozon did not return a barcode for ${row.name || row.offer_id || row.ozon_sku || row.online_product_id}`);
  return { row: syncedRow, barcode: nextBarcode, generated: true };
}

async function renderThermalBarcodeLabelPdf(row, barcode) {
  const svg = bwipjs.toSVG({
    bcid: "code128",
    text: String(barcode || "").trim(),
    height: 22,
    includetext: false,
    paddingwidth: 12,
    backgroundcolor: "FFFFFF"
  });
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await embedBarcodeLabelFont(pdf);
  const page = pdf.addPage([THERMAL_LABEL.width, THERMAL_LABEL.height]);
  const marginX = 4;
  const barcodeWidth = THERMAL_LABEL.width - marginX * 2;
  const barcodeHeight = 41;
  const barcodeY = THERMAL_LABEL.height - barcodeHeight - 1;
  drawBwipSvgBarcode(page, svg, {
    x: marginX,
    y: barcodeY,
    width: barcodeWidth,
    height: barcodeHeight
  });
  const barcodeText = String(barcode || "").trim();
  const barcodeTextSize = 11.5;
  page.drawText(barcodeText, {
    x: marginX,
    y: 15.5,
    size: barcodeTextSize,
    font,
    color: rgb(0.08, 0.1, 0.14)
  });
  const printableName = barcodeLabelTitle(row);
  const titleLines = wrapText(printableName, font, 5.3, THERMAL_LABEL.width - 8, 2);
  titleLines.forEach((line, index) => {
    page.drawText(line, {
      x: 4,
      y: 7.2 - index * 5.3,
      size: 5.3,
      font,
      color: rgb(0.08, 0.1, 0.14)
    });
  });
  return Buffer.from(await pdf.save());
}

function drawBwipSvgBarcode(page, svg, box) {
  const viewBoxMatch = String(svg || "").match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const sourceWidth = Number(viewBoxMatch?.[1] || 0);
  const sourceHeight = Number(viewBoxMatch?.[2] || 0);
  if (!sourceWidth || !sourceHeight) return;
  const scaleX = box.width / sourceWidth;
  const scaleY = box.height / sourceHeight;
  const pathPattern = /<path[^>]*stroke-width="([\d.]+)"[^>]*d="([^"]+)"[^>]*>/g;
  for (const match of String(svg || "").matchAll(pathPattern)) {
    const strokeWidth = Number(match[1] || 0);
    const d = match[2] || "";
    const barPattern = /M([\d.]+)\s+126L\1\s+0/g;
    for (const bar of d.matchAll(barPattern)) {
      const sourceX = Number(bar[1] || 0);
      const x = box.x + sourceX * scaleX - (strokeWidth * scaleX) / 2;
      page.drawRectangle({
        x,
        y: box.y,
        width: Math.max(0.35, strokeWidth * scaleX),
        height: box.height,
        color: rgb(0, 0, 0)
      });
    }
  }
}

function barcodeLabelTitle(row) {
  return String(row.name || row.offer_id || row.ozon_sku || "Ozon barcode").replace(/\s+/g, " ").trim();
}

async function embedBarcodeLabelFont(pdf) {
  try {
    const bytes = await fs.readFile("C:\\Windows\\Fonts\\arial.ttf");
    return pdf.embedFont(bytes, { subset: true });
  } catch {
    return pdf.embedFont(StandardFonts.Helvetica);
  }
}

function centerTextX(text, font, size, width) {
  return Math.max(8, (width - font.widthOfTextAtSize(text, size)) / 2);
}

function wrapText(text, font, size, maxWidth, maxLines = 2) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    lines[maxLines - 1] = truncateText(lines[maxLines - 1], font, size, maxWidth);
  }
  return lines;
}

function truncateText(text, font, size, maxWidth) {
  const suffix = "...";
  let value = String(text || "");
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  while (value.length > 1 && font.widthOfTextAtSize(`${value}${suffix}`, size) > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}${suffix}`;
}

async function loadCachedBarcodeLabel(onlineProductId) {
  const rows = await mysqlQuery(`
    SELECT barcode_value, layout_type, product_name, label_pdf
    FROM product_barcode_label_cache
    WHERE online_product_id = ?
    LIMIT 1
  `, [Number(onlineProductId)]);
  const cached = rows[0];
  if (!cached?.label_pdf) return null;
  return {
    barcode_value: String(cached.barcode_value || ""),
    layout_type: String(cached.layout_type || ""),
    product_name: String(cached.product_name || ""),
    buffer: Buffer.isBuffer(cached.label_pdf) ? cached.label_pdf : Buffer.from(cached.label_pdf)
  };
}

export async function listCachedBarcodeLabelsByOnlineProductIdsMysql(onlineProductIds = []) {
  ensureMysqlCutoverEnabled();
  await ensureProductBarcodeLabelCacheSchemaMysql();
  const ids = [...new Set((onlineProductIds || []).map((item) => Number(item)).filter(Boolean))];
  if (!ids.length) return [];
  return mysqlQuery(`
    SELECT online_product_id, barcode_value, layout_type, product_name, label_size, fetched_at, fetch_source
    FROM product_barcode_label_cache
    WHERE online_product_id IN (${ids.map(() => "?").join(",")})
  `, ids);
}

async function cacheBarcodeLabel(row, barcode, buffer, source = "render") {
  await mysqlExecute(`
    INSERT INTO product_barcode_label_cache
      (online_product_id, shop_id, ozon_product_id, barcode_value, layout_type, product_name, label_pdf, label_size, fetched_at, fetch_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON DUPLICATE KEY UPDATE
      shop_id = VALUES(shop_id),
      ozon_product_id = VALUES(ozon_product_id),
      barcode_value = VALUES(barcode_value),
      layout_type = VALUES(layout_type),
      product_name = VALUES(product_name),
      label_pdf = VALUES(label_pdf),
      label_size = VALUES(label_size),
      fetched_at = CURRENT_TIMESTAMP,
      fetch_source = VALUES(fetch_source)
  `, [
    Number(row.online_product_id),
    Number(row.shop_id),
    String(row.ozon_product_id || ""),
    String(barcode || ""),
    LABEL_LAYOUT_TYPE,
    String(row.name || ""),
    buffer,
    buffer.length,
    source
  ]);
}

async function singleBarcodeLabelBuffer(row, barcode, options = {}) {
  const cached = options.refreshCache ? null : await loadCachedBarcodeLabel(row.online_product_id);
  if (
    cached?.buffer?.length &&
    cached.barcode_value === String(barcode || "") &&
    cached.layout_type === LABEL_LAYOUT_TYPE &&
    cached.product_name === String(row.name || "")
  ) {
    return { buffer: cached.buffer, cached: true };
  }
  const buffer = await renderThermalBarcodeLabelPdf(row, barcode);
  await cacheBarcodeLabel(row, barcode, buffer, "render");
  return { buffer, cached: false };
}

async function mergePdfCopies(buffer, copies) {
  if (copies <= 1) return buffer;
  const source = await PDFDocument.load(buffer);
  const merged = await PDFDocument.create();
  for (let index = 0; index < copies; index += 1) {
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

async function mergePdfBuffers(buffers = []) {
  if (buffers.length === 1) return buffers[0];
  const merged = await PDFDocument.create();
  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

export async function generateProductBarcodeLabelMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProductBarcodeLabelCacheSchemaMysql();
  const inputItems = decodeInputItems(body);
  if (!inputItems.length) throw new Error("Select products to generate barcodes");
  if (inputItems.length > 50) throw new Error("Generate at most 50 products per batch");
  const forceGenerate = body.force_generate === true;
  const refreshCache = body.refresh_cache !== false;
  const rows = await resolveOnlineProductsForBarcodeLabels(inputItems);
  const items = [];

  for (const row of rows) {
    const ensured = await ensureProductBarcode(row, { forceGenerate });
    const single = await singleBarcodeLabelBuffer(ensured.row, ensured.barcode, { refreshCache });
    items.push({
      online_product_id: Number(ensured.row.online_product_id),
      ozon_sku: String(ensured.row.ozon_sku || ""),
      offer_id: String(ensured.row.offer_id || ""),
      barcode_value: String(ensured.barcode || ""),
      generated: Boolean(ensured.generated),
      cached: Boolean(single.cached)
    });
  }

  return {
    ok: true,
    count: items.length,
    items
  };
}

export async function productBarcodeLabelMysql(body = {}) {
  ensureMysqlCutoverEnabled();
  await ensureProductBarcodeLabelCacheSchemaMysql();
  const inputItems = decodeInputItems(body);
  if (!inputItems.length) throw new Error("Select products to download barcodes");
  if (inputItems.length > 50) throw new Error("Download at most 50 products per batch");
  const forceGenerate = body.force_generate === true;
  const refreshCache = body.refresh_cache === true;
  const rows = await resolveOnlineProductsForBarcodeLabels(inputItems);
  const buffers = [];
  let generatedCount = 0;
  let cacheHits = 0;

  for (const row of rows) {
    const ensured = await ensureProductBarcode(row, { forceGenerate });
    if (ensured.generated) generatedCount += 1;
    const single = await singleBarcodeLabelBuffer(ensured.row, ensured.barcode, { refreshCache });
    if (single.cached) cacheHits += 1;
    buffers.push(await mergePdfCopies(single.buffer, Math.max(1, Number(row.quantity || 1))));
  }

  const buffer = await mergePdfBuffers(buffers);
  const suffix = rows.length === 1
    ? filenameSafeText(rows[0].offer_id || rows[0].ozon_sku || rows[0].name || "barcode")
    : `${rows.length}-products`;
  return {
    buffer,
    filename: `ozon-barcodes-${suffix}.pdf`,
    count: rows.reduce((sum, row) => sum + Math.max(1, Number(row.quantity || 1)), 0),
    product_count: rows.length,
    stats: {
      generated_count: generatedCount,
      cache_hits: cacheHits,
      cache_misses: rows.length - cacheHits
    }
  };
}
