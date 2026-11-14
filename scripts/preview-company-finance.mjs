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

const manifest=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const fixture=await createTenantMysqlFixture('finance_preview');
const q=fixture.query,privateFiles=new Map(),token=crypto.randomUUID();
const session={id:10,personId:10,name:'本地验收',roles:['operations'],tenant:{id:2,slug:'finance-preview',role:'owner',access_allowed:true}};
await q("INSERT INTO tenants(id,slug,name,status) VALUES(2,'finance-preview','Finance Preview','active')");
await q("INSERT INTO finance_companies(id,tenant_id,name) VALUES(20,2,'合肥公司（本地验收）')");
for(const [id,name]of [[200,'RuVibe Mart Z'],[201,'VeloAuto'],[202,'CARVEO']]){
 await q('INSERT INTO shops(id,tenant_id,name) VALUES(?,2,?)',[id,name]);
 await q("INSERT INTO finance_shop_company_assignments(tenant_id,company_id,shop_id,effective_from) VALUES(2,20,?,'2026-01-01')",[id]);
}
const fileAdapter={owned:async(url)=>{if(!privateFiles.has(url))throw new Error('附件不存在');},read:async url=>{if(!privateFiles.has(url))throw new Error('附件不存在');return privateFiles.get(url);}};
const service=createCompanyFinanceDocuments({query:q,execute:q,files:fileAdapter,authorize:async()=>session,transaction:async worker=>{await fixture.connection.beginTransaction();try{const result=await worker({query:q,execute:q});await fixture.connection.commit();return result;}catch(e){await fixture.connection.rollback();throw e;}}});
let fileCounter=0;
for(const file of manifest.files){
 const url=`/uploads/team-attachments/preview-${++fileCounter}${path.extname(file.name)}`;
 privateFiles.set(url,{row:{original_name:file.name},buffer:await fs.readFile(file.source)});
 const doc=await service.preview({company_id:20,shop_id:/^(entry|withdraw)_export/.test(file.name)?0:200,month:'2026-10',attachment_url:url},session);
 if(doc.document.parse_status==='error')throw new Error(`${file.name}: ${doc.document.payload_json.warnings.join('；')}`);
 await service.confirm({company_id:20,document_id:doc.document.id},session);
}
const report=await service.report({company_id:20,month:'2026-10'},session);
const incomes=new Set(['已确认商品销售额','销售退回冲减额','合作伙伴补贴收入','平台赔偿收入']);
const platformFees=Math.round(Object.entries(report.metrics).filter(([k])=>!incomes.has(k)).reduce((s,[,v])=>s+v,0)*100)/100;
const expectedFees=Math.round(manifest.reviews.reduce((s,r)=>s+r[2],0)*100)/100;
const expectedMetric=metric=>Math.round(manifest.raw.filter(r=>r[1]===metric).reduce((s,r)=>s+r[2],0)*100)/100;
if(platformFees!==expectedFees||report.metrics['已确认商品销售额']!==expectedMetric('已确认商品销售额')||report.metrics['销售退回冲减额']!==expectedMetric('销售退回冲减额'))throw new Error('Z店10月验收金额与独立整理结果不一致');
if(report.cash_reconciliation.matches.length!==2||report.cash_reconciliation.matches.some(m=>m.status!=='amount_date_candidate'))throw new Error('10月两笔收款候选匹配不一致');
const exported=await service.export({company_id:20,month:'2026-10'},session);
const output=path.resolve(process.argv[3]||'/private/tmp/finance-preview');await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(output,'Z店10月_系统导出验收.zip'),exported.buffer);
await fs.writeFile(path.join(output,'验收结果.json'),JSON.stringify({files:manifest.files.length,metrics:report.metrics,platform_fees:platformFees,cash_matches:report.cash_reconciliation.matches.length,coverage:report.coverage,database:fixture.database},null,2));
const previewEntry=`import {createApp,h} from 'vue';import {createPinia}from 'pinia';import{createRouter,createWebHashHistory,RouterView}from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Page from '/frontend/admin/views/finance/CompanyStatementsView.vue';import{useAuthStore}from '/frontend/admin/stores/auth.js';const app=createApp({render:()=>h(RouterView)}),pinia=createPinia(),router=createRouter({history:createWebHashHistory(),routes:[{path:'/:pathMatch(.*)*',component:Page}]});app.use(pinia);app.use(router);app.use(ElementPlus);const auth=useAuthStore();auth.user=${JSON.stringify(session)};auth.bootstrapped=true;app.mount('#app');`;
const vite=await createServer({configFile:false,plugins:[vue(),{name:'finance-preview-entry',resolveId(id){if(id==='/finance-preview-entry.js')return '\0finance-preview-entry';},load(id){if(id==='\0finance-preview-entry')return previewEntry;}}],optimizeDeps:{include:['vue','pinia','vue-router','element-plus']},server:{middlewareMode:true,hmr:false},appType:'custom',publicDir:false});
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const body=async req=>{const parts=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>21*1024*1024)throw new Error('请求超过21MB');parts.push(chunk);}return Buffer.concat(parts);};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost:8788');
  if(url.pathname==='/admin.html'){
   res.setHeader('Set-Cookie',`finance_preview=${token}; HttpOnly; SameSite=Strict; Path=/`);

   const html=await vite.transformIndexHtml(url.pathname,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>公司账单本地验收</title><body style="margin:24px"><p style="color:#795000">独立测试数据库 · Z店真实文件验收 · 未连接生产</p><div id="app"></div><script type="module" src="/finance-preview-entry.js"></script></body></html>`);
   res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);
  }
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/uploads/')){
   if(!String(req.headers.cookie||'').split(';').some(s=>s.trim()===`finance_preview=${token}`))return json(res,{error:'仅本地验收会话可访问'},403);
   if(url.pathname==='/api/finance-center/companies')return json(res,{companies:await q('SELECT * FROM finance_companies WHERE tenant_id=2'),assignments:await q('SELECT * FROM finance_shop_company_assignments WHERE tenant_id=2'),shops:await q('SELECT id,name FROM shops WHERE tenant_id=2')});
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
server.listen(8788,'127.0.0.1',()=>console.log(`本地验收：http://localhost:8788/admin.html#/finance/company-statements\n27份原件、平台费用${platformFees} CNY、两笔收款候选、ZIP导出已通过；数据库${fixture.database}`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await vite.close();server.close();await fixture.cleanup();process.exit(0);});
