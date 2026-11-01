import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { reimbursementTemplate, parseReimbursements, parsePayroll, payrollTemplate, submissionExport, readWorkbook } from "../src/services/finance-workbooks.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { canAccessPage } from "../src/shared/permissions.js";

export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF0cAAAAASUVORK5CYII=", "base64");
export const options = { companies: [{id: 20, name: "测试甲公司"}, {id: 21, name: "测试乙公司"}], name: "测试员工" };
export async function claimWorkbook(change = () => {}) {
  const book = await readWorkbook(await reimbursementTemplate(options));
  const sheet = book.getWorksheet("报销申请");
  sheet.getRow(2).values = [options.name, options.companies[0].name, "办公用品", "2026-10-10", "打印纸", 123.45, "", "测试备注"];
  const image = book.addImage({ buffer: png, extension: "png" });
  sheet.addImage(image, { tl: { col: 6, row: 1 }, ext: { width: 50, height: 50 } });
  await change(sheet, book);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test("official reimbursement template round trips real embedded pictures and skips prefilled empty rows", async () => {
  const rows = await parseReimbursements(await claimWorkbook((sheet, book) => {
    sheet.addImage(book.addImage({ buffer: png, extension: "png" }), { tl: { col: 6.5, row: 1.2 }, ext: {width: 30, height: 30} });
  }), options);
  assert.equal(rows.length, 1); assert.equal(rows[0].amount, 123.45);
  assert.equal(rows[0].company_id, 20); assert.equal(rows[0].images.length, 2);
  assert.equal(rows[0].images[0].base64, png.toString("base64"));
  const exported = await readWorkbook(await submissionExport([{id: 1, kind:"reimbursement", status:"approved", items:rows}]));
  assert.equal(exported.worksheets[0].getImages().length, 2);
  assert.equal(exported.worksheets[0].getCell("I2").value, 123.45);
});
test("bad identity, foreign company, missing evidence, amounts and invalid dates identify the row", async () => {
  for (const [column, value, expected] of [[1,"其他人",/第2行报销人/], [2,"外部公司",/第2行归属公司/], [3,"不支持",/第2行报销类型/], [4,"2026-02-30",/第2行费用日期/], [6,-1,/第2行报销金额/], [6,0,/第2行报销金额/], [5,"",/第2行报销事由/]]) {
    await assert.rejects(parseReimbursements(await claimWorkbook(sheet => {sheet.getCell(2,column).value=value;}),options), expected);
  }
  await assert.rejects(parseReimbursements(await claimWorkbook(sheet => { sheet.getRow(3).values=[options.name,options.companies[0].name,"物流","2026-10-11","运费",5]; }),options),/第3行缺少凭证/);
  await assert.rejects(readWorkbook(Buffer.from("not excel")), /有效的 .xlsx/);
});
test("payroll imports separate company periods and validates stored formulas without reapplying rates", async () => {
  const book = await readWorkbook(await payrollTemplate(options));
  const sheet = book.getWorksheet("工资表");
  sheet.getCell("A3").value=`公司名称：${options.companies[0].name}`; sheet.getCell("L3").value="2026年"; sheet.getCell("M3").value="10月";
  sheet.getRow(6).values = [1,"运营","员工甲",5500,1000,500,20,20,10,0,{formula:"SUM(E6:J6)",result:1550},500,100,20,0,{formula:"SUM(L6:O6)",result:620},0,{formula:"D6-P6-Q6",result:4880}];
  const rows = await parsePayroll(Buffer.from(await book.xlsx.writeBuffer()), options);
  assert.equal(rows.length,1); assert.equal(rows[0].amount,7050); assert.equal(rows[0].net,4880); assert.equal(rows[0].month,"2026-10"); assert.equal(rows[0].expense_date,"2026-10-31");
  sheet.getCell("R6").value=5000;
  await assert.rejects(parsePayroll(Buffer.from(await book.xlsx.writeBuffer()),options),/实发工资/);
  sheet.getCell("R6").value=4880;sheet.getCell("E6").value={formula:"1000"};
  await assert.rejects(parsePayroll(Buffer.from(await book.xlsx.writeBuffer()),options),/公式没有保存计算结果/);
});
test("only exact reimbursement routes open for employees, while other financial pages stay private", () => {
  const member={personId: 9, roles:["operations"], tenant:{id: 2, slug:"a",role:"member"}};
  for(const [method,action] of [["GET","template"],["GET","list"],["GET","detail"],["GET","export"],["POST","preview"],["POST","submit"]]) {
    const parts=["api","finance-submissions",action];
    assert.equal(authorizeApiRequest({method,_session:member},parts).allowed,true);
    assert.equal(tenantIsolationDecision(member,parts,method).allowed,true);
  }
  for(const parts of [["api","finance-submissions","review"],["api","finance-submissions","submit","extra"]]) {
    assert.equal(authorizeApiRequest({method:"POST",_session:member},parts).allowed,false);
    assert.equal(tenantIsolationDecision(member,parts,"POST").allowed,false);
  }
  assert.equal(canAccessPage(member,"/finance/reimbursements"),true);
  assert.equal(canAccessPage(member,"/finance-center"),false);
  assert.equal(canAccessPage(null,"/finance/reimbursements"),false);
  assert.equal(authorizeApiRequest({method:"GET",_session:{platform_role:"super_admin"}},["api","finance-submissions","list"]).allowed,false);
});
