import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { reimbursementTemplate, payrollTemplate, readWorkbook } from "../src/services/finance-workbooks.js";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF0cAAAAASUVORK5CYII=","base64");
test("reimbursement and payroll approvals are transactional, idempotent and isolated in real MySQL", {skip:!process.env.TENANT_TEST_MYSQL_SOCKET}, async t => {
  const fixture=await createTenantMysqlFixture("finance_import");
  const pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:"root",database:fixture.database,connectionLimit:4,dateStrings:true});
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const { createFinanceSubmissions } = await import("../src/services/finance-submissions.js");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const q=fixture.query;
    await q("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','默认','active'),(2,'a','甲','active'),(3,'b','乙','active')");
    await q("INSERT INTO people(id,name,role) VALUES(8,'测试员工','operations'),(9,'其他员工','packing'),(10,'负责人','operations')");
    await q("INSERT INTO finance_companies(id,tenant_id,name) VALUES(20,2,'测试甲公司'),(30,3,'测试乙公司'),(40,NULL,'默认公司')");
    await (await import("../src/services/finance-center.js")).ensureFinanceCenterSchema();
    const query=async(sql,params=[])=>(await pool.execute(sql,params))[0];
    const service=createFinanceSubmissions({query,execute:query,ensureFinance:async()=>{},transaction:async fn=>{const c=await pool.getConnection();try{await c.beginTransaction();const result=await fn(c);await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{c.release();}}});
    const member={personId:8,roles:["operations"],tenant:{id:2,slug:"a",role:"member"}};
    const other={...member,personId:9};
    const owner={...member,personId:10,tenant:{...member.tenant,role:"owner"}};
    const foreign={...owner,tenant:{id:3,slug:"b",role:"owner"}};
    const payload=async(description="打印纸",dates=["2026-10-10"])=>{
      const b=await readWorkbook(await reimbursementTemplate({companies:await service.companies(member),name:"测试员工"}));
      const s=b.getWorksheet("报销申请");
      dates.forEach((date,index)=>{s.getRow(index+2).values=["测试员工","测试甲公司","办公用品",date,description,123.45];s.addImage(b.addImage({buffer:png,extension:"png"}),{tl:{col:6,row:index+1},ext:{width:50,height:50}});});
      return {kind:"reimbursement",file_name:"申请.xlsx",base64:Buffer.from(await b.xlsx.writeBuffer()).toString("base64")};
    };
    const body=await payload();
    let id, salaryItemId;
    await t.test("preview never books expenses; employee creates pending application and cannot read others",async()=>{
      assert.equal((await service.preview(body,member)).total_amount,123.45);
      assert.equal((await q("SELECT COUNT(*) n FROM finance_expenses"))[0].n,0);
      const result=await service.submit(body,member); id=result.id;
      assert.equal(result.status,"pending");
      assert.equal((await service.list({},member)).length,1);assert.equal((await service.list({},other)).length,0);assert.equal((await service.list({},foreign)).length,0);
      await assert.rejects(service.detail(id,other),{statusCode:404}); await assert.rejects(service.detail(id,foreign),{statusCode:404});
      await assert.rejects(service.review({id,status:"approved"},member),{statusCode:403});
      await assert.rejects(service.review({id,status:"approved"},foreign),{statusCode:404});
      await assert.rejects(service.preview({...body,kind:"payroll"},member),{statusCode:403});
      const companies=await service.companies(member);assert.deepEqual(companies.map(c=>c.id),[20]);assert.deepEqual(Object.keys(companies[0]).sort(),["id","name"]);
    });
    await t.test("duplicate upload and concurrent approval cannot book the same claim twice",async()=>{
      await assert.rejects(service.submit(body,member),{statusCode:409});
      const results=await Promise.allSettled([service.review({id,status:"approved"},owner),service.review({id,status:"approved"},owner)]);
      assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
      const expenses=await q("SELECT * FROM finance_expenses");assert.equal(expenses.length,1);assert.equal(Number(expenses[0].amount_cny),123.45);assert.equal(expenses[0].tenant_id,2);assert.equal(expenses[0].source_type,"finance_submission");
      const {saveFinanceExpense,deleteFinanceExpense}=await import("../src/services/finance-center.js");
      await assert.rejects(saveFinanceExpense({id:expenses[0].id,company_id:20},10,"2"),{statusCode:409});
      await assert.rejects(deleteFinanceExpense(expenses[0].id,"2"),{statusCode:409});
      assert.equal((await service.detail(id,member)).status,"approved");
    });
    await t.test("a closed month rolls back every expense in a mixed-month application",async()=>{
      const claim=await service.submit(await payload("差旅材料",["2026-09-10","2026-11-10"]),member);
      await q("INSERT INTO finance_periods(tenant_id,company_id,month_key,status) VALUES(2,20,'2026-11','closed')");
      await assert.rejects(service.review({id:claim.id,status:"approved"},owner),/已关账/);
      assert.equal((await service.detail(claim.id,member)).status,"pending");
      assert.equal((await q("SELECT COUNT(*) n FROM finance_expenses"))[0].n,1);
      await assert.rejects(service.review({id:claim.id,status:"rejected"},owner),/退回原因/);
      await service.review({id:claim.id,status:"rejected",note:"请调整已关账月份"},owner);
      assert.equal((await service.detail(claim.id,member)).review_note,"请调整已关账月份");
    });
    await t.test("payroll company-month reservations prevent duplicate costs and are released on rejection",async()=>{
      const book=await readWorkbook(await payrollTemplate({companies:await service.companies(owner)}));
      const s=book.getWorksheet("工资表");s.getCell("L3").value="2026年";s.getCell("M3").value="10月";
      s.getRow(6).values=[1,"运营","员工甲",1000,100,0,0,0,0,0,100,50,0,0,0,50,0,950];
      const body={kind:"payroll",file_name:"工资.xlsx",base64:Buffer.from(await book.xlsx.writeBuffer()).toString("base64")};
      const first=await service.submit(body,owner);
      const anotherOwner={...owner,personId:9};
      await assert.rejects(service.submit(body,anotherOwner),{statusCode:409});
      await service.review({id:first.id,status:"rejected",note:"调整金额"},owner);
      s.getCell("D6").value=1100;s.getCell("R6").value=1050;
      const replacement=await service.submit({...body,base64:Buffer.from(await book.xlsx.writeBuffer()).toString("base64")},owner);
      await service.review({id:replacement.id,status:"approved"},owner);
      salaryItemId=(await service.detail(replacement.id,owner)).items[0].id;
      const [salary]=await q("SELECT amount_cny FROM finance_expenses WHERE category='salary'");assert.equal(Number(salary.amount_cny),1200);
    });
    await t.test("payroll ledger keeps table amounts separate from partial or complete salary payments",async()=>{
      await assert.rejects(service.payrollLedger({year:2026},member),{statusCode:403});
      await assert.rejects(service.recordPayrollPaid({item_id:salaryItemId,paid_amount:1,expected_paid_amount:0},member),{statusCode:403});
      await assert.rejects(service.recordPayrollPaid({item_id:salaryItemId,paid_amount:1,expected_paid_amount:0},foreign),{statusCode:404});
      await assert.rejects(service.payrollLedger({year:2026,company_id:30},owner),{statusCode:404});
      const initial=await service.payrollLedger({year:2026,company_id:20},owner);
      assert.equal(initial.rows[0].net,1050);assert.equal(initial.rows[0].paid_amount,0);assert.equal(initial.rows[0].remaining_amount,1050);
      const expensesBefore=await q("SELECT COUNT(*) n,SUM(amount_cny) amount FROM finance_expenses");
      await service.recordPayrollPaid({item_id:salaryItemId,paid_amount:400,expected_paid_amount:0},owner);
      let row=(await service.payrollLedger({year:2026,company_id:20},owner)).rows[0];
      assert.equal(row.remaining_amount,650);assert.equal(row.paid_amount,400);
      const edits=await Promise.allSettled([800,1050].map(paid_amount=>service.recordPayrollPaid({item_id:salaryItemId,paid_amount,expected_paid_amount:400},owner)));
      assert.equal(edits.filter(result=>result.status==='fulfilled').length,1);
      row=(await service.payrollLedger({year:2026,company_id:20},owner)).rows[0];
      await service.recordPayrollPaid({item_id:salaryItemId,paid_amount:1050,expected_paid_amount:row.paid_amount},owner);
      row=(await service.payrollLedger({year:2026,company_id:20},owner)).rows[0];assert.equal(row.remaining_amount,0);
      await service.recordPayrollPaid({item_id:salaryItemId,paid_amount:1050,expected_paid_amount:0},owner);
      assert.deepEqual(await q("SELECT COUNT(*) n,SUM(amount_cny) amount FROM finance_expenses"),expensesBefore,"payment records never deduct salary costs again");
      assert.ok((await q("SELECT COUNT(*) n FROM finance_payroll_payment_updates WHERE item_id=?",[salaryItemId]))[0].n>=2,"amount changes retain history");
    });
    await t.test("legacy default-company expenses stay compatible without crossing enterprise scope",async()=>{
      const legacy={...member,tenant:{id:1,slug:"default",role:"owner"}};
      const book=await readWorkbook(await reimbursementTemplate({companies:await service.companies(legacy),name:"测试员工"}));
      const s=book.getWorksheet("报销申请");s.getRow(2).values=["测试员工","默认公司","其他","2026-10-10","默认费用",5];s.addImage(book.addImage({buffer:png,extension:"png"}),{tl:{col:6,row:1},ext:{width:50,height:50}});
      const claim=await service.submit({kind:"reimbursement",file_name:"默认.xlsx",base64:Buffer.from(await book.xlsx.writeBuffer()).toString("base64")},legacy);
      await service.review({id:claim.id,status:"approved"},legacy);
      const [expense]=await q("SELECT tenant_id,amount_cny FROM finance_expenses WHERE company_id=40");assert.equal(expense.tenant_id,null);assert.equal(Number(expense.amount_cny),5);
      await assert.rejects(service.detail(claim.id,owner),{statusCode:404});
    });
  }finally{await pool.end();await closeMysqlPool?.();await fixture.cleanup();}
});
