// Explicit source-only archival. Never confirms a document, adjusts an order,
// posts an expense, moves stock or transfers funds. Defaults to planning.
import fs from'node:fs/promises';import crypto from'node:crypto';import{config}from'../src/config.js';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1],base=process.env.HEALTH_CHECK_BASE_URL||`http://127.0.0.1:${config.port}`;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function request(path,token,body,form=false){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(form?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:form?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});const d=await r.json();if(!r.ok)throw Object.assign(Error(String(d.error||'HTTP '+r.status)),{status:r.status});return d;}
const apply=args.includes('--apply');if(!arg('--manifest')||!/^20\d{2}$/.test(arg('--year')||''))throw Error('Explicit --manifest and --year required');
const {token}=await request('/api/auth/login',null,{username:process.env.HEALTH_CHECK_USERNAME,password:process.env.HEALTH_CHECK_PASSWORD});if(!token)throw Error('Authentication failed');const me=await request('/api/auth/me',token),release=await request('/release.json');
const companies=(arg('--companies')||'').split(',').map(Number);if(!companies.length||companies.some(n=>!Number.isSafeInteger(n)||n<=0)||new Set(companies).size!==companies.length)throw Error('Explicit unique --companies required');
const year=arg('--year'),currentMonth=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}).slice(0,7),reports=[];
for(const company of companies){const r=await request('/api/finance-center/document-report?'+new URLSearchParams({company_id:company,from:year+'-01',to:year+'-12'}),token);if(!r.purchase_cost)throw Error('Purchase-cost feature is not deployed');reports.push({company,r});}
const liveTargets=reports.flatMap(({company,r})=>r.purchase_cost.pending_sources.filter(t=>t.month<currentMonth).map(t=>({...t,company_id:company}))).sort((a,b)=>a.company_id-b.company_id||a.shop_id-b.shop_id||a.month.localeCompare(b.month));
if(!apply){const plan={tenant_id:Number(me.tenant?.id||me.tenantId),release_sha:release.commit,year,companies,targets:liveTargets},bytes=JSON.stringify(plan,null,2)+'\n';await fs.writeFile(arg('--manifest'),bytes,{mode:0o600});console.log(JSON.stringify({mode:'plan',targets:liveTargets.length,manifest_sha256:digest(bytes),release:release.commit}));}
else{
 if(!args.includes('--receipt'))throw Error('--receipt required');const bytes=await fs.readFile(arg('--manifest')),plan=JSON.parse(bytes);if(digest(bytes)!==arg('--expected-sha')||plan.release_sha!==release.commit||plan.year!==year||plan.tenant_id!==Number(me.tenant?.id||me.tenantId)||JSON.stringify(plan.companies)!==JSON.stringify(companies))throw Error('Reviewed manifest, actor or release mismatch');
 const targetKey=t=>[t.company_id,t.shop_id,t.month].join(':'),allowed=new Set(liveTargets.map(targetKey)),results=[];
 for(const t of plan.targets)if(!companies.includes(Number(t.company_id))||!Number.isSafeInteger(Number(t.shop_id))||!new RegExp('^'+year+'-(0[1-9]|1[0-2])$').test(t.month))throw Error('Manifest target outside reviewed scope');
 for(const target of plan.targets){const result={...target};if(!allowed.has(targetKey(target))){result.status='already-present';results.push(result);continue;}
  try{const source=await request('/api/finance-center/order-sales-source',token,{company_id:target.company_id,shop_id:target.shop_id,month:target.month}),raw=JSON.stringify(source.data);if(Buffer.byteLength(raw)>20*1024*1024)throw Error('Original exceeds 20MB');const form=new FormData();form.append('file',new Blob([raw],{type:'application/json'}),source.filename);
   const uploaded=await request('/api/finance-center/voucher-attachments',token,form,true);if(!uploaded.ok)throw Error('Original upload failed');
   const p=await request('/api/finance-center/document-import',token,{action:'preview',upload_type:'order-sales',company_id:target.company_id,shop_id:target.shop_id,month:target.month,attachment_url:uploaded.url});if(p.document.parse_status==='error')throw Error(p.document.payload_json.warnings.join('；'));result.status=p.duplicate?'reused':'preview-archived';result.document_id=p.document.id;result.attachment_url=p.document.attachment_url;result.rows=source.data.rows.length;
  }catch(e){result.status='failed';result.error=e.message;result.http_status=e.status;}
  results.push(result);await fs.writeFile(arg('--receipt'),JSON.stringify({release_sha:release.commit,source_only:true,confirmed_documents:false,results},null,2),{mode:0o600});console.log(JSON.stringify(result));
  if([401,403,429].includes(result.http_status))break;
 }
 await fs.writeFile(arg('--receipt'),JSON.stringify({release_sha:release.commit,source_only:true,confirmed_documents:false,results},null,2),{mode:0o600});
 console.log(JSON.stringify({done:true,results:results.length,archived:results.filter(r=>r.status==='preview-archived').length,reused:results.filter(r=>r.status==='reused'||r.status==='already-present').length,failed:results.filter(r=>r.status==='failed').length}));
}
