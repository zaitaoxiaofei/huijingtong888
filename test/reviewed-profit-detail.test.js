import test from 'node:test';import assert from 'node:assert/strict';
import {buildOrderProfitDetailSnapshotPayload} from '../src/services/order-profit-detail-snapshots.js';
import {buildOrderProfitDetail} from '../frontend/orders/utils/order-profit-detail.js';
const item={quantity:1,sale_amount_cny:100,purchase_cost_cny:20,domestic_shipping_cny:2,international_shipping_cny:10,packaging_cost_cny:1,commission_fee_cny:-3,ozon_service_fee_cny:4,return_loss_cny:0,advertising_cost_cny:1,other_fee_cny:5,actual_profit:60,net_profit_cny:60,estimated_profit:50,settlement_state:'reviewed_provisional',profit_status:'reviewed_provisional',lock_reason:'finance_reviewed_daily_provisional'};
test('provisional collecting fee remains visible but never claims official settlement',()=>{
 const s=buildOrderProfitDetailSnapshotPayload({id:1,status:'delivered',reviewed_settlement_metadata:{quality:'estimated_acquiring',estimated_collecting:{rate:.05,amount_cny:5}}},[item],[]);
 assert.equal(s.actual_profit_cny,60);assert.equal(s.actual_profit_ready,0);assert.equal(s.summary.provisional,true);assert.equal(s.detailRows.find(r=>r.key==='commission').actual,-3);assert.equal(s.detailRows.find(r=>r.key==='collecting').label,'收单费（按5%估算）');
 const ui=buildOrderProfitDetail({},[item],[],s);assert.equal(ui.summary.actualProfitReady,false);assert.equal(ui.cards.find(c=>c.label==='财务匹配状态').value,'仍有待确认项');assert.equal(ui.cards.find(c=>c.label==='利润').lines[0].label,'测算利润（含待确认项）');
});
test('later official acquiring replaces provisional presentation without changing layout',()=>{
 const actual={...item,settlement_state:'accrued',profit_status:'accrued',other_fee_cny:2,actual_profit:63,net_profit_cny:63,lock_reason:'finance_reviewed_daily'};
 const s=buildOrderProfitDetailSnapshotPayload({id:1,status:'delivered',reviewed_settlement_metadata:{quality:'official'}},[actual],[]);
 assert.equal(s.actual_profit_ready,1);assert.equal(s.actual_profit_cny,63);assert.equal(s.detailRows.find(r=>r.key==='collecting').label,'收单费');assert.equal(s.summary.provisional,false);
});

test('product profit stage does not mark provisional refunds as official even with complete bills',async()=>{const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');const source=await readFile(new URL('../src/services/mysql-cutover.js',import.meta.url),'utf8');const code=source.match(/^function resolveProfitStageMysql\([^]*?^}/m)[0];const resolve=runInNewContext('('+code+')',{normalizeFinanceCompletenessMysql:()=>({complete:true,hasAnyFinance:true})});assert.equal(resolve({profit_status:'reviewed_provisional',settlement_state:'reviewed_provisional',is_locked:1}).actualReady,false);assert.equal(resolve({profit_status:'accrued',settlement_state:'accrued',is_locked:1}).actualReady,true);});
