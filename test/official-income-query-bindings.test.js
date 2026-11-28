import {test} from 'node:test';
import assert from 'node:assert/strict';
// All reads below are injected; these placeholders only satisfy config loading.
process.env.DB_HOST??='127.0.0.1';process.env.DB_NAME??='unit_readonly';process.env.DB_USER??='unit_readonly';
const {officialIncomeProjectionMysql}=await import('../src/services/mysql-cutover.js');

test('single-shop Q3 projection binds the shop between CTE and outer date ranges',async()=>{
 let captured;
 const reader=async(sql,args)=>{if(sql.includes('saved_commission')&&sql.includes('order_outcomes outcomes'))captured={sql,args};return [];};
 await officialIncomeProjectionMysql({from:'2026-07-01',to:'2026-07-31',shopId:4,companyId:1,tenantId:1,defaultTenant:true},reader);
 assert(captured);assert.deepEqual(captured.args,['2026-06-30 16:00:00','2026-07-31 16:00:00',4,'2026-06-30 16:00:00','2026-07-31 16:00:00']);
 assert.match(captured.sql,/o.shop_id=\?.*o.ordered_at >= \?/s);
});
test('selected-order preview uses the same bounded query and rejects cross-company scope',async()=>{
 const calls=[];await officialIncomeProjectionMysql({from:'2026-07-01',to:'2026-07-31',shopId:4,companyId:1,tenantId:1,defaultTenant:true,orderIds:[17,18]},async(sql,args)=>{calls.push({sql,args});return [];});
 const main=calls.find(c=>c.sql.includes('saved_commission'));assert.match(main.sql,/o.id IN \(17,18\)/);assert.equal(main.args[2],4);
 let accessed=false;await assert.rejects(officialIncomeProjectionMysql({shopId:4,companyId:2,tenantId:1},async()=>{accessed=true;}),/范围无效/);assert.equal(accessed,false);
});
