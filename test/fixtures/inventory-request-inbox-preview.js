import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {demoUser} from './inventory-role-workspace.js';
export async function startInventoryRequestInboxPreview(){
 const user={...demoUser,name:'库存经理',tenant:{...demoUser.tenant,access_allowed:true,status:'active',subscription_status:'active'}};
 const payload={name:'测试库存申请',owner_person_id:1,structured_naming:{category:'测试配件',accessory:'普通款',colors:['黑色'],materials:['PVC'],quantity:1,stock_unit:'个'}};
 const requests=[1,2].map(id=>({id,applicant_id:id,applicant_name:id===1?'库存经理':'同事',status:'pending',revision:1,payload:{...payload,name:'测试库存申请 '+id},new_options:[{type:'category',label:'核心品名',value:'测试配件'}],created_at:'2026-11-03T01:00:00Z'}));
 const notices=requests.map(r=>({id:r.id,notification_type:'inventory_product_request',entity_id:String(r.id),status:'unread',title:'库存申请待审核',content:`申请 #${r.id} · ${r.payload.name}`,route:`/inventory/product-requests?requestId=${r.id}`,severity:'warning',created_at:r.created_at}));
 const calls=[],streams=new Set();let nextNotice=3;
 const publish=(name,payload)=>{for(const stream of streams)stream.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);};
 const entry=`import {createApp} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import '/frontend/admin/styles/paged-workspace.css';import App from '/frontend/admin/App.vue';import {router} from '/frontend/admin/router/index.js';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const app=createApp(App),pinia=createPinia();app.use(pinia);const auth=useAuthStore();auth.user=${JSON.stringify(user)};auth.bootstrapped=true;setAuthToken('inventory-request-test');localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));window.inboxAuth=auth;window.layoutErrors=[];app.config.errorHandler=e=>window.layoutErrors.push(e.message);app.use(router).use(ElementPlus);await router.isReady();app.mount('#adminApp');`;
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'inventory-request-inbox-vite-'));
 const server=await createServer({root:process.cwd(),configFile:false,cacheDir,define:{__APP_RELEASE_VERSION__:JSON.stringify('inbox-fixture'),__APP_RELEASE_CHANNEL__:JSON.stringify('local')},optimizeDeps:{include:['vue','vue-router','pinia','element-plus','@element-plus/icons-vue']},server:{host:'::1',port:8788,strictPort:true,hmr:{overlay:false}},logLevel:'error',plugins:[vue(),{name:'inventory-request-inbox-fixture',resolveId(id){if(id==='/__inbox/entry.js')return id;},load(id){if(id==='/__inbox/entry.js')return entry;},configureServer(server){server.middlewares.use((req,res,next)=>{
  const url=new URL(req.url,'http://localhost'),send=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  if(url.pathname==='/admin.html'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="adminApp"></div><script type="module" src="/__inbox/entry.js"></script></body></html>');return;}
  if(url.pathname==='/__fixture/state'){send({streams:streams.size,pending:requests.filter(r=>r.status==='pending').length});return;}
  if(url.pathname==='/__fixture/create'&&req.method==='POST'){
   const row={...requests[0],id:3,status:'pending',revision:1,payload:{...payload,name:'新提交库存申请'},created_at:new Date().toISOString()};requests.push(row);const notice={id:nextNotice++,notification_type:'inventory_product_request',entity_id:'3',status:'unread',title:'库存申请待审核',content:'申请 #3 · 新提交库存申请',severity:'warning',route:'/inventory/product-requests?requestId=3',created_at:row.created_at};notices.unshift(notice);publish('system-notification',{type:'inventory_product_request',title:notice.title,message:notice.content,route:notice.route});publish('inventory-product-request',{refresh:true});send({ok:true});return;
  }
  if(!url.pathname.startsWith('/api/'))return next();
  if(url.pathname==='/api/system/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('event: hello\ndata: {"connected":true}\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
  if(url.pathname==='/api/auth/me'){send(user);return;}
  if(url.pathname==='/api/system/update-status'){send({app:{version:'inbox-fixture',update_required:false}});return;}
  if(url.pathname==='/api/inventory-product-requests'){const pending=requests.filter(r=>r.status==='pending').length;if(url.searchParams.get('summary')==='1'){send({pending_count:pending,can_review:true});return;}const status=url.searchParams.get('status'),rows=requests.filter(r=>!status||status===r.status).map(r=>({...r,name:r.payload.name}));send({rows,total:rows.length,pending_count:pending,can_review:true});return;}
  const match=url.pathname.match(/^\/api\/inventory-product-requests\/(\d+)$/);
  if(match){const row=requests.find(r=>r.id===Number(match[1]));if(req.method==='GET'){send({...row,can_review:true});return;}let text='';req.on('data',c=>text+=c);req.on('end',()=>{const body=JSON.parse(text);calls.push({id:row.id,body});row.status='approved';row.revision++;for(const n of notices)if(n.entity_id===String(row.id))n.status='resolved';publish('system-notification',{refresh:true});publish('inventory-product-request',{refresh:true});send({status:'approved',request_id:row.id,product_id:100+row.id,binding_status:'none'});});return;}
  if(url.pathname==='/api/system-notifications'){send({rows:notices,unread:notices.filter(n=>n.status==='unread').length});return;}
  if(url.pathname.startsWith('/api/system-notifications/')&&req.method==='POST'){send({ok:true});return;}
  if(url.pathname==='/api/people'){send([{id:1,name:'库存经理',active:1},{id:2,name:'同事',active:1}]);return;}
  if(['/api/shops','/api/suppliers','/api/logistics-rules','/api/products/categories','/api/ai/vehicle-catalog'].includes(url.pathname)){send([]);return;}
  if(url.pathname==='/api/inventory-product-naming/options'){send({category:[],brand:[],accessory:[],color:[],material:[],process:[],quantity:[]});return;}
  if(url.pathname==='/api/products'){send({rows:[],total:0});return;}
  send({rows:[],total:0,unread:0});
 });}}]});await server.listen();
 return{server,cacheDir,calls,requests,async close(){for(const stream of streams)stream.end();await server.close();await fs.rm(cacheDir,{recursive:true,force:true});}};
}
