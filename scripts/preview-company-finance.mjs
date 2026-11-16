// Isolated acceptance harness. Never loads application database credentials.
// Requires a networking-disabled MySQL fixture socket and an explicit local manifest.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createTenantMysqlFixture } from '../test/helpers/tenant-mysql-fixture.js';
import { createCompanyFinanceDocuments } from '../src/services/company-finance-documents.js';
import { FINANCE_SUBMISSIONS_SCHEMA } from '../src/services/finance-submissions-schema.js';

const manifest=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const overviewSnapshot=manifest.overview_snapshot?JSON.parse(await fs.readFile(manifest.overview_snapshot,'utf8')):null;
const fixture=await createTenantMysqlFixture('finance_preview');
// Match the application's UTC mysql2 decoder; the fixture's SQL session already uses UTC.
fixture.connection.connection.config.timezone='Z';
const q=fixture.query,privateFiles=new Map(),token=crypto.randomUUID();
for(const ddl of FINANCE_SUBMISSIONS_SCHEMA)await q(ddl);
const session={id:10,personId:10,name:'本地验收',roles:['operations'],tenant:{id:2,slug:'finance-preview',role:'owner',access_allowed:true}};
await q("INSERT INTO tenants(id,slug,name,status) VALUES(2,'finance-preview','Finance Preview','active')");
await q("INSERT INTO finance_companies(id,tenant_id,name) VALUES(20,2,'合肥公司（本地验收）')");
for(const [id,name]of [[200,'RuVibe Mart Z'],[201,'VeloAuto'],[202,'CARVEO']]){
 await q('INSERT INTO shops(id,tenant_id,name) VALUES(?,2,?)',[id,name]);
 await q("INSERT INTO finance_shop_company_assignments(tenant_id,company_id,shop_id,effective_from) VALUES(2,20,?,'2026-01-01')",[id]);
}
if(manifest.legal_company_name)await q('UPDATE finance_companies SET name=? WHERE id=20',[manifest.legal_company_name]);
if(manifest.company_tax_number)await q('UPDATE finance_companies SET tax_number=? WHERE id=20',[manifest.company_tax_number]);
if(manifest.order_snapshot){
 const snapshot=JSON.parse(await fs.readFile(manifest.order_snapshot,'utf8'));const orderMap=new Map();
 for(const item of snapshot.items)if(!orderMap.has(item.order_id))orderMap.set(item.order_id,item);
 for(const o of orderMap.values())await q('INSERT INTO orders(id,shop_id,posting_number,ordered_at,status,tracking_stage,logistics_status) VALUES(?,200,?,?,?,?,?)',[o.order_id,o.posting_number,new Date(o.ordered_at),o.status,o.tracking_stage||'',o.logistics_status||'']);
 for(const i of snapshot.items){await q('INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,settlement_state,estimated_commission,frozen_purchase_cost) VALUES(?,?,?,?,?,?,?,?)',[i.order_item_id,i.order_id,i.ozon_sku,i.quantity,i.sale_price,i.settlement_state,i.estimated_commission??0,i.frozen_purchase_cost??0]);if(i.sale_amount_cny!=null)await q('INSERT INTO order_profit_items(order_item_id,sale_amount_cny,profit_status,lock_reason,commission_fee_cny,purchase_cost_cny) VALUES(?,?,?,?,?,?)',[i.order_item_id,i.sale_amount_cny,i.profit_status||'estimated',i.lock_reason,i.commission_fee_cny??0,i.purchase_cost_cny??0]);}
}
const fileAdapter={owned:async(url)=>{if(!privateFiles.has(url))throw new Error('附件不存在');},read:async url=>{if(!privateFiles.has(url))throw new Error('附件不存在');return privateFiles.get(url);}};
const service=createCompanyFinanceDocuments({query:q,execute:q,files:fileAdapter,authorize:async()=>session,transaction:async worker=>{await fixture.connection.beginTransaction();try{const result=await worker({query:q,execute:q});await fixture.connection.commit();return result;}catch(e){await fixture.connection.rollback();throw e;}}});
let fileCounter=0;
for(const file of manifest.files){
 const url=`/uploads/team-attachments/preview-${++fileCounter}${path.extname(file.name)}`;
 privateFiles.set(url,{row:{original_name:file.name},buffer:await fs.readFile(file.source)});
 const doc=await service.preview({company_id:20,shop_id:file.shared||/^(entry|withdraw)_export/.test(file.name)?0:200,month:file.existing_month||file.month||'2026-10',upload_type:file.upload_type||'auto',display_name:(file.display_name||'').replace(/^待兼容 · /,''),attachment_url:url},session);
 if(doc.document.parse_status==='error')throw new Error(`${file.name}: ${doc.document.payload_json.warnings.join('；')}`);
 await service.confirm({company_id:20,document_id:doc.document.id},session);
 if(file.reparse_as){const retry=await service.preview({company_id:20,shop_id:0,month:file.month,upload_type:file.reparse_as,attachment_url:url},session);if(retry.document.id!==doc.document.id||!retry.reclassified||retry.document.parse_status!=='preview')throw new Error('配套原件重新解析未复用原件编号');await service.confirm({company_id:20,document_id:retry.document.id},session);}
}
let reconciliationAcceptance=null;
if(manifest.order_snapshot){
 const input={company_id:20,shop_id:200,month:'2026-08'},r=await service.reconcile(input,session);
 if(r.summary.official_orders!==425||r.summary.sales!==16416.23||r.summary.refunds!==147.48||r.summary.net_partner!==206.39||r.summary.commission!==2018.57||r.summary.net_revenue!==16475.14||!r.summary.complete_controls||r.rows.some(r=>!r.baseline))throw new Error('真实8月官方逐单控制核对失败');
 const five=['62099017-0791-1','87293990-0212-1','43939141-0727-2','66483185-0176-1','0263771246-0002-5'];const rows=r.rows.filter(r=>five.includes(r.posting_number));
 if(rows.length!==5||rows.some(r=>r.target.net_revenue!==(r.posting_number==='66483185-0176-1'?50.35:0)))throw new Error('5笔原始退款/补贴金额不一致');
 const preview=await service.calibrationPreview({...input,row_keys:rows.map(r=>r.key)},session);if(preview.rows.length!==5)throw new Error('真实订单校准预览失败');
 const demo=r.rows.find(r=>r.posting_number==='34094249-0346-1');const baseline=await q('SELECT * FROM order_profit_items WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=?)',[demo.baseline.order_ids[0]]);
 await service.calibrationConfirm({...input,rows:[{key:demo.key,token:demo.token}],reason:'仅独立本地验收：核对官方CNY，确认后保存历史',acknowledge:true},session);
 const same=await q('SELECT * FROM order_profit_items WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=?)',[demo.baseline.order_ids[0]]);if(JSON.stringify(baseline)!==JSON.stringify(same))throw new Error('校准改写了历史冻结利润');
 const latest=await service.reconcile(input,session);if(latest.history.length!==1||latest.summary.adjusted_rows!==1)throw new Error('真实校准历史未保存');
 reconciliationAcceptance={official_orders:425,official_rows:r.rows.length,net_sales:16268.75,net_partner:206.39,net_commission:2018.57,all_monthly_controls_zero:r.controls.every(c=>c.difference===0),five_orders_previewed:5,local_confirmation_history:1,frozen_order_profit_unchanged:true};
}
const report=await service.report({company_id:20,month:'2026-10'},session);
const incomes=new Set(['已确认商品销售额','销售退回冲减额','合作伙伴补贴收入','平台赔偿收入']);
const platformFees=Math.round(Object.entries(report.metrics).filter(([k])=>!incomes.has(k)).reduce((s,[,v])=>s+v,0)*100)/100;
const expectedFees=manifest.expected_months?.['2026-10']?.platform_fees??Math.round(manifest.reviews.reduce((s,r)=>s+r[2],0)*100)/100;
const expectedMetric=metric=>manifest.expected_months?.['2026-10']?.[metric]??Math.round(manifest.raw.filter(r=>r[1]===metric).reduce((s,r)=>s+r[2],0)*100)/100;
if(platformFees!==expectedFees||report.metrics['已确认商品销售额']!==expectedMetric('已确认商品销售额')||report.metrics['销售退回冲减额']!==expectedMetric('销售退回冲减额'))throw new Error('Z店10月验收金额与独立整理结果不一致');
if(report.cash_reconciliation.matches.length!==2||report.cash_reconciliation.matches.some(m=>m.status!=='amount_date_candidate'))throw new Error('10月两笔收款候选匹配不一致');
const annual=await service.report({company_id:20,from:'2026-01',to:'2026-12',period_mode:'year'},session);
if(manifest.expected_annual)for(const [metric,value]of Object.entries(manifest.expected_annual))if(annual.metrics[metric]!==value)throw new Error(`全年指标不一致：${metric}`);
if(manifest.expected_months)for(const [month,expected]of Object.entries(manifest.expected_months)){const monthly=await service.report({company_id:20,month},session);const fees=Math.round(Object.entries(monthly.metrics).filter(([k])=>!incomes.has(k)).reduce((n,[,v])=>n+v,0)*100)/100;if(fees!==expected.platform_fees)throw new Error(`${month}平台费用与独立整理结果不一致`);}
if(manifest.expected_payments)for(const [month,count]of Object.entries(manifest.expected_payments)){const r=await service.report({company_id:20,month},session);if(r.cash_reconciliation.matches.length!==count)throw new Error(`${month}付款跨归档月份读取不一致`);}
let cashDedupAcceptance=null;
if(manifest.order_snapshot){const c=annual.cash_reconciliation.currencies.find(c=>c.currency==='CNH');if(c?.entries!==50169.29||c?.withdrawals!==50169.29||c?.fees!==602.04||annual.cash_reconciliation.duplicates.length!==6)throw new Error('真实连连重叠导出未按交易去重');cashDedupAcceptance={entries_cnh:c.entries,withdrawals_cnh:c.withdrawals,fees_cnh:c.fees,duplicate_transactions:6};}
const periodColumns={};
for(const [mode,count]of [['month',12],['quarter',4],['year',1]]){
 const r=await service.report({company_id:20,from:'2026-01',to:'2026-12',period_mode:mode},session);
 if(r.matrix.periods.length!==count||JSON.stringify(r.metrics)!==JSON.stringify(annual.metrics))throw new Error(`${mode}期间列数或跨期间汇总不一致`);
 periodColumns[mode]=r.matrix.periods.map(p=>p.label);
}
const exported=await service.export({company_id:20,month:'2026-10'},session);
const output=path.resolve(process.argv[3]||'/private/tmp/finance-preview');await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(output,'Z店10月_系统导出验收.zip'),exported.buffer);
await fs.writeFile(path.join(output,'验收结果.json'),JSON.stringify({files:manifest.files.length,metrics:report.metrics,platform_fees:platformFees,cash_matches:report.cash_reconciliation.matches.length,coverage:report.coverage,annual_metrics:annual.metrics,period_columns:periodColumns,database:fixture.database,reconciliation:reconciliationAcceptance,cash_dedup:cashDedupAcceptance},null,2));
const previewEntry=`import {createApp,h} from 'vue';import {createPinia}from 'pinia';import{createRouter,createWebHashHistory,RouterView}from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Page from '/frontend/admin/views/finance/CompanyStatementsView.vue';import Overview from '/frontend/admin/views/finance/FinanceOverviewView.vue';import{useAuthStore}from '/frontend/admin/stores/auth.js';const app=createApp({render:()=>h(RouterView)}),pinia=createPinia(),router=createRouter({history:createWebHashHistory(),routes:[{path:'/finance-center',component:Overview},{path:'/:pathMatch(.*)*',component:Page}]});app.use(pinia);app.use(router);app.use(ElementPlus);const auth=useAuthStore();auth.user=${JSON.stringify(session)};auth.bootstrapped=true;app.mount('#app');`;
const vite=await createServer({configFile:false,plugins:[vue(),{name:'finance-preview-entry',resolveId(id){if(id==='/finance-preview-entry.js')return '\0finance-preview-entry';},load(id){if(id==='\0finance-preview-entry')return previewEntry;}}],optimizeDeps:{include:['vue','pinia','vue-router','element-plus']},server:{middlewareMode:true,hmr:false},appType:'custom',publicDir:false});
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const body=async req=>{const parts=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>21*1024*1024)throw new Error('请求超过21MB');parts.push(chunk);}return Buffer.concat(parts);};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost:8788');
  if(url.pathname==='/admin.html'){
   res.setHeader('Set-Cookie',`finance_preview=${token}; HttpOnly; SameSite=Strict; Path=/`);

   const html=await vite.transformIndexHtml(url.pathname,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>公司账单本地验收</title><body style="margin:24px"><p style="color:#795000">独立测试数据库 · Z店真实文件验收 · 未连接生产</p><nav><a href="/admin.html#/finance/company-statements?month=2026-10">公司账单与文件分类</a> · <a href="/admin.html#/finance-center">经营总览口径说明</a></nav><div id="app"></div><script type="module" src="/finance-preview-entry.js"></script></body></html>`);
   res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);
  }
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/uploads/')){
   if(!String(req.headers.cookie||'').split(';').some(s=>s.trim()===`finance_preview=${token}`))return json(res,{error:'仅本地验收会话可访问'},403);
   if(url.pathname==='/api/finance-center/companies')return json(res,{companies:await q('SELECT * FROM finance_companies WHERE tenant_id=2'),assignments:await q('SELECT * FROM finance_shop_company_assignments WHERE tenant_id=2'),shops:await q('SELECT id,name FROM shops WHERE tenant_id=2')});
   if(url.pathname==='/api/monthly-billing-details'&&overviewSnapshot){
    const selected=url.searchParams.get('shopId')||'all';if(url.searchParams.get('year')!=='2026'||!['all','200'].includes(selected))return json(res,{error:'本地仅载入合肥公司及Z店2026年快照'},400);
    const data=structuredClone(selected==='200'?overviewSnapshot.overview:overviewSnapshot.company_overview);data.companies=[{id:20,name:'合肥公司（本地验收）'}];data.shops=await q('SELECT id,name FROM shops WHERE tenant_id=2');return json(res,data);
   }
   if(url.pathname==='/api/finance-center/inventory-capital'&&overviewSnapshot)return json(res,{inventory_total_value:null,local_inventory_value:null,local_inventory_quantity:null,fbp_inventory_value:null,fbp_inventory_quantity:null,in_transit_value:null,in_transit_quantity:null,snapshot_at:null});
   if(url.pathname==='/api/finance-center/document-reconciliation')return json(res,await service.reconcile(Object.fromEntries(url.searchParams),session));
   if(url.pathname==='/api/finance-center/document-calibration'){const data=JSON.parse((await body(req)).toString());if(!['preview','confirm'].includes(data.action))throw new Error('操作无效');return json(res,await service[data.action==='preview'?'calibrationPreview':'calibrationConfirm'](data,session));}
   if(url.pathname==='/api/finance-center/order-sales-source'){const data=JSON.parse((await body(req)).toString());if(data.month!=='2026-08'||Number(data.shop_id)!==200||Number(data.company_id)!==20)return json(res,{error:'本地仅载入Z店8月官方只读快照，未连接Ozon'},400);const raw=JSON.parse(await fs.readFile(manifest.official_order_source,'utf8'));return json(res,{data:raw,filename:'Ozon_order_sales_18612241_2026-08.json',source:'本地既有官方报告快照'});}
   if(url.pathname==='/api/finance-center/document-report')return json(res,await service.report(Object.fromEntries(url.searchParams),session));
   if(url.pathname==='/api/finance-center/document-import'){
    const data=JSON.parse((await body(req)).toString());if(!['preview','confirm','review'].includes(data.action))throw new Error('操作无效');return json(res,await service[data.action](data,session));
   }
   if(url.pathname==='/api/finance-center/document-export'){const f=await service.export(Object.fromEntries(url.searchParams),session);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment;filename*=UTF-8''${encodeURIComponent(f.filename)}`});return res.end(f.buffer);}
   if(url.pathname==='/api/finance-center/voucher-attachments'){
    const raw=await body(req);const boundary=String(req.headers['content-type']).match(/boundary=(.+)/)?.[1];if(!boundary)throw new Error('上传缺少边界');
    const start=raw.indexOf('\r\n\r\n'),end=raw.lastIndexOf(`\r\n--${boundary}`);if(start<0||end<start)throw new Error('上传结构不完整');
    const filename=raw.subarray(0,start).toString().match(/filename="([^"]+)"/)?.[1]||'source.pdf';const buffer=raw.subarray(start+4,end),attachment=`/uploads/team-attachments/preview-${++fileCounter}${path.extname(filename)}`;privateFiles.set(attachment,{row:{original_name:filename},buffer});return json(res,{ok:true,url:attachment,name:filename});
   }
   if(privateFiles.has(url.pathname)){const f=privateFiles.get(url.pathname);res.setHeader('Content-Type',url.pathname.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');return res.end(f.buffer);}
   return json(res,{error:'仅实现本次验收页面所需接口'},404);
  }
  vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});
 }catch(e){json(res,{error:e.message},e.statusCode||500);}
});
server.listen(8788,'127.0.0.1',()=>console.log(`本地验收：http://127.0.0.1:8788/admin.html#/finance/company-statements\n${manifest.files.length}份原件、10月平台费用${platformFees} CNY、两笔收款候选、ZIP导出已通过；数据库${fixture.database}`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await vite.close();server.close();await fixture.cleanup();process.exit(0);});
