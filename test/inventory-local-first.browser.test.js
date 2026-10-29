import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const local = id => ({ product: { id, name: `商品${id}` }, revision: 'r'+id, physical_estimate: id===1?170:50,
  open_order_demand: 1, fbp_reserved: 0, current_stock_reserved: 1, available_estimate: id===1?169:49,
  incoming_quantity: 0, current_incoming: 0, current_shortage: 0, orders: [], purchases: [], movements: [], actions: [],
  flow_summary: { safety: id===1?18:1, free:id===1?151:48, local_days:9, consumed_7d:14, daily_consumption:2,
    production_days:7, local_shipping_days:2, applications_pending:true, requested:null, orders:[],applications:[] } });
const fbp = id => ({ product_id:id, applications:[],requested:0,fbp_inventory:{present:7,available:7,incomplete:false,rows:[{shop_id:1,shop_name:'示例店铺',ozon_sku:'SKU-'+id,present:7,available:7,per_set_quantity:1,inventory_quantity:7}]}});

test('local facts render before a slow FBP response; late product responses, failure and manual sync stay isolated', {
  skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000
},async()=>{
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'inventory-local-first-'));let browser;
  const pending=[], errors=[], syncCalls=[];let coreRoute, failFbp=false, holdFbp=true;
  try{
    const overview={active:true,items:[{product_id:1,product_name:'商品1',quantity:1},{product_id:2,product_name:'商品2',quantity:1}]};
    await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'local-first',resolveId(id){if(id==='virtual:local-first')return '\0local-first'},load(id){if(id==='\0local-first')return `import {createApp,h} from 'vue';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import {createRouter,createMemoryHistory} from 'vue-router';import Ledger from '/frontend/admin/components/procurement/ProcurementLedgerDialog.vue';const router=createRouter({history:createMemoryHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]});createApp({render:()=>h(Ledger,{modelValue:true,productId:1,orderId:9,orderOverview:${JSON.stringify(overview)}})}).use(ElementPlus).use(router).mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:local-first',output:{entryFileNames:'entry.js'}}}});
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:8788/**',async route=>{
      const url=new URL(route.request().url()), id=Number(url.searchParams.get('product_id'));
      if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
      if(url.pathname.endsWith('/ledger')&&route.request().method()==='GET'){
        if(url.searchParams.get('view')==='fbp'){
          if(failFbp)return route.fulfill({status:503,json:{error:'FBP单独读取失败'}});
          if(holdFbp){pending.push({id,route});return;}
          return route.fulfill({json:fbp(id)});
        }
        assert.equal(url.searchParams.get('include_flow'),'local');
        if(id===1&&!coreRoute){coreRoute=route;return;}
        return route.fulfill({json:local(id)});
      }
      if(url.pathname==='/api/inventory-flow/sync'){syncCalls.push(route.request().postDataJSON());return route.fulfill({json:{ok:true,results:[{ok:true}]}});}
      if(url.pathname.includes('/image'))return route.fulfill({status:404,body:''});
      const asset=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(n=>n.endsWith('.css'))):url.pathname.slice(1);
      return route.fulfill({contentType:asset.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,asset))});
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.getByText('正在读取本地库存与订单占用…',{exact:true}).waitFor();
    assert.ok((await page.locator('.ledger-detail-body').boundingBox()).height>=470);
    await coreRoute.fulfill({json:local(1)});
    await page.locator('[data-node="physical"]').getByText('170 件',{exact:true}).waitFor();
    await page.locator('[data-node="free"]').getByText('151 件',{exact:true}).waitFor();
    await page.getByRole('button',{name:'刷新对账',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'刷新对账',exact:true}).isEnabled(),true);
    await page.getByRole('button',{name:'商品2',exact:true}).click();
    await page.locator('[data-node="physical"]').getByText('50 件',{exact:true}).waitFor();
    while(pending.length<2)await new Promise(resolve=>setTimeout(resolve,10));
    await pending[0].route.fulfill({json:fbp(1)});
    await pending[1].route.fulfill({json:fbp(2)});
    await page.getByRole('tab',{name:'FBP 库存',exact:true}).click();
    await page.getByText('SKU-2',{exact:true}).waitFor();
    assert.equal(await page.getByText('SKU-1',{exact:true}).count(),0);
    holdFbp=false;failFbp=true;
    await page.getByRole('button',{name:'重新读取已保存库存',exact:true}).click();
    await page.locator('.flow-fbp-error').getByText(/FBP单独读取失败/).waitFor();
    await page.locator('[data-node="free"]').getByText('48 件',{exact:true}).waitFor();
    failFbp=false;
    await page.getByRole('button',{name:'从 Ozon 同步 FBP 库存',exact:true}).click();
    await page.getByText('FBP 库存已从 Ozon 同步',{exact:true}).waitFor();
    assert.deepEqual(syncCalls,[{product_id:2}]);
    assert.equal(await page.getByRole('button',{name:'刷新对账',exact:true}).isEnabled(),true);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});
