import ExcelJS from "exceljs";
import { REIMBURSEMENT_TYPES } from "../shared/finance-submissions.js";

export const WORKBOOK_LIMIT = 8 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const cents = value => Math.round((value + Number.EPSILON) * 100);
export const money = value => cents(Number(value)) / 100;

function text(cell) {
  const value = cell?.value;
  if (value?.formula || value?.sharedFormula) return String(value.result ?? "").trim();
  if (value?.richText) return value.richText.map(part => part.text).join("").trim();
  return String(value ?? "").trim();
}
function number(cell, label, optional = false) {
  if ((cell?.value?.formula || cell?.value?.sharedFormula) && cell.value.result == null) fail(`${label}的公式没有保存计算结果，请在Excel/WPS中重新计算并保存`);
  const value = text(cell);
  if (!value && optional) return 0;
  if (!value || !/^\d+(\.\d{1,4})?$/.test(value) || !Number.isFinite(Number(value))) fail(`${label}应填写有效的非负数值`);
  const result = money(Number(value));
  if (result > 100000000) fail(`${label}金额过大`);
  return result;
}
function date(cell, label) {
  const value = cell?.value instanceof Date ? cell.value.toISOString().slice(0, 10) : text(cell);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(`${label}请填写有效日期，格式 YYYY-MM-DD`);
  return value;
}
function bounded(value, length, label) {
  if (!value || value.length > length) fail(`${label}不能为空，且不能超过${length}字`);
  return value;
}

// Check advertised expanded sizes before ExcelJS inflates the workbook.
function checkZip(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > WORKBOOK_LIMIT) fail("请上传不超过8MB的 .xlsx 表格");
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) fail("文件不是有效的 .xlsx，请使用下载的模板");
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16), size = 0;
  if (count > 2000) fail("表格内容过多，请拆分上传");
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) fail("表格压缩结构无效");
    size += buffer.readUInt32LE(cursor + 24);
    if (size > 60 * 1024 * 1024) fail("表格展开后过大，请压缩截图或拆分上传");
    cursor += 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
}
export async function readWorkbook(buffer) {
  checkZip(buffer);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch { fail("无法解析表格，请使用 .xlsx 模板；凭证请插入普通图片，不使用浮动图片公式"); }
  if (workbook.worksheets.length > 24) fail("表格工作表过多，请拆分上传");
  for (const sheet of workbook.worksheets) if (sheet.rowCount > 1000 || sheet.columnCount > 80) fail(`工作表“${sheet.name}”内容过多，请拆分上传`);
  return workbook;
}

export async function reimbursementTemplate({ companies, name }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("报销申请");
  sheet.columns = [
    ["报销人", 16], ["归属公司", 38], ["报销类型", 18], ["费用发生日期", 20], ["报销事由", 40], ["报销金额（元）", 20], ["凭证截图", 38], ["备注", 35]
  ].map(([header, width]) => ({ header, width }));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF244B62" } };
  const lookup = workbook.addWorksheet("选项");
  companies.forEach((company, index) => { lookup.getCell(index + 1, 1).value = company.name; });
  REIMBURSEMENT_TYPES.forEach((type, index) => { lookup.getCell(index + 1, 2).value = type; });
  lookup.state = "veryHidden";
  for (let row = 2; row <= 101; row++) {
    sheet.getRow(row).height = 85;
    sheet.getCell(row, 1).value = name || "";
    sheet.getCell(row, 2).dataValidation = { type: "list", allowBlank: true, formulae: [`'选项'!$A$1:$A$${Math.max(1, companies.length)}`] };
    sheet.getCell(row, 3).dataValidation = { type: "list", allowBlank: true, formulae: [`'选项'!$B$1:$B$${REIMBURSEMENT_TYPES.length}`] };
    sheet.getCell(row, 4).numFmt = "yyyy-mm-dd";
    sheet.getCell(row, 6).numFmt = "#,##0.00";
    sheet.getCell(row, 7).note = "使用插入图片，将普通PNG/JPEG截图左上角放在本行凭证截图单元格内；同一行可放多张图片。不支持IMAGE/DISPIMG公式。";
  }
  const guide = workbook.addWorksheet("填写说明");
  ["一行一笔费用，空白行不会提交。金额以人民币元填写。", "报销人必须与当前登录员工姓名一致；请选择当前企业的完整公司名称。", "凭证截图：插入普通PNG/JPEG图片，图片左上角必须位于对应明细行的G列；支持多张。", "请勿使用WPS单元格图片、IMAGE/DISPIMG公式或截图链接；请转换为普通插入图片。", "填写后上传，在预览中核对明细、截图及合计，再提交待审批。", "同一内容重复提交会被阻止；审批通过后计入经营账单，审批通过不代表已付款。", "上传限制8MB，每次最多100笔；请勿改动首行表头。"].forEach(line => guide.addRow([line]));
  guide.getColumn(1).width = 110;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function parseReimbursements(buffer, { companies, name }) {
  const workbook = await readWorkbook(buffer);
  const sheet = workbook.getWorksheet("报销申请");
  const headers = ["报销人", "归属公司", "报销类型", "费用发生日期", "报销事由", "报销金额（元）", "凭证截图", "备注"];
  if (!sheet || headers.some((header, index) => text(sheet.getCell(1, index + 1)) !== header)) fail("未找到完整报销申请表头，请下载企业报销模板后填写，勿改动表头");
  const images = new Map();
  for (const image of sheet.getImages()) {
    const top = image.range?.tl;
    if (!top || Math.floor(top.col) !== 6 || Math.floor(top.row) < 1) fail("凭证图片左上角必须放在对应明细行的G列");
    const row = Math.floor(top.row) + 1;
    const media = workbook.getImage(image.imageId);
    const imageBuffer = Buffer.from(media?.buffer || []);
    const png = imageBuffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = imageBuffer[0] === 255 && imageBuffer[1] === 216 && imageBuffer[2] === 255;
    if (!png && !jpeg) fail(`第${row}行凭证只支持普通PNG或JPEG截图`);
    const list = images.get(row) || [];
    list.push({ extension: png ? "png" : "jpeg", base64: imageBuffer.toString("base64") });
    if (list.length > 10) fail(`第${row}行凭证最多10张`);
    images.set(row, list);
  }
  const rows = [];
  for (let row = 2; row <= sheet.rowCount; row++) {
    const get = col => sheet.getCell(row, col);
    if (![2,3,4,5,6,7,8].some(col => text(get(col))) && !images.has(row)) continue;
    if (text(get(1)) !== name) fail(`第${row}行报销人必须是当前登录员工“${name}”`);
    const company = companies.find(item => item.name === text(get(2)));
    if (!company) fail(`第${row}行归属公司不属于当前企业，请从模板下拉选项选择`);
    const category = text(get(3));
    if (!REIMBURSEMENT_TYPES.includes(category)) fail(`第${row}行报销类型无效，请使用模板下拉选项`);
    const amount = number(get(6), `第${row}行报销金额`);
    if (amount <= 0) fail(`第${row}行报销金额必须大于0`);
    if (!images.get(row)?.length) fail(`第${row}行缺少凭证截图，请在G列插入普通图片`);
    rows.push({ source_row: row, company_id: Number(company.id), company_name: company.name, person_name: name, category,
      expense_date: date(get(4), `第${row}行费用日期`), description: bounded(text(get(5)), 500, `第${row}行报销事由`), amount,
      note: text(get(8)).slice(0, 500), images: images.get(row) });
  }
  if (!rows.length || rows.length > 100) fail("请填写1至100笔报销明细");
  return rows;
}

export async function payrollTemplate({ companies, month = "" }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("工资表");
  sheet.mergeCells("A1:S1"); sheet.getCell("A1").value = "员工工资表";
  sheet.getCell("A3").value = `公司名称：${companies[0]?.name || '请填写完整公司名称'}`;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  const selected = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : today.slice(0,7);
  sheet.getCell("L3").value = `${selected.slice(0,4)}年`; sheet.getCell("M3").value = `${Number(selected.slice(5,7))}月`;
  const headers = ["序号", "部门", "姓名", "基本工资", "单位应缴费用", "", "", "", "", "", "", "个人应缴费用", "", "", "", "", "当月应缴纳个税", "实发工资", "确认签字"];
  sheet.getRow(4).values = headers;
  sheet.getRow(5).values = ["", "", "", "", "养老保险", "医疗保险", "附加医疗保险", "失业保险", "工伤保险", "公积金", "小计", "养老保险", "医疗保险", "失业保险", "公积金", "小计"];
  for (let row=6; row<=25; row++) {
    sheet.getCell(row,1).value = row-5;
    sheet.getCell(row,11).value = { formula: `SUM(E${row}:J${row})` };
    sheet.getCell(row,16).value = { formula: `SUM(L${row}:O${row})` };
    sheet.getCell(row,18).value = { formula: `D${row}-P${row}-Q${row}` };
  }
  sheet.columns.forEach(col => { col.width = 16; });
  sheet.getColumn(1).width = 9; sheet.getColumn(3).width = 18;
  sheet.getRow(4).font = { bold: true }; sheet.views = [{ state: "frozen", ySplit: 5 }];
  const guide = workbook.addWorksheet("填写说明");
  ["修改A3公司全称、L3年份、M3月份；一张工作表对应一个公司月份，可复制工作表填写其他公司或月份。", "按实际工资表填写金额，不预设社保比例；基本工资减个人缴费、个税等于实发工资。", "单位缴费和个人缴费小计、实发工资已有公式，请用Excel或WPS重新计算并保存后上传。", "员工姓名不能为空；同公司同月份员工姓名不可重复。导入后核对并审批才计入人工成本。", ...companies.map(company => `可用公司：${company.name}`)].forEach(line => guide.addRow([line]));
  guide.getColumn(1).width = 110;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function parsePayroll(buffer, { companies }) {
  const workbook = await readWorkbook(buffer);
  const rows = [];
  for (const sheet of workbook.worksheets) {
    let header = 0;
    for (let row = 1; row <= Math.min(15, sheet.rowCount); row++) if (text(sheet.getCell(row, 3)) === "姓名" && text(sheet.getCell(row, 4)) === "基本工资") { header = row; break; }
    if (!header) continue;
    const cells = [];
    for (let r = 1; r < header; r++) for (let c = 1; c <= 19; c++) cells.push(text(sheet.getCell(r, c)));
    const company = companies.find(item => cells.some(value => value === `公司名称：${item.name}` || value === `${item.name}工资表`));
    if (!company) fail(`“${sheet.name}”的公司抬头不属于当前企业，请先在公司设置中核对`);
    const year = cells.find(value => /^20\d{2}年$/.test(value));
    const month = cells.find(value => /^(?:[1-9]|1[0-2])月$/.test(value));
    if (!year || !month) fail(`“${sheet.name}”缺少工资年份或月份`);
    const monthKey = `${year.slice(0, 4)}-${month.slice(0, -1).padStart(2, "0")}`;
    const expenseDate = new Date(Date.UTC(Number(year.slice(0, 4)), Number(month.slice(0, -1)), 0)).toISOString().slice(0, 10);
    for (let row = header + 2; row <= sheet.rowCount; row++) {
      const get = col => sheet.getCell(row, col);
      if (!/^\d+$/.test(text(get(1))) || !text(get(3))) continue;
      const base = number(get(4), `“${sheet.name}”第${row}行基本工资`);
      const employer = money([5,6,7,8,9,10].reduce((sum, col) => sum + number(get(col), `第${row}行单位缴费`, true), 0));
      const employee = money([12,13,14,15].reduce((sum, col) => sum + number(get(col), `第${row}行个人缴费`, true), 0));
      const tax = number(get(17), `第${row}行个税`, true);
      const net = number(get(18), `第${row}行实发工资`);
      const employer_items = Object.fromEntries(["pension", "medical", "supplementary_medical", "unemployment", "injury", "housing_fund"].map((key, index) => [key, number(get(index + 5), `第${row}行单位缴费`, true)]));
      const employee_items = Object.fromEntries(["pension", "medical", "unemployment", "housing_fund"].map((key, index) => [key, number(get(index + 12), `第${row}行个人缴费`, true)]));
      if (Math.abs(cents(base) - cents(employee) - cents(tax) - cents(net)) > 1) fail(`“${sheet.name}”第${row}行实发工资与基本工资、个人缴费、个税不符，请核对表格`);
      if (Math.abs(cents(number(get(11), "单位缴费小计")) - cents(employer)) > 1 || Math.abs(cents(number(get(16), "个人缴费小计")) - cents(employee)) > 1) fail(`“${sheet.name}”第${row}行缴费小计不符，请先在Excel中重新计算并保存`);
      rows.push({ source_row: row, sheet: sheet.name, company_id: Number(company.id), company_name: company.name, month: monthKey,
        person_name: bounded(text(get(3)), 128, "员工姓名"), department: text(get(2)), category: "salary", expense_date: expenseDate,
        description: `${monthKey}工资 · ${text(get(3))}`, base, employer, employee, tax, net, employer_items, employee_items, confirmation: text(get(19)), amount: money(base + employer), images: [] });
    }
  }
  if (!rows.length || rows.length > 500) fail("未识别到工资明细，或超过500行；请使用现有19列工资表格式");
  const keys = rows.map(row => `${row.company_id}/${row.month}/${row.person_name}`);
  if (new Set(keys).size !== keys.length) fail("工资表存在同公司、同月份的重复员工姓名，请核对后上传");
  return rows;
}

export async function submissionExport(batches) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("报销与工资明细");
  sheet.columns = ["申请编号", "类型", "状态", "报销人或员工", "公司", "费用日期", "类别", "事由", "金额（元）", "审批意见", "基本工资", "单位缴费", "个人缴费", "个税", "实发工资", "凭证截图"].map(header => ({ header, width: header === "公司" || header === "事由" ? 35 : 20 }));
  for (const batch of batches) for (const item of batch.items) {
    const row = sheet.addRow([batch.id, batch.kind === "payroll" ? "工资" : "报销", ({ pending: "待审批", approved: "已通过", rejected: "已退回" })[batch.status], item.person_name, item.company_name, item.expense_date, item.category, item.description, item.amount, batch.review_note || "", item.base ?? null, item.employer ?? null, item.employee ?? null, item.tax ?? null, item.net ?? null]);
    row.height = 85;
    for (const [index, image] of (item.images || []).entries()) {
      const id = workbook.addImage({ buffer: Buffer.from(image.base64, "base64"), extension: image.extension });
      sheet.addImage(id, { tl: { col: 15 + index, row: row.number - 1 }, ext: { width: 120, height: 100 } });
    }
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn(9).numFmt = "#,##0.00";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function payrollLedgerExport(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("工资明细");
  const headers = ["公司", "工资月份", "序号", "部门", "姓名", "基本工资", "单位养老", "单位医疗", "单位附加医疗", "单位失业", "单位工伤", "单位公积金", "单位小计", "个人养老", "个人医疗", "个人失业", "个人公积金", "个人小计", "个税", "实发工资（表内）", "确认签字", "已发金额", "未发差额"];
  sheet.columns = headers.map(header => ({ header, width: header === "公司" ? 36 : 18 }));
  rows.forEach((row, index) => sheet.addRow([row.company_name, row.month, index + 1, row.department, row.person_name, row.base,
    ...["pension", "medical", "supplementary_medical", "unemployment", "injury", "housing_fund"].map(key => row.employer_items?.[key] ?? null), row.employer,
    ...["pension", "medical", "unemployment", "housing_fund"].map(key => row.employee_items?.[key] ?? null), row.employee, row.tax, row.net, row.confirmation || "", row.paid_amount, row.remaining_amount]));
  sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 5 }];
  for (const column of [...Array.from({ length: 15 }, (_, index) => index + 6), 22, 23]) sheet.getColumn(column).numFmt = "#,##0.00";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
