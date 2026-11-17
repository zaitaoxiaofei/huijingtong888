import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source=await fs.readFile(new URL('../ozon-erp-collector-plugin/finance-system-sync.js',import.meta.url),'utf8');
const hash=async blob=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
const context={tenant_id:1,shop:{id:4},binding_token:'verified',bindings:[{month:'2026-10',company:{id:10}}]};
function runtime(extra={}){const ctx=vm.createContext({URLSearchParams,AbortController,FormData,Blob,Uint8Array,atob,btoa,crypto:webcrypto,setTimeout,clearTimeout,...extra});vm.runInContext(source,ctx);return ctx;}
async function requestInput(){const blob=new Blob(['%PDF-1.7 official original'],{type:'application/pdf'});return {query:{months:'2026-10',ozon_company_id:'77'},binding_token:'verified',tenant_id:1,company_id:10,shop_id:4,month:'2026-10',source:{sha256:await hash(blob)},file:{name:'official.pdf',type:blob.type,base64:btoa(await blob.text())}};}
test('ERP transport uploads exact bytes and creates a preview without exposing its token or confirming amounts',async()=>{
 const input=await requestInput(),calls=[];let original;
 const ctx=runtime({location:{origin:'https://erp.hjt888.xyz'},localStorage:{getItem:()=> 'private-token'},fetch:async(path,options)=>{
  calls.push(path);assert.equal(options.headers.Authorization,'Bearer private-token');
  if(path.includes('document-archive-context'))return Response.json(context);
  if(path.includes('voucher-attachments')){original=options.body.get('file');return Response.json({ok:true,url:'/uploads/team-attachments/one.pdf'});}
  const body=JSON.parse(options.body);assert.notEqual(body.action,'confirm');
  if(body.action==='lookup')return Response.json({document:null});
  assert.equal(body.archive_source.sha256,input.source.sha256);return Response.json({document:{id:1,parse_status:'preview'},duplicate:false});
 }});
 const result=await ctx.OzonFinanceSystemRequest(input);
 assert.equal(result.ok,true);assert.equal(original.name,'official.pdf');assert.equal(await hash(original),input.source.sha256);
 assert.equal(calls.filter(p=>p.includes('voucher-attachments')).length,1);assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('existing server original skips binary upload, while login and binding changes stop writes',async()=>{
 const input=await requestInput();let uploads=0,token='one';
 const ctx=runtime({location:{origin:'https://erp.hjt888.xyz'},localStorage:{getItem:()=>token},fetch:async(path)=>{
  if(path.includes('document-archive-context'))return Response.json(context);
  if(path.includes('voucher-attachments'))uploads++;
  return Response.json({document:{id:7,parse_status:'confirmed'},duplicate:true});
 }});
 const result=await ctx.OzonFinanceSystemRequest(input);assert.equal(result.data.document.id,7);assert.equal(uploads,0);
 ctx.fetch=async()=>Response.json({...context,binding_token:'changed'});assert.match((await ctx.OzonFinanceSystemRequest(input)).error,/绑定已变化/);
 ctx.fetch=async()=>{token='two';return Response.json(context);};assert.match((await ctx.OzonFinanceSystemRequest(input)).error,/切换/);
 assert.equal(uploads,0);
});
test('local backfill retries without a Seller re-download, preserves files and records server document links',async()=>{
 const blob=new Blob(['%PDF-1.7 local original']),sha=await hash(blob),doc={id:123,path:'original.pdf',sha256:sha,bytes:blob.size,saved:true,file_name:'original.pdf'};
 const item={folder:{id:'realizationReports'},section:['结算单据']},manifest={sections:[{...item,documents:[doc]}],complete:true};
 const state={stored:false,uploads:0,checks:0,writes:0};
 const ctx=runtime({OzonFinanceArchive:{inspect:async()=>({manifest,verified:[{item,doc}]}),readFile:async()=>blob,digest:hash,checkpoint:async()=>{state.writes++;}}});
 const options={directory:{},plan:{context:{...context,shop:{id:4,ozon_company_id:'77'}},query:{months:'2026-10'},language:'en',erp_tab:1},row:{binding:{month:'2026-10',company:{id:10}}},folderIds:['realizationReports'],stopped:()=>false,onProgress:()=>{},verifySeller:async()=>{state.checks++;},execute:async(_tab,_func,input)=>{
  if(!state.stored&&!input.file)return {data:{document:null}};
  if(input.file){state.uploads++;state.stored=true;}
  return {data:{document:{id:7,parse_status:'preview',month_key:'2026-10',attachment_url:'/uploads/team-attachments/one.pdf'},duplicate:!input.file}};
 }};
 const first=await ctx.OzonFinanceSystemSync.syncMonth(options);assert.equal(first.synced,1);assert.equal(doc.system.document_id,7);
 const second=await ctx.OzonFinanceSystemSync.syncMonth(options);assert.equal(second.existing,1);assert.equal(state.uploads,1);assert.equal(doc.saved,true);assert.equal(manifest.complete,true);assert.equal(state.writes,2);
 doc.sha256='b'.repeat(64);await assert.rejects(ctx.OzonFinanceSystemSync.syncMonth(options),/本地原件已变化/);assert.match(doc.system_sync_error,/本地原件已变化/);assert.equal(state.uploads,1);
});
test('oversize local originals remain saved and are reported as unsynced',async()=>{
 const doc={id:1,bytes:21*1024*1024,saved:true};let writes=0;
 const ctx=runtime({OzonFinanceArchive:{inspect:async()=>({manifest:{},verified:[{item:{folder:{id:'x'},section:['']},doc}]}),checkpoint:async()=>writes++}});
 const result=await ctx.OzonFinanceSystemSync.syncMonth({plan:{context:{},language:'en'},row:{binding:{month:'2026-10'}},folderIds:['x'],stopped:()=>false,onProgress:()=>{}});
 assert.equal(result.errors,1);assert.equal(doc.saved,true);assert.match(doc.system_sync_error,/20MB/);assert.equal(writes,1);
});
