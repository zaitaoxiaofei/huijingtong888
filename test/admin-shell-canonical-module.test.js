import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('generated shell script, preloads and route imports share canonical fingerprinted URLs',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ozon-admin-canonical-'));
 try{
  const manifest={
   'frontend/admin/main.js':{file:'assets/admin-view-abcdef-12345.js',imports:['vendor'],css:['assets/admin-style-abcdef-12345.css']},
   vendor:{file:'assets/vendor-abcdef-12345.js',css:['assets/vendor-style-abcdef-12345.css']},
   'frontend/admin/views/orders/OrdersView.vue':{file:'assets/orders-view-abcdef-12345.js',imports:['frontend/admin/main.js','vendor']},
   'frontend/orders/OrdersPage.vue':{file:'assets/order-page-abcdef-12345.js',imports:['frontend/admin/main.js','vendor']}
  };
  await fs.mkdir(path.join(root,'public'),{recursive:true});
  const manifestPath=path.join(root,'manifest.json');await fs.writeFile(manifestPath,JSON.stringify(manifest));
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/generate-admin-shell.mjs',import.meta.url))],{cwd:root,env:{...process.env,OZON_VITE_MANIFEST_PATH:manifestPath}});
  const html=await fs.readFile(path.join(root,'public/admin.html'),'utf8');
  const script=html.match(/<script type="module" src="([^"]+)"/)[1];
  assert.equal(script,'/vue-apps/'+manifest['frontend/admin/main.js'].file);
  const preloads=[...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(preloads.filter(url=>url===script).length,1);assert.equal(new Set(preloads).size,preloads.length);
  assert.ok(!/\/vue-apps\/[^"\s]+\?v=/.test(html));
  assert.match(html,/href="\/vue-apps\/assets\/admin-style-abcdef-12345\.css"/);
  assert.ok(html.indexOf('rel="modulepreload"')<html.indexOf('<script type="module"'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
