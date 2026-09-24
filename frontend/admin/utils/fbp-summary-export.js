import { shanghaiDateTimeText } from "./shanghai-date.js";

// Keep each shop/order/owner together; independent unique-name lists lose that relationship.
export function inventoryDemandLines(inventory) {
  const groups = new Map();
  for (const item of inventory.items || []) {
    if (item.order?.status === "cancelled") continue;
    const quantity = Math.max(0, Number(item.final_qty ?? item.approved_qty ?? 0));
    if (!quantity) continue;
    const order = item.order || {};
    const owner = item.requested_by_name || order.created_by_name || "未记录";
    const key = JSON.stringify([order.id, order.shop_id, owner]);
    if (!groups.has(key)) groups.set(key, { shop: order.shop_name || "未记录店铺", order: order.order_no || `备货单 ID ${order.id || "未记录"}`, owner, quantity: 0 });
    groups.get(key).quantity += quantity;
  }
  return [...groups.values()];
}

export async function buildFbpSummaryWorkbook(inventories, loadImage, exportedAt = new Date()) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("库存备货汇总");
  sheet.columns = [12, 18, 42, 14, 28, 30, 20].map((width) => ({ width }));
  sheet.mergeCells("A1:G1");
  sheet.getCell("A1").value = "FBP 库存备货汇总";
  sheet.getCell("A1").font = { name: "微软雅黑", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17365D" } };
  sheet.getRow(1).height = 32;
  sheet.mergeCells("A2:G2");
  sheet.getCell("A2").value = `导出时间（北京）：${shanghaiDateTimeText(exportedAt)}  ｜  当前筛选全部库存 ${inventories.length} 种，共 ${inventories.reduce((sum, row) => sum + Number(row.final_qty || 0), 0)} 件`;
  sheet.getRow(2).height = 28;
  sheet.addRow(["主图", "货号 / 库存号", "库存名称", "备货总数（件）", "需求店铺 / 数量", "备货单号", "负责人（申请人）"]);
  sheet.getRow(3).height = 28;
  sheet.getRow(3).font = { name: "微软雅黑", size: 11, bold: true };
  sheet.getRow(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EFF7" } };
  sheet.views = [{ state: "frozen", ySplit: 3, xSplit: 2 }];
  sheet.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:3" };
  const images = new Map();
  const ids = [...new Set(inventories.map((row) => Number(row.items?.[0]?.product_id)).filter((id) => id > 0))];
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (ids.length) {
      const id = ids.shift();
      try { images.set(id, await loadImage(id)); } catch { images.set(id, null); }
    }
  }));
  let missingImages = 0;
  for (const inventory of inventories) {
    const lines = inventoryDemandLines(inventory);
    const row = sheet.addRow(["", String(inventory.inventory_id || "未编号"), inventory.product_name || "未命名库存", Number(inventory.final_qty || 0),
      lines.map((line, i) => `${i + 1}. ${line.shop}：${line.quantity} 件`).join("\n"),
      lines.map((line, i) => `${i + 1}. ${line.order}`).join("\n"),
      lines.map((line, i) => `${i + 1}. ${line.owner}`).join("\n")]);
    row.font = { name: "微软雅黑", size: 11 };
    row.height = Math.max(72, lines.length * 32, Math.ceil(String(inventory.product_name || "").length / 20) * 18);
    row.alignment = { vertical: "middle", wrapText: true };
    row.getCell(2).numFmt = "@";
    row.getCell(4).numFmt = "#,##0";
    row.getCell(4).font = { name: "微软雅黑", size: 16, bold: true, color: { argb: "FF17365D" } };
    row.getCell(4).alignment = { vertical: "middle", horizontal: "center" };
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { bottom: { style: "thin", color: { argb: "FFDCE3EB" } } };
    });
    const image = images.get(Number(inventory.items?.[0]?.product_id));
    if (image) {
      const imageId = workbook.addImage({ base64: image, extension: "png" });
      sheet.addImage(imageId, { tl: { col: 0.15, row: row.number - 1 + 0.06 }, ext: { width: 64, height: 84 }, editAs: "oneCell" });
    } else { row.getCell(1).value = "图片不可用"; missingImages++; }
  }
  sheet.autoFilter = { from: "A3", to: `G${Math.max(3, sheet.rowCount)}` };
  return { workbook, missingImages };
}
