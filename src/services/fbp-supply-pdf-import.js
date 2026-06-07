import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const ACTIVE_TRANSFER_STATUSES = new Set(["draft", "sent", "in_transit", "received"]);

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function numberValue(value = "") {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function decodePdfBase64(value = "") {
  const raw = String(value || "").replace(/^data:application\/pdf;base64,/i, "").trim();
  if (!raw) throw new Error("请上传 FBP 入库单 PDF");
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.length || buffer.length > MAX_PDF_BYTES) throw new Error("PDF 文件大小不合法，请上传 8MB 以内的文件");
  if (buffer.slice(0, 5).toString("ascii") !== "%PDF-") throw new Error("文件不是有效的 PDF");
  return buffer;
}

async function withTempPdf(buffer, callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fbp-supply-"));
  const file = path.join(dir, `${randomUUID()}.pdf`);
  try {
    await fs.writeFile(file, buffer);
    return await callback(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function runMutool(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("mutool", args, { windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8") || `mutool exited with ${code}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function extractPdfText(pdfPath) {
  return runMutool(["draw", "-F", "text", "-o", "-", pdfPath]);
}

async function extractPdfStructuredJson(pdfPath) {
  const raw = await runMutool(["draw", "-F", "stext.json", "-o", "-", pdfPath]);
  return JSON.parse(raw);
}

function readNextLine(lines, label) {
  const index = lines.findIndex((line) => line === label || line.includes(label));
  return index >= 0 ? cleanText(lines[index + 1] || "") : "";
}

function parseHeaderFromText(text = "") {
  const lines = text.split(/\r?\n/).map(cleanText).filter(Boolean);
  const orderMatch = text.match(/入库单\s*(\d{8,})/) || text.match(/^\s*(\d{8,})\s*$/m);
  const generatedMatch = text.match(/文件生成时间\s*:?\s*([0-9:\-\s]+)/);
  return {
    supply_order_id: orderMatch?.[1] || "",
    generated_at: cleanText(generatedMatch?.[1] || ""),
    warehouse_name: readNextLine(lines, "仓库名"),
    warehouse_address: readNextLine(lines, "仓库地址"),
    seller_id: readNextLine(lines, "卖家ID"),
    seller_name: cleanText([readNextLine(lines, "卖家名称"), lines[lines.findIndex((line) => line.includes("卖家名称")) + 2] || ""].join(" ")),
    supply_type: readNextLine(lines, "入库类型"),
    slot_time: readNextLine(lines, "时间段"),
    vehicle_type: readNextLine(lines, "车辆类型"),
    plate_no: readNextLine(lines, "车牌号"),
    driver_name: readNextLine(lines, "司机名"),
    total_sku: numberValue(readNextLine(lines, "总唯一SKU数量")),
    total_quantity: numberValue(readNextLine(lines, "总数量")),
    box_count: numberValue(readNextLine(lines, "总箱数"))
  };
}

function parseItemsFromText(text = "") {
  const items = [];
  const lines = text.split(/\r?\n/).map(cleanText).filter(Boolean);
  const skuIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/SKU号码:\s*\d+/.test(lines[index])) skuIndexes.push(index);
  }
  for (let itemIndex = 0; itemIndex < skuIndexes.length; itemIndex += 1) {
    const start = skuIndexes[itemIndex];
    const end = skuIndexes[itemIndex + 1] || lines.length;
    const block = lines.slice(start, end);
    const skuNumber = block.find((line) => /SKU号码:\s*\d+/.test(line))?.match(/(\d{8,})/)?.[1] || "";
    const ozonSku = block.find((line) => /OZN\d+/.test(line))?.match(/(OZN\d+)/)?.[1] || "";
    if (!ozonSku) continue;
    const titleParts = [];
    const titleIndex = block.findIndex((line) => line.includes("产品名"));
    if (titleIndex >= 0) {
      for (let index = titleIndex; index < block.length; index += 1) {
        const line = block[index];
        if (index > titleIndex && (
          /^\d+(?:[.,]\d+)?$/.test(line)
          || /^\d+(?:[.,]\d+)?\*\d+(?:[.,]\d+)?\*\d+(?:[.,]\d+)?$/.test(line)
          || line.startsWith("Page ")
          || line.includes("文件生成时间")
          || line === "№"
        )) break;
        titleParts.push(index === titleIndex ? line.replace(/^.*产品名\s*:?\s*/, "") : line);
      }
    }
    let quantity = 0;
    const dimensionIndex = block.findIndex((line) => /^\d+(?:[.,]\d+)?\*\d+(?:[.,]\d+)?\*\d+(?:[.,]\d+)?$/.test(line));
    if (dimensionIndex >= 0) {
      const qtyLine = block.slice(dimensionIndex + 1).find((line) => /^\d+$/.test(line));
      quantity = Number(qtyLine || 0);
    }
    items.push({
      sku_number: skuNumber,
      ozon_sku: ozonSku,
      title: cleanText(titleParts.join("")),
      quantity
    });
  }
  return items;
}

function flattenStructuredLines(structured = {}) {
  const lines = [];
  for (const [pageIndex, page] of (structured.pages || []).entries()) {
    for (const block of page.blocks || []) {
      if (block.type !== "text") continue;
      for (const line of block.lines || []) {
        const text = cleanText(line.text || "");
        if (!text) continue;
        lines.push({
          page: pageIndex + 1,
          x: Number(line.x ?? line.bbox?.x ?? 0),
          y: Number(line.y ?? line.bbox?.y ?? 0),
          text
        });
      }
    }
  }
  return lines;
}

function parseItemsFromStructuredJson(structured = {}, fallbackText = "") {
  const lines = flattenStructuredLines(structured);
  const fallbackTitles = new Map(parseItemsFromText(fallbackText).map((item) => [item.ozon_sku, item.title]));
  const items = [];
  for (const line of lines) {
    const match = line.text.match(/(OZN\d+)/);
    if (!match) continue;
    const ozonSku = match[1];
    const samePage = lines.filter((item) => item.page === line.page);
    const skuLine = samePage
      .filter((item) => item.y <= line.y && item.y >= line.y - 24 && /\d{8,}/.test(item.text) && !/OZN\d+/.test(item.text))
      .sort((a, b) => Math.abs(a.y - line.y) - Math.abs(b.y - line.y))[0];
    const qtyLine = samePage
      .filter((item) => item.x >= 480 && item.x <= 510 && Math.abs(item.y - line.y) <= 18 && item.y > 180 && /^\d+$/.test(item.text))
      .sort((a, b) => Math.abs(a.y - line.y) - Math.abs(b.y - line.y))[0];
    const titleLine = samePage
      .filter((item) => item.x >= 55 && item.x <= 110 && item.y > line.y && item.y <= line.y + 34 && item.text.includes("产品名"))
      .sort((a, b) => a.y - b.y)[0];
    items.push({
      sku_number: skuLine?.text.match(/(\d{8,})/)?.[1] || ozonSku.replace(/^OZN/, ""),
      ozon_sku: ozonSku,
      title: cleanText(titleLine?.text.replace(/^.*产品名\s*:?\s*/, "") || fallbackTitles.get(ozonSku) || ""),
      quantity: Number(qtyLine?.text || 0)
    });
  }
  const seen = new Set();
  return items.filter((item) => {
    if (!item.ozon_sku || seen.has(item.ozon_sku)) return false;
    seen.add(item.ozon_sku);
    return true;
  });
}

async function parseFbpSupplyPdf(buffer) {
  return withTempPdf(buffer, async (pdfPath) => {
    const [text, structured] = await Promise.all([
      extractPdfText(pdfPath),
      extractPdfStructuredJson(pdfPath)
    ]);
    const header = parseHeaderFromText(text);
    const textItems = parseItemsFromText(text);
    const textQuantity = textItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const textLooksComplete = textItems.length > 0
      && (!header.total_sku || textItems.length === header.total_sku)
      && (!header.total_quantity || textQuantity === header.total_quantity);
    const items = textLooksComplete ? textItems : parseItemsFromStructuredJson(structured, text);
    if (!header.supply_order_id) throw new Error("未识别到入库单号");
    if (!items.length) throw new Error("未识别到 PDF 商品明细");
    const parsedQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    return {
      header,
      items,
      checks: {
        parsed_sku_count: items.length,
        parsed_quantity: parsedQuantity,
        total_sku_matched: !header.total_sku || header.total_sku === items.length,
        total_quantity_matched: !header.total_quantity || header.total_quantity === parsedQuantity
      }
    };
  });
}

async function resolvePdfShop(header = {}, body = {}) {
  const shopId = Number(body.shop_id || body.shopId || 0);
  if (shopId) {
    const rows = await mysqlQuery("SELECT id, name FROM shops WHERE id = ? AND status = 'active' LIMIT 1", [shopId]);
    if (!rows[0]) throw new Error("选择的店铺不存在或未启用");
    return rows[0];
  }
  const sellerId = String(header.seller_id || "").trim();
  if (sellerId) {
    const rows = await mysqlQuery("SELECT id, name FROM shops WHERE ozon_client_id = ? AND status = 'active' LIMIT 1", [sellerId]);
    if (rows[0]) return rows[0];
  }
  const rows = await mysqlQuery("SELECT id, name FROM shops WHERE status = 'active' ORDER BY id LIMIT 1");
  if (!rows[0]) throw new Error("系统没有可用店铺，请先配置店铺");
  return rows[0];
}

async function resolvePdfMappings(shopId, items = []) {
  const resolved = [];
  for (const item of items) {
    const rows = await mysqlQuery(`
      SELECT sm.id AS mapping_id, sm.product_id, sm.shop_id, sm.ozon_sku, sm.offer_id, p.name AS product_name
      FROM sku_mappings sm
      LEFT JOIN products p ON p.id = sm.product_id
      WHERE sm.active = 1
        AND sm.shop_id = ?
        AND (sm.ozon_sku = ? OR sm.ozon_sku = ? OR sm.offer_id = ?)
      ORDER BY CASE WHEN sm.ozon_sku = ? THEN 0 ELSE 1 END, sm.id DESC
      LIMIT 1
    `, [shopId, item.ozon_sku, item.sku_number, item.sku_number, item.ozon_sku]);
    resolved.push({
      ...item,
      mapping_id: rows[0]?.mapping_id || null,
      product_id: rows[0]?.product_id || null,
      product_name: rows[0]?.product_name || "",
      mapped_ozon_sku: rows[0]?.ozon_sku || "",
      matched: Boolean(rows[0]?.product_id)
    });
  }
  return resolved;
}

export async function previewFbpSupplyPdfMysql(body = {}) {
  const buffer = decodePdfBase64(body.pdf_base64 || body.pdfBase64);
  const parsed = await parseFbpSupplyPdf(buffer);
  const shop = await resolvePdfShop(parsed.header, body);
  const items = await resolvePdfMappings(shop.id, parsed.items);
  return {
    ok: true,
    shop,
    header: parsed.header,
    items,
    checks: {
      ...parsed.checks,
      matched_count: items.filter((item) => item.matched).length,
      unmatched_count: items.filter((item) => !item.matched).length
    }
  };
}

export async function importFbpSupplyPdfMysql(body = {}, userId = null) {
  const preview = await previewFbpSupplyPdfMysql(body);
  const unmatched = preview.items.filter((item) => !item.matched);
  if (unmatched.length && body.allow_unmatched !== true) {
    throw new Error(`有 ${unmatched.length} 个 SKU 未匹配商品，请先绑定后再导入`);
  }
  if (!preview.checks.total_quantity_matched) {
    throw new Error("PDF 明细数量合计与汇总总数量不一致，请检查文件");
  }
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of preview.items) {
    if (!item.matched) {
      skipped += 1;
      continue;
    }
    const sourceRef = `pdf:${preview.header.supply_order_id}:${item.ozon_sku}`;
    const legacySourceRef = `seller:${preview.header.supply_order_id}:${item.ozon_sku}`;
    const existingRows = await mysqlQuery(`
      SELECT id, status
      FROM fbp_transfer_records
      WHERE (source_type = 'seller_fbp_supply_pdf' AND source_ref = ?)
         OR (source_type = 'seller_fbp_supply' AND source_ref = ?)
      LIMIT 1
    `, [sourceRef, legacySourceRef]);
    const status = ACTIVE_TRANSFER_STATUSES.has(String(existingRows[0]?.status || "")) ? existingRows[0].status : "in_transit";
    const values = [
      Number(item.product_id),
      Number(item.mapping_id),
      Number(preview.shop.id),
      item.mapped_ozon_sku || item.sku_number || item.ozon_sku,
      Number(item.quantity || 0),
      0,
      status,
      "seller_fbp_supply_pdf",
      sourceRef,
      preview.header.warehouse_name || "",
      `FBP入库单 ${preview.header.supply_order_id}，${item.title || item.ozon_sku}，PDF条码 ${item.ozon_sku}`,
      userId || null,
      preview.header.slot_time || null
    ];
    if (existingRows[0]?.id) {
      await mysqlExecute(`
        UPDATE fbp_transfer_records
        SET product_id = ?, mapping_id = ?, shop_id = ?, ozon_sku = ?, quantity = ?, listed_quantity = ?,
            status = ?, source_type = ?, source_ref = ?, warehouse_name = ?, note = ?, person_id = ?, shipped_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [...values, Number(existingRows[0].id)]);
      updated += 1;
    } else {
      await mysqlExecute(`
        INSERT INTO fbp_transfer_records
          (product_id, mapping_id, shop_id, ozon_sku, quantity, listed_quantity, status, source_type, source_ref, warehouse_name, note, person_id, shipped_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, values);
      inserted += 1;
    }
  }
  return {
    ok: true,
    inserted,
    updated,
    skipped,
    message: `PDF入库单 ${preview.header.supply_order_id} 已导入：新增 ${inserted} 条，更新 ${updated} 条${skipped ? `，跳过 ${skipped} 条` : ""}`,
    preview
  };
}
