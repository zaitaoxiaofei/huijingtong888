import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('each product in a multi-item order owns its ledger, physical stocktake, binding and inventory editor actions', { skip: process.env.RUN_TASK_BROWSER_TESTS !== '1' }, async () => {
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'order-multi-stock-'));let browser;
  const errors=[],requests=[];
  const row={id:1,shop_id:1,posting_number:'ORDER-1',statusLabel:'等待发货',productDisplayRows:[],logisticsSummary:{},profitSummary:{},procurementState:{},availableActions:{},unboundItems:[],
    inventorySummaries:[11,12].map(id=>({productId:id,inventoryNumber:`1-${id}`,sku:`SKU-${id}`,skus:id===11?['SKU-11','SKU-11-ALT']:[`SKU-${id}`],productName:`库存商品${id}`,quantity:1,stock:{local:5}})),
    procurement_coverage:{stock_location:'LOCAL',needs_fulfillment:true,items:[11,12].map(id=>({product_id:id,product_name:`库存商品${id}`,quantity:1,stock_quantity:1,incoming_quantity:0,shortage_quantity:0,product_local_available:4,physical_stock_estimate:5}))}};
  row.inventorySummaries.push({productId:20,inventoryNumber:'1-20',sku:'SKU-20',productName:'组合商品20',inventoryMode:'combo',quantity:1,pickingItems:[21,22].map(id=>({product_id:id,product_name:`子产品${id}`,inventory_number:`1-${id}`,required_quantity:1}))});
  try{
    await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{
      name:'multi-stock-fixture',resolveId(id){if(id==='virtual:multi-stock')return '\0multi-stock';},
      load(id){if(id==='\0multi-stock')return `import {createApp,h,ref} from 'vue';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Table from '/frontend/orders/components/OrdersTable.vue';createApp({setup(){const event=ref('');return ()=>h('div',[h(Table,{rows:[${JSON.stringify(row)}],canUpdateInventory:true,tableHeight:800,onEditInventoryProduct:id=>event.value='edit:'+id,onOpenBindProductFromOrder:(id,sku)=>event.value='bind:'+id+':'+sku}),h('p',{id:'event'},event.value)])}}).use(ElementPlus).mount('#app');`;}
    }],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:multi-stock',output:{entryFileNames:'entry.js'}}}});
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1920,height:1080}});page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:8788/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>'});
      if(['/api/procurement/ledger','/api/inventory/ledger'].includes(url.pathname)){
        requests.push(url.search);const id=Number(url.searchParams.get('product_id'));
        if(url.searchParams.get('view')==='fbp')return route.fulfill({json:{fbp_inventory:{rows:[],incomplete:false,present:0},applications:[],requested:0}});
        return route.fulfill({json:{product:{id,name:`库存商品${id}`},physical_estimate:5,local_stock:5,available_estimate:4,open_order_demand:1,fbp_reserved:0,orders:[],purchases:[],batches:[],movements:[],sources:[],actions:[],flow_summary:{physical:5,safety:1,free:3,orders:[],applications:[]}}});
      }
      if(url.pathname==='/api/inventory-flow/sync')return route.fulfill({json:{running:false,result:{ok:true}}});
      if(url.pathname.startsWith('/api/'))return route.fulfill({json:{rows:[]}});
      const asset=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(n=>n.endsWith('.css'))):url.pathname.slice(1);
      return route.fulfill({contentType:asset.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,asset))});
    });
    await page.goto('http://localhost:8788/admin.html');
    const first=page.locator('.inventory-identity').filter({hasText:'库存商品11'}),second=page.locator('.inventory-identity').filter({hasText:'库存商品12'});
    for(const card of [first,second])for(const label of ['库存明细','更新本地库存','修改库存'])await card.getByRole('button',{name:label,exact:true}).waitFor();
    assert.equal(requests.length,0,'list rendering does not load per-product ledgers');
    await page.locator('.el-table__body-wrapper .el-scrollbar__wrap').evaluate(el=>{el.scrollLeft=el.scrollWidth;});
    await page.locator('.inventory-identities').screenshot({path:'.verification/order-multi-actions.png',animations:'disabled'});
    await second.getByRole('button',{name:'修改绑定',exact:true}).click();assert.equal(await page.locator('#event').innerText(),'bind:1:SKU-12');
    await second.getByRole('button',{name:'修改库存',exact:true}).click();assert.equal(await page.locator('#event').innerText(),'edit:12');
    await first.getByRole('button',{name:'修改绑定 ▾',exact:true}).click();await page.getByRole('menuitem',{name:'SKU SKU-11-ALT',exact:true}).click();assert.equal(await page.locator('#event').innerText(),'bind:1:SKU-11-ALT');
    await second.getByRole('button',{name:'库存明细',exact:true}).click();
    const detail=page.getByRole('dialog',{name:'库存明细与历史核对',exact:true});await detail.getByText('库存流转与占用',{exact:true}).waitFor();
    assert.ok(requests.some(q=>new URLSearchParams(q).get('product_id')==='12'));
    assert.ok(requests.every(q=>new URLSearchParams(q).get('product_id')==='12'),'second product never defaults to first product');
    await detail.getByRole('button',{name:'Close this dialog'}).click();await detail.waitFor({state:'hidden'});
    await second.getByRole('button',{name:'更新本地库存',exact:true}).click();
    const stocktake=page.getByRole('dialog',{name:'更新本地库存',exact:true});await stocktake.getByText('库存商品12',{exact:true}).waitFor();
    assert.ok(requests.some(q=>{const p=new URLSearchParams(q);return p.get('product_id')==='12'&&p.get('include_flow')==='0';}));
    await stocktake.getByRole('button',{name:'取消',exact:true}).click();await stocktake.waitFor({state:'hidden'});
    const combo=page.locator('.inventory-identity').filter({hasText:'组合商品20'});
    await combo.getByRole('button',{name:'更新本地库存',exact:true}).click();
    await page.getByRole('menuitem',{name:'1-22 · 子产品22',exact:true}).click();
    await stocktake.getByText('库存商品22',{exact:true}).waitFor();
    assert.equal(new URLSearchParams(requests.at(-1)).get('product_id'),'22','combo stocktake selects its own physical component');
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});
