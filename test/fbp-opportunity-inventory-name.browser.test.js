import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';

test('FBP inventory names remain distinct from listing titles and missing bindings are explicit', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:90000},async()=>{
  const output=process.env.FBP_NAME_TEST_OUTPUT_DIR||await fs.mkdtemp(path.join(os.tmpdir(),'fbp-inventory-name-'));
  await fs.mkdir(output,{recursive:true});
  const base={shop_id:1,shop_name:'验证店铺',image_url:'',suggested_qty:20,suggested_transfer_qty:8,suggested_purchase_qty:12,local_available:8,local_stock:8,fbp_available:3,fbs_available:5,score:75,priority:'high',priority_text:'优先备货',target_days:30,reason:'验证建议',warehouses:[]};
  const rows=[
    {...base,product_id:10,inventory_number:'1-2-1',ozon_sku:'SKU-111',product_name:'门槛条 TENET T4 实际库存名称',name:'在线商品标题 A',online_name:'备用在线标题 A'},
    {...base,product_id:11,inventory_number:'1-2-2',ozon_sku:'SKU-222',product_name:'',name:'在线商品标题 B'},
    {...base,product_id:null,inventory_number:'',ozon_sku:'SKU-333',product_name:'在线标题不是库存名称',name:'在线商品标题 C'},
    {...base,product_id:12,inventory_number:'1-2-3',ozon_sku:'SKU-444',product_name:'   ',name:'在线商品标题 D'}
  ];
  const entry=`import {createApp,h,KeepAlive} from 'vue';import {createPinia} from 'pinia';import {createRouter,createMemoryHistory} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import Page from '/frontend/admin/views/inventory/InventoryFbpOpportunitiesPage.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';const app=createApp({setup(){const auth=useAuthStore();auth.user={personId:7,name:'验证人员',roles:['manager'],tenant:{id:1,slug:'default'}};return()=>h(KeepAlive,null,{default:()=>h(Page)});}});app.use(createPinia());app.use(createRouter({history:createMemoryHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]}));app.use(ElementPlus);app.mount('#app');`;
  const server=await createServer({configFile:false,root:process.cwd(),optimizeDeps:{include:['vue','element-plus','pinia','vue-router']},server:{host:'127.0.0.1',port:8788,strictPort:true,watch:{ignored:['**/public/**','**/.deploy-artifacts/**','**/dist/**','**/.git/**']}},plugins:[vue(),{
    name:'fbp-inventory-name-fixture',resolveId(id){if(id==='virtual:fbp-name')return '\0fbp-name';},load(id){if(id==='\0fbp-name')return entry;},configureServer(s){s.middlewares.use('/admin.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/admin.html','<div id="app"></div><script type="module" src="/@id/virtual:fbp-name"></script>'));});}
  }]});
  const errors=[],reads=[],writes=[];
  let browser,page;
  try {
    await server.listen();
    const executablePath=process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome');
    browser=await chromium.launch({executablePath,headless:true});
    page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(!['localhost','127.0.0.1'].includes(url.hostname)){errors.push('Blocked external request: '+url.origin);return route.abort();}
      if(!url.pathname.startsWith('/api/'))return route.continue();
      if(request.method()!=='GET'){writes.push(url.pathname);return route.fulfill({json:{ok:true}});}
      reads.push(url.pathname+url.search);
      let body=[];
      if(url.pathname==='/api/fbp-opportunities')body={rows,total:rows.length,page:1,pageSize:20,summary:{total:4}};
      else if(url.pathname==='/api/inventory-product-naming/options')body={rows:[]};
      else if(url.pathname==='/api/ai-variant-lab/vehicle-catalog')body={brands:[]};
      return route.fulfill({json:body});
    });
    await page.goto('http://127.0.0.1:8788/admin.html#/inventory/fbp-opportunities');
    const table=page.locator('.el-table__body-wrapper');
    await table.getByText('SKU-111',{exact:true}).waitFor();
    await page.locator('.inventory-table-wrap .el-loading-mask').waitFor({state:'hidden'});
    const inventoryCell=sku=>table.locator('tr').filter({hasText:sku}).first().locator('.inventory-id-display').locator('..');
    assert.match(await inventoryCell('SKU-111').innerText(),/门槛条 TENET T4 实际库存名称/);
    assert.match(await inventoryCell('SKU-111').innerText(),/库存 ID：1-2-1/);
    assert.doesNotMatch(await inventoryCell('SKU-111').innerText(),/在线商品标题 A|备用在线标题 A/);
    assert.match(await inventoryCell('SKU-222').innerText(),/库存名称未填写/);
    assert.doesNotMatch(await inventoryCell('SKU-222').innerText(),/在线商品标题 B/);
    assert.match(await inventoryCell('SKU-333').innerText(),/未绑定库存/);
    assert.doesNotMatch(await inventoryCell('SKU-333').innerText(),/在线标题不是库存名称|在线商品标题 C/);
    assert.match(await inventoryCell('SKU-444').innerText(),/库存名称未填写/);
    const first=table.locator('tr').filter({hasText:'SKU-111'}).first();
    assert.match(await first.locator('.inventory-summary-cell').innerText(),/本地可发仓\s*8/);
    assert.equal(await first.getByRole('button',{name:'创建备货单',exact:true}).count(),1);
    await page.screenshot({path:path.join(output,'fbp-inventory-names.png'),fullPage:true});
    await first.locator('.fbp-sku-cell').hover();
    await page.getByRole('tooltip').getByText('在线商品标题 A',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'fbp-sku-title-retained.png'),fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    assert.equal(reads.filter(url=>url.startsWith('/api/fbp-opportunities?')).length,1,'KeepAlive startup GETs retain existing in-flight coalescing');
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks:['inventory product_name shown separately from three-part number','online SKU title retained in original tooltip','bound empty/whitespace names say missing inventory name','unbound row never presents listing title as inventory name','existing quantities and actions remain','initial request remains coalesced; all API mocked and nonlocal network blocked'],errors,reads,writes},null,2),'utf8');
  } catch(error) {
    if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
    throw error;
  } finally {if(browser)await browser.close();await server.close();}
});
