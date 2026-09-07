function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDate(value);
  if (typeof value === "object") {
    if (value.text) return String(value.text);
    if (value.result !== undefined) return cellText(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || "").join("");
  }
  return String(value).trim();
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted && char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => String(value).trim())) rows.push(row);
  return rows;
}

function objectRows(rows, headerIndex) {
  const headers = rows[headerIndex].map((value) => cellText(value));
  return rows.slice(headerIndex + 1).map((values) => Object.fromEntries(headers.map((header, index) => [header, cellText(values[index])]))).filter((row) => Object.values(row).some(Boolean));
}

async function workbookRows(file) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  return sheet.getSheetValues().slice(1).map((values) => (values || []).slice(1));
}

export async function parse1688File(file) {
  const rows = await workbookRows(file);
  const headerIndex = rows.findIndex((row) => row.some((value) => cellText(value) === "订单编号"));
  if (headerIndex < 0) throw new Error("未找到1688订单表头“订单编号”");
  const rawRows = objectRows(rows, headerIndex);
  const groups = new Map();
  let currentOrder = null;
  for (const row of rawRows) {
    const orderNo = row["订单编号"] || currentOrder;
    if (!orderNo) continue;
    currentOrder = orderNo;
    const group = groups.get(orderNo) || { ...row, "订单编号": orderNo, names: [], specs: [], quantityTotal: 0, offerIds: [], skuIds: [] };
    if (row["货品标题"] || row["商品名称"]) group.names.push(row["货品标题"] || row["商品名称"]);
    if (row["型号"] || row["规格"]) group.specs.push(row["型号"] || row["规格"]);
    group.quantityTotal += Number(row["数量"] || 0);
    if (row["Offer ID"]) group.offerIds.push(row["Offer ID"]);
    if (row["SKU ID"]) group.skuIds.push(row["SKU ID"]);
    groups.set(orderNo, group);
  }
  return [...groups.values()].map((group) => ({
    "订单编号": group["订单编号"], "订单创建时间": group["订单创建时间"], "卖家公司名": group["卖家公司名"],
    "订单状态": group["订单状态"], "商品名称": [...new Set(group.names)].join("；"), "规格": [...new Set(group.specs)].join("；"),
    "商品总数量": group.quantityTotal || 1, "实付款(元)": group["实付款(元)"], "Offer ID": [...new Set(group.offerIds)].join("；"), "SKU ID": [...new Set(group.skuIds)].join("；"),
    "采购链接": group.offerIds[0] ? `https://detail.1688.com/offer/${group.offerIds[0]}.html` : ""
  }));
}

export async function parseWechatFile(file) {
  const rows = await workbookRows(file);
  const headerIndex = rows.findIndex((row) => row.some((value) => cellText(value) === "交易时间"));
  if (headerIndex < 0) throw new Error("未找到微信账单明细表头“交易时间”");
  return objectRows(rows, headerIndex);
}

export async function parseAlipayFile(file) {
  const buffer = await file.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buffer);
  if (!text.includes("交易时间")) text = new TextDecoder("gb18030").decode(buffer);
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((row) => row.some((value) => String(value).trim() === "交易时间"));
  if (headerIndex < 0) throw new Error("未找到支付宝账单明细表头“交易时间”");
  return objectRows(rows, headerIndex);
}

export async function parsePddFile(file) {
  if (file.name.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(await file.text());
    return Array.isArray(parsed) ? parsed : parsed.rows || [];
  }
  return objectRows(parseCsv(await file.text()), 0);
}
