import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { buildOrderOutcomeSql } from '../src/services/order-outcome.js';
import { reviewedAftersaleReasons } from '../src/services/reviewed-aftersale-reasons.js';
import { orderReportOutcomeCtesSql } from '../src/services/order-report-outcome-sql.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema, loadTenantOrderService, orderFunctionSource } from './helpers/tenant-order-service.js';

const methods = ['profitRankingMysql','profitOrderedAtUtcRangeMysql','profitTimestampUtcRangeMysql','terminalOrderLossSqlMysql','returnLossTotalSqlMysql','roundMoneyMysql',
  'monthlyBillingPendingByShopMysql','monthlyFinanceTenantPredicateMysql','billingCompanyOrderPredicateMysql','billingCompanyIdMysql','monthlyBillingExpensesMysql',
  'annualBillingExpensesMysql','annualBillingOverviewMysql','monthlyBillingDetailsMysql','emptyMonthlyBillingSummaryMysql','sumMonthlyBillingRowsMysql',
  'enrichMonthlyBillingShopRowMysql','monthRangeMysql','billingDateRangeMysql'];
const json = value => JSON.parse(JSON.stringify(value));
const normalized = value => value.replaceAll('\r\n','\n');
const sha256 = value => createHash('sha256').update(normalized(value)).digest('hex');
const baselineHashes = {
  profitRankingMysql:'81dff47157000b420457a385559179f5eafa048a346ea9f262d12a61b84dd162',
  monthlyBillingPendingByShopMysql:'282f7e09887b7b07c65e438249c217efbe495f8fca62399377df4ba45e2844d9'
};
function replaceExactly(source, before, after, count = 1) {
  assert.equal(source.split(before).length - 1, count, 'Reviewed replacement must match the intended source exactly');
  return source.replaceAll(before, after);
}
function originalRanking() {
  const oldCte = [
    '  const outcomeCteSql = inventoryMode ? "" : `',
    '    WITH order_outcomes AS (',
    '      SELECT',
    '        o.id,',
    '        CASE WHEN ${effectiveBusinessSale} THEN 1 ELSE 0 END AS effective_business_sale,',
    '        CASE WHEN ${outcome.rejectedUnclaimed} THEN 1 ELSE 0 END AS rejected_unclaimed,',
    '        CASE WHEN ${outcome.afterDeliveryReturn} THEN 1 ELSE 0 END AS after_delivery_return',
    '      FROM orders o',
    '      WHERE ${orderScope} ${dateFilter.whereSql}',
    '      GROUP BY o.id',
    '    )',
    '  `;'
  ].join('\n');
  const source = replaceExactly(normalized(orderFunctionSource('profitRankingMysql')),
    '  const outcomeCteSql = inventoryMode ? "" : orderReportOutcomeCtesSql(orderScope, dateFilter.whereSql);', oldCte);
  assert.equal(sha256(source), baselineHashes.profitRankingMysql, 'Restored ranking must be byte-identical to commit 45b9854 (LF)');
  return source;
}
function originalPending() {
  let source = normalized(orderFunctionSource('monthlyBillingPendingByShopMysql'));
  source = replaceExactly(source, '  const outcomeCteSql = orderReportOutcomeCtesSql(where.join(" AND "), dateFilter.whereSql);',
    '  const outcome = buildOrderOutcomeSql("o", "mysql");\n  const effectiveBusinessSale = `(${outcome.effectiveSale} AND NOT ${outcome.afterDeliveryReturn})`;');
  source = replaceExactly(source, '  const rows = await mysqlQuery(`\n    ${outcomeCteSql}\n', '  const rows = await mysqlQuery(`\n');
  source = replaceExactly(source, 'outcomes.effective_business_sale = 1', '${effectiveBusinessSale}', 2);
  source = replaceExactly(source, '    JOIN order_outcomes outcomes ON outcomes.id = o.id\n', '');
  source = replaceExactly(source, '  `, [...params, ...params]);', '  `, params);');
  assert.equal(sha256(source), baselineHashes.monthlyBillingPendingByShopMysql, 'Restored pending must be byte-identical to commit 45b9854 (LF)');
  return source;
}

test('mobile finance materialized outcomes preserve the complete 45b report and billing contracts', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 240000
}, async t => {
  const fixture = await createTenantMysqlFixture('mobile_finance_perf');
  const q = fixture.query;
  try {
    await createOrderFixtureSchema(fixture.connection);
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(11,1,'Default explicit'),(20,2,'A'),(21,2,'A alternate company'),(22,2,'A expenses only'),(30,3,'B private')");
    await q("INSERT INTO finance_companies(id,tenant_id,name) VALUES(1,NULL,'Legacy'),(2,2,'A company'),(3,3,'B private'),(4,1,'Default explicit'),(5,2,'A second company')");
    for (const [tenant,shop,company] of [[null,10,1],[1,11,4],[2,20,2],[2,21,5],[2,22,2],[3,30,3]]) {
      await q('INSERT INTO finance_shop_company_assignments(tenant_id,shop_id,company_id,effective_from) VALUES(?,?,?,?)',[tenant,shop,company,'2020-01-01']);
      await q('INSERT INTO finance_expenses(tenant_id,company_id,shop_id,expense_date,category,amount_cny) VALUES(?,?,?,?,?,?)',[tenant,company,shop,'2026-10-03','salary',shop+0.25]);
    }
    await q("INSERT INTO finance_expenses(tenant_id,company_id,shop_id,expense_date,category,amount_cny) VALUES(2,2,NULL,'2026-09-01','office',7.17),(2,2,NULL,'2026-10-03','office',8.25),(2,2,NULL,'2026-11-02','salary',9.25),(0,1,NULL,'2026-10-03','office',3.25),(2,3,NULL,'2026-10-03','office',9999),(2,2,30,'2026-10-03','office',9999)");
    const states = [
      {status:'awaiting_packaging',cancel_reason:null}, {status:'',cancel_reason:''},
      {status:'delivered',tracking_stage:'delivered'}, {status:'delivering',delivered_at:'2026-10-04 08:00:00'},
      {status:'awaiting_packaging',accrued_at:'2026-10-04 08:00:00'},
      {status:'cancelled',cancel_reason:'buyer'}, {status:'cancelled',cancelled_after_ship:1},
      {status:'cancelled',tracking_stage:'not_accepted',cancel_reason:'rejected'},
      {status:'returned',tracking_stage:'delivered',delivered_at:'2026-10-04 08:00:00'},
      {status:'cancelled',tracking_stage:'delivered',cancel_reason:'return damaged'},
      {status:'dispute',cancel_reason:null}, {status:'cancelled',cancel_reason:'',cancel_type:'buyer'},
      {status:'awaiting_packaging',logistics_status:'returned'},
      ...reviewedAftersaleReasons.flatMap(reason => [
        {status:'cancelled',tracking_stage:'delivering',cancel_reason_id:reason.codes[0],cancel_reason:null},
        {status:'returned',tracking_stage:'delivered',delivered_at:'2026-10-04 08:00:00',cancel_reason:reason.original},
        {status:'delivered',tracking_stage:'delivered',cancel_reason:reason.original},
        {status:'cancelled',cancel_reason:'',cancel_type:reason.original}
      ])
    ];
    const dates=['2026-08-31 15:59:59','2026-08-31 16:00:00','2026-09-30 15:59:59','2026-09-30 16:00:00','2026-10-31 16:00:00','2026-11-06 15:59:59','2026-11-06 16:00:00'];
    let id=100;
    for(const shop of [10,11,20,21,30])for(let index=0;index<states.length;index++){
      const state=states[index],order=++id,fields={shop_id:shop,posting_number:`fixture-${order}`,ordered_at:dates[index%dates.length],...state};
      const columns=Object.keys(fields);await q(`INSERT INTO orders(id,${columns.join(',')}) VALUES(?,${columns.map(()=>'?').join(',')})`,[order,...Object.values(fields)]);
      for(let itemIndex=0;itemIndex<(index%3===0?2:1);itemIndex++){
        const item=order*10+itemIndex,quantity=index%17===0?0:itemIndex+1;
        await q('INSERT INTO order_items(id,order_id,ozon_sku,ozon_name,quantity,sale_price,estimated_profit,actual_profit,aftersale_loss,settlement_state,frozen_purchase_cost,frozen_domestic_shipping,frozen_international_shipping,frozen_handling_fee,estimated_commission,platform_fee_actual) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [item,order,'shared-sku','Fixture '+shop,quantity,31.17+index,8.09+index,index%2?0:2.35,index%3?1.11:0,index%4?'pending':'accrued',3.14,0.2,2.2,0.1,0.3,0.4]);
        if(index%2)await q('INSERT INTO order_profit_items(order_item_id,sale_amount_cny,net_profit_cny,profit_status,purchase_cost_cny,domestic_shipping_cny,international_shipping_cny,packaging_cost_cny,commission_fee_cny,ozon_service_fee_cny,return_loss_cny,advertising_cost_cny,other_fee_cny) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [item,21.19+index,-2.13+index,index%3?'pending':'accrued',3.13,1.01,2.02,0.1,1.2,0.4,0.9,0.33,0.17]);
      }
      for(const day of ['2026-08-31','2026-09-01','2026-10-01','2026-11-01'])if(index===0)await q('INSERT INTO ozon_ad_sku_daily(date_key,shop_id,ozon_sku,spend_cny,revenue_cny) VALUES(?,?,\'shared-sku\',?,?)',[day,shop,3.17+shop,22.19]);
    }
    const appendixCalls={procurement:0,ai:0};
    const overrides={extraMethods:methods,buildOrderOutcomeSql,orderReportOutcomeCtesSql,todayDateKeyMysql:()=> '2026-11-06',ensureFinanceCenterSchema:async()=>{},
      shopsMysql:async tenant=>(await q(`SELECT id,name FROM shops WHERE ${tenant==='admin'?'tenant_id IS NULL OR tenant_id=1':'tenant_id=?'} ORDER BY id`,tenant==='admin'?[]:[Number(tenant)])),
      monthlyProcurementInventorySummaryMysql:async(from,to,scope)=>{appendixCalls.procurement++;return {period_basis:'purchased_at',snapshot_basis:'current',purchase_total_amount:scope.id,inventory_total_value:scope.id*3};},
      billingAiUsageMysql:async()=>{appendixCalls.ai++;return {request_count:0,cost:0};},monthlyBillingOrderRowsMysql:async()=>[]};
    const {service:after,calls}=loadTenantOrderService(fixture.connection,overrides);
    const {service:before}=loadTenantOrderService(fixture.connection,overrides);
    vm.runInContext(originalRanking()+'\n'+originalPending(),before);
    await t.test('materialized flags exactly match every original predicate across reviewed reasons and null/empty histories',async()=>{
      const outcome=buildOrderOutcomeSql('o','mysql');
      const old=await q(`SELECT o.id,CASE WHEN (${outcome.effectiveSale} AND NOT ${outcome.afterDeliveryReturn}) THEN 1 ELSE 0 END effective_business_sale,CASE WHEN ${outcome.rejectedUnclaimed} THEN 1 ELSE 0 END rejected_unclaimed,CASE WHEN ${outcome.afterDeliveryReturn} THEN 1 ELSE 0 END after_delivery_return FROM orders o ORDER BY o.id`);
      const current=await q(`${orderReportOutcomeCtesSql('1=1')} SELECT * FROM order_outcomes ORDER BY id`);
      assert.deepEqual(json(current),json(old));assert.ok(old.some(row=>Number(row.effective_business_sale)===0));assert.ok(old.some(row=>Number(row.effective_business_sale)===1));assert.ok(old.some(row=>Number(row.rejected_unclaimed)===1));assert.ok(old.some(row=>Number(row.after_delivery_return)===1));
    });
    await t.test('ranking and pending maps preserve each field, sort, paging, company/shop and Beijing interval',async()=>{
      const ranges=[{}, {from:'2026-09-01',to:'2026-09-30'}, {from:'2026-10-01',to:'2026-10-31'}, {from:'2026-11-01',to:'2026-11-06'}];
      for(const tenant of ['admin','2','3'])for(const query of ranges)for(const options of [{},{groupByMonth:true}]){
        const input={dimension:'shop',fast:'1',...query};
        assert.deepEqual(json(await after.profitRankingMysql(input,tenant,options)),json(await before.profitRankingMysql(input,tenant,options)),JSON.stringify({tenant,input,options}));
        const scope=await after.orderListTenantScopeMysql(tenant);
        assert.deepEqual(json([...await after.monthlyBillingPendingByShopMysql(query.from,query.to,'all',scope)]),json([...await before.monthlyBillingPendingByShopMysql(query.from,query.to,'all',scope)]));
      }
      for(const query of [{dimension:'shop',page:2,pageSize:1},{dimension:'shop',shopId:30},{dimension:'shop',keyword:'A',sortBy:'revenue',sortOrder:'asc'}, {dimension:'product'},{dimension:'sku',fast:'1'}])assert.deepEqual(json(await after.profitRankingMysql(query,'2')),json(await before.profitRankingMysql(query,'2')));
    });
    await t.test('complete annual/monthly billing DTOs retain expenses-only months and scope ownership',async()=>{
      for(const tenant of ['admin','2','3'])for(const query of [
        {year:2026,fromMonth:8,toMonth:11,month:10,overviewOnly:'1'},
        {year:2026,fromMonth:10,toMonth:10,month:10},
        {from:'2026-09-01',to:'2026-09-30'},{from:'2026-11-01',to:'2026-11-06'},
        {from:'2026-10-01',to:'2026-10-31',shopId:22},{from:'2026-10-01',to:'2026-10-31',shopId:30}
      ])assert.deepEqual(json(await after.monthlyBillingDetailsMysql(query,tenant)),json(await before.monthlyBillingDetailsMysql(query,tenant)),JSON.stringify({tenant,query}));
      for(const query of [{year:2026,fromMonth:8,toMonth:11,overviewOnly:'1',companyId:2},{from:'2026-10-01',to:'2026-10-31',companyId:2},{from:'2026-10-01',to:'2026-10-31',companyId:5,shopId:21}])assert.deepEqual(json(await after.monthlyBillingDetailsMysql(query,'2')),json(await before.monthlyBillingDetailsMysql(query,'2')));
      const empty=(await after.monthlyBillingDetailsMysql({from:'2026-10-01',to:'2026-10-31',shopId:22},'2')).selected;
      assert.equal(empty.summary.order_count,0);assert.equal(empty.summary.salary_expense,22.25);assert.equal(empty.summary.net_profit,-22.25);
      await assert.rejects(after.monthlyBillingDetailsMysql({year:2026,overviewOnly:'1',companyId:3},'2'),{statusCode:404});
      assert.ok(!JSON.stringify(await after.monthlyBillingDetailsMysql({year:2026,fromMonth:8,toMonth:11,overviewOnly:'1'},'2')).includes('B private'));
    });
    await t.test('optional lean bills preserve every core financial field without reading appendices or bypassing company/tenant guards',async()=>{
      const withoutAppendices=value=>Array.isArray(value)?value.map(withoutAppendices):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['procurement_inventory','ai_usage'].includes(key)).map(([key,child])=>[key,withoutAppendices(child)])):value;
      for(const query of [{from:'2026-10-01',to:'2026-10-31'},{year:2026,fromMonth:9,toMonth:11,month:10},{from:'2026-10-01',to:'2026-10-31',companyId:2,shopId:20}]){
        appendixCalls.procurement=0;appendixCalls.ai=0;
        const full=await after.monthlyBillingDetailsMysql(query,'2');
        assert.ok(appendixCalls.procurement>0&&appendixCalls.ai>0,'Default contract retains full appendices');
        appendixCalls.procurement=0;appendixCalls.ai=0;
        const lean=await after.monthlyBillingDetailsMysql({...query,includeAppendices:'0',tenant_id:3},'2');
        assert.deepEqual(withoutAppendices(json(lean)),withoutAppendices(json(full)));
        assert.deepEqual(appendixCalls,{procurement:0,ai:0});
        for(const month of lean.months){assert.deepEqual(json(month.procurement_inventory),{});assert.deepEqual(json(month.ai_usage),{});}
        assert.ok(!JSON.stringify(lean).includes('B private'));
      }
      for(const [companyId,statusCode]of [[3,404],['not-an-id',400]]){
        appendixCalls.procurement=0;appendixCalls.ai=0;
        await assert.rejects(after.monthlyBillingDetailsMysql({from:'2026-10-01',to:'2026-10-31',companyId,includeAppendices:'0'},'2'),{statusCode});
        assert.deepEqual(appendixCalls,{procurement:0,ai:0});
      }
      const foreign=await after.monthlyBillingDetailsMysql({from:'2026-10-01',to:'2026-10-31',shopId:30,includeAppendices:'0'},'2');
      assert.equal(foreign.selected.summary.order_count,0);assert.equal(foreign.selected.summary.salary_expense,0);assert.deepEqual(json(foreign.selected.expenses),[]);
    });
    await t.test('31k synthetic orders retain complete yearly/monthly payloads while reporting observed timings',async()=>{
      for(let offset=0;offset<31000;offset+=1000){
        const rows=Array.from({length:1000},(_,index)=>{const value=100000+offset+index;return [value,20,`scale-${value}`,index%4===0?'cancelled':index%4===1?'returned':'delivered',index%4===1?'delivered':'',index%4===0?'buyer':null,`2026-${String(1+value%11).padStart(2,'0')}-03 08:00:00`];});
        await fixture.connection.query('INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,cancel_reason,ordered_at) VALUES ?',[rows]);
        await fixture.connection.query('INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES ?',[rows.map(row=>[row[0]*10,row[0],'scale-sku',1,31.17,8.09])]);
      }
      for(const [label,query,options] of [['annual',{dimension:'shop',from:'2026-01-01',to:'2026-11-06',fast:'1'},{groupByMonth:true}],['month',{dimension:'shop',from:'2026-10-01',to:'2026-10-31',fast:'1'},{}]]){
        let start=performance.now();const old=await before.profitRankingMysql(query,'2',options);const oldMs=performance.now()-start;
        start=performance.now();const current=await after.profitRankingMysql(query,'2',options);const currentMs=performance.now()-start;
        assert.deepEqual(json(current),json(old));t.diagnostic(`synthetic ${label}: orders=31000 baseline_ms=${oldMs.toFixed(1)} candidate_ms=${currentMs.toFixed(1)} complete_DTO_equal=true`);
      }
      const scope=await after.orderListTenantScopeMysql('2');let start=performance.now();const old=await before.monthlyBillingPendingByShopMysql('2026-10-01','2026-10-31','all',scope),oldMs=performance.now()-start;
      start=performance.now();const current=await after.monthlyBillingPendingByShopMysql('2026-10-01','2026-10-31','all',scope),currentMs=performance.now()-start;
      assert.deepEqual(json([...current]),json([...old]));t.diagnostic(`synthetic pending: baseline_ms=${oldMs.toFixed(1)} candidate_ms=${currentMs.toFixed(1)} complete_Map_equal=true`);
      assert.ok(calls.some(call=>call.sql.includes('report_order_text')));
    });
  } finally { await fixture.cleanup(); }
});
