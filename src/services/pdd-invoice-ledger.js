import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {resolveUploadSubdir} from '../runtime-uploads.js';
const query=async(...args)=>(await import('../mysql-pool.js')).mysqlQuery(...args);
const execute=async(...args)=>(await import('../mysql-pool.js')).mysqlExecute(...args);
const transaction=async worker=>(await import('../mysql-pool.js')).withMysqlTransaction(c=>worker({query:async(...args)=>(await c.execute(...args))[0],execute:async(...args)=>(await c.execute(...args))[0]}));
import {PDD_INVOICE_SCHEMA} from './pdd-invoice-schema.js';
export {PDD_INVOICE_SCHEMA};
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const text=(v,n=1000)=>String(v??'').slice(0,n);
const decode=r=>typeof r?.payload_json==='string'?JSON.parse(r.payload_json):r?.payload_json;
function accountId(v){if(!/^[A-Za-z0-9_-]{8,64}$/.test(v||''))fail('采购账号标识无效，请重新同步账号');return v;}
export function sanitizePddRow(input){
 if(!/^[\d-]{10,40}$/.test(input?.id||''))fail('采购订单号无效');
 const row={id:input.id};
 for(const k of ['product','shop','date','status','note','taskStatus','appliedAt','issuedAt','invoiceNo','rejectionReason','ledgerNote'])row[k]=text(input[k],k==='product'?250:1000);
 if(!['pending','submitted','issued','rejected','skipped','review','failed'].includes(row.status))fail('开票状态无效，请重新读取');
 for(const k of ['amount','mallId'])row[k]=text(input[k],80);
 for(const k of ['thumbnail','url','applicationUrl']){try{const u=new URL(input[k]);if(u.protocol==='https:'&&!u.username&&!u.password&&(k==='thumbnail'?/\.(pddpic\.com|yangkeduo\.com)$/.test('.'+u.hostname):u.origin==='https://mobile.pinduoduo.com'&&u.searchParams.get('order_sn')===row.id))row[k]=u.href;}catch{}}
 for(const k of ['invoiceAmountCents','applicationAmountCents','updated','platformCheckedAt'])if(Number.isSafeInteger(input[k])&&input[k]>=0)row[k]=input[k];
 row.history=(Array.isArray(input.history)?input.history:[]).slice(-100).map(h=>({at:Number(h.at)||0,source:h.source==='manual'?'manual':'platform',changes:(Array.isArray(h.changes)?h.changes:[]).slice(0,12).filter(c=>['status','appliedAt','issuedAt','invoiceAmountCents','applicationAmountCents','invoiceNo','rejectionReason','ledgerNote'].includes(c.field)).map(c=>({field:c.field,before:typeof c.before==='number'?c.before:text(c.before),after:typeof c.after==='number'?c.after:text(c.after)}))}));
 return row;
}
export function createPddInvoiceLedger({query:q=query,execute:e=execute,transaction:tx=transaction,root=resolveUploadSubdir('pdd-invoice-private')}={}){
 let ready;
 async function scope(p){const id=Number(p?.tenantId);if(!Number.isSafeInteger(id)||id<=0||!p.tokenId)fail('请配置有效的企业专属插件密钥',403);return id;}
 async function schema(){await(ready||=(e(PDD_INVOICE_SCHEMA).catch(err=>{ready=null;throw err;})));}
 async function companies(p){const tenant=await scope(p);return{tenant_id:tenant,companies:await q(`SELECT id,name,tax_number FROM finance_companies WHERE status='active' AND (tenant_id=? OR (?='default' AND tenant_id IS NULL)) ORDER BY id`,[tenant,p.tenantSlug])};}
 async function locked(p,id,worker){const tenant=await scope(p);accountId(id);await schema();return tx(async c=>{const [row]=await c.query('SELECT revision,payload_json FROM pdd_invoice_accounts WHERE tenant_id=? AND account_id=? FOR UPDATE',[tenant,id]);return worker(c,tenant,row,decode(row));});}
 return {companies,
 async list(p){const tenant=await scope(p);await schema();const rows=await q('SELECT account_id,revision,payload_json FROM pdd_invoice_accounts WHERE tenant_id=? ORDER BY updated_at DESC',[tenant]);return {tenant_id:tenant,accounts:rows.map(r=>({id:r.account_id,revision:Number(r.revision),...decode(r)}))};},
 async save(p,input){
  accountId(input.accountId);if(!Array.isArray(input.rows)||input.rows.length>100)fail('每次最多同步100笔订单');
  const normalized=input.rows.map(sanitizePddRow),name=text(input.name,30).trim();if(!name)fail('请填写采购账号备注名称');
  const companyId=Number(input.companyId)||null;const context=await companies(p);if(companyId&&!context.companies.some(c=>Number(c.id)===companyId))fail('所选公司不属于当前企业或已停用',403);
  return locked(p,input.accountId,async(c,tenant,row,old)=>{
   if(Number(input.revision||0)!==Number(row?.revision||0))fail('系统台账已被其他窗口更新，请先从系统恢复后再同步',409);
   const data=old||{name,companyId,orders:[]},map=new Map(data.orders.map(r=>[r.id,r]));
   for(const r of normalized){const original=input.rows.find(v=>v.id===r.id),old=map.get(r.id),company=context.companies.find(c=>Number(c.id)===Number(original?.invoiceCompany?.id));
    const invoiceCompany=company&&company.name===original.invoiceCompany.name&&String(company.tax_number||"").trim().toUpperCase()===String(original.invoiceCompany.taxId||"").trim().toUpperCase()?{id:Number(company.id),name:company.name,taxId:company.tax_number}:old?.invoiceCompany;
    map.set(r.id,{...r,...(invoiceCompany?{invoiceCompany}:{}),cloudFiles:old?.cloudFiles||[]});
   }
   data.name=name;data.companyId=companyId;data.orders=[...map.values()];if(data.orders.length>20000)fail('此账号台账已超过20000笔，请联系管理员归档');
   const json=JSON.stringify(data);if(Buffer.byteLength(json)>24*1024*1024)fail('账号台账过大，请联系管理员归档');
   const revision=Number(row?.revision||0)+1;
   if(row)await c.execute('UPDATE pdd_invoice_accounts SET revision=?,payload_json=? WHERE tenant_id=? AND account_id=?',[revision,json,tenant,input.accountId]);
   else await c.execute('INSERT INTO pdd_invoice_accounts(tenant_id,account_id,revision,payload_json) VALUES(?,?,?,?)',[tenant,input.accountId,revision,json]);
   return{revision,saved:normalized.length};
  });
 },
 async fileSave(p,input){
  const bytes=Buffer.from(String(input.base64||''),'base64');if(!bytes.length||bytes.length>5*1024*1024)fail('单份发票附件需小于5MB，请选择本地保存');
  const ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216?'jpg':bytes.subarray(0,5).toString()==='%PDF-'?'pdf':'';
  if(!ext)fail('仅支持平台发票 PNG、JPEG 图片和 PDF 文件');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  return locked(p,input.accountId,async(c,tenant,row,data)=>{
   const order=data?.orders.find(r=>r.id===input.orderId);if(!order)fail('请先将订单台账同步到系统',404);
   const existing=order.cloudFiles?.find(f=>f.sha256===sha256);if(existing)return{file:existing,revision:Number(row.revision)};
   const file={id:randomUUID(),ext,sha256,size:bytes.length,createdAt:Date.now(),name:`${order.id}${ext==='pdf'?'_官方文件':'_平台图片'}.${ext}`};
   const directory=path.join(root,String(tenant));await fs.mkdir(directory,{recursive:true,mode:0o700});const filename=path.join(directory,file.id+'.'+ext);
   await fs.writeFile(filename,bytes,{flag:'wx',mode:0o600});
   order.cloudFiles=[...(order.cloudFiles||[]),file];const revision=Number(row.revision)+1;
   try{await c.execute('UPDATE pdd_invoice_accounts SET revision=?,payload_json=? WHERE tenant_id=? AND account_id=?',[revision,JSON.stringify(data),tenant,input.accountId]);}catch(err){await fs.unlink(filename).catch(()=>{});throw err;}
   return{file,revision};
  });
 },
 async fileRead(p,input){const tenant=await scope(p);accountId(input.accountId);if(!/^[a-f0-9-]{36}$/.test(input.fileId||''))fail('附件不存在',404);await schema();const [row]=await q('SELECT payload_json FROM pdd_invoice_accounts WHERE tenant_id=? AND account_id=?',[tenant,input.accountId]);const file=decode(row)?.orders.flatMap(r=>r.cloudFiles||[]).find(f=>f.id===input.fileId);if(!file)fail('附件不存在或不属于当前企业',404);const bytes=await fs.readFile(path.join(root,String(tenant),file.id+'.'+file.ext));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)fail('系统附件校验失败，请重新归档',409);return{...file,base64:bytes.toString('base64')};}
 };
}
export const pddInvoiceLedger=createPddInvoiceLedger();
