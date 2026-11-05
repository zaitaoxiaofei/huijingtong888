import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';

test('queue batches keep partial failures retryable, receipts only take actual quantities, and free purchase searches exact stock',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const calls=[],purchases=[],searches=[],now='2026-11-01 01:00:00';let failed=false;
 const stock={101:-1,102:0};
 const rows=[{id:11,product_id:101,product_name:'负账面配件',inventory_number:'1-101',quantity:25},{id:12,product_id:102,product_name:'部分到货配件',inventory_number:'1-102',quantity:5},{id:13,product_id:103,product_name:'待核对套装',quantity:2,review_required:true}].map(row=>({...row,order_no:'PO-'+row.id,updated_at:now,purchased_at:now,received_at:null,components:[{product_id:row.product_id,name:row.product_name,quantity:row.quantity,stock_unit:'件',per_set_quantity:1}],affected_bundles:[]}));
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(req.method==='POST'){
   let text='';req.on('data',c=>text+=c);req.on('end',()=>{
    const body=JSON.parse(text);calls.push({path:url.pathname,body});
    if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){
     if(body.id===12&&!failed){failed=true;res.statusCode=503;send({error:'演示临时失败'});return;}
     rows.find(r=>r.id===body.id).received_at=now;send({ok:true});return;
    }
    if(url.pathname==='/api/inventory-workflow/receipts/preview'){
     const quantity=body.records.reduce((sum,r)=>sum+r.quantity,0),before=stock[body.product_id];send({quantity,physical_before:before,physical_after:before+quantity,available_before:Math.max(0,before),available_after:Math.max(0,before+quantity),ledger_warning:before<0,requires_count:false,revision:'revision-'+body.product_id});return;
    }
    if(url.pathname==='/api/inventory-workflow/receipts'){
     for(const r of body.records){const row=rows.find(saved=>saved.id===r.id);stock[body.product_id]+=r.quantity;row.quantity-=r.quantity;}
     send({ok:true});return;
    }
    if(url.pathname==='/api/procurement/purchases'){purchases.push(body);send({ok:true});return;}
    send({ok:true});
   });return true;
  }
  if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){
   const selected=rows.filter(r=>r.quantity>0&&(url.searchParams.get('status')==='open'?!r.received_at:!!r.received_at));send({rows:url.searchParams.get('summary_only')?[]:selected,total:selected.length,summary:{open:rows.filter(r=>r.quantity&&!r.received_at).length,arrived:rows.filter(r=>r.quantity&&r.received_at).length}});return true;
  }
  if(url.pathname==='/api/inventory-workflow/receipts/context'){
   const id=Number(url.searchParams.get('product_id'));send({rows:rows.filter(r=>r.product_id===id&&r.quantity>0),physical:stock[id],available:Math.max(0,stock[id])});return true;
  }
  if(url.pathname==='/api/inventory-workflow/alerts'){send({rows:[],total:0,meta:{required:0,advisory:0,review:0},snapshot:{available:true}});return true;}
  if(url.pathname==='/api/products'){searches.push(Object.fromEntries(url.searchParams));send({rows:[{id:501,name:'自主选购物料',inventory_number:'1-501'}],total:1});return true;}
  if(url.pathname==='/api/inventory-workflow'&&url.searchParams.get('view')==='components'){send({rows:[{is_bundle:false,components:[{id:501,name:'自主选购物料'}]}]});return true;}
  if(url.pathname==='/api/people'){send([{id:1,name:'演示采购',active:1}]);return true;}
  return false;
 }});
 const script=`const task=await taskSpace(${JSON.stringify(process.env.BROWSER_TASK_SPACE||'bulk-receive-free-purchase-20261102')});console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html?bulkqa='+Date.now()+'#/procurement/workspace');await page.waitForSelector('[data-task="required"]');console.log(await page.snapshot());
 await page.click('text="自由采购"');await page.waitForSelector('.batch-add');await page.click('text="＋ 添加库存商品"');await page.waitForSelector('.batch-inventory-picker');console.log(await page.snapshot());await page.click('.batch-inventory-picker [aria-label="搜索方式"]');await page.click('text="库存编号精确"');await page.fill('.batch-inventory-picker input[aria-label="搜索内容"]','1-501');await page.click('.batch-inventory-picker button:has-text("查询")');await page.waitForSelector('text="加入采购"');await page.click('text="加入采购"');await page.waitForSelector('text="已加入"');await page.click('text="完成添加"');await page.waitForSelector('input[aria-label="自主选购物料采购件数"]');await page.fill('input[aria-label="自主选购物料采购件数"]','3');await page.fill('input[aria-label="自主选购物料实际货款"]','30');await page.press('input[aria-label="自主选购物料实际货款"]','Tab');await page.click('text="确认登记采购"');await page.waitForFunction(()=>!document.querySelector('.batch-add'));
 await page.click('[data-task="incoming"]');await page.waitForSelector('.inventory-batch-queue tbody tr');console.log(await page.snapshot());await page.click('.inventory-batch-queue .el-table__header-wrapper .el-checkbox');await page.click('button:has-text("批量确认到货（2）")');await page.waitForSelector('.purchase-batch-action textarea');await page.fill('.purchase-batch-action textarea','本次已全部签收');await page.click('text="确认批量到货"');await page.waitForSelector('text="重试未完成项"');await page.waitForFunction(()=>document.querySelector('.purchase-batch-action')?.textContent.includes('已完成 1 / 2'));console.log(await page.snapshot());await page.click('text="重试未完成项"');await page.waitForFunction(()=>document.querySelector('.purchase-batch-action')?.textContent.includes('已完成 2 / 2'));await page.click('.el-dialog__footer button:has-text("关闭")');
 await page.click('[data-task="receiving"]');await page.waitForSelector('.inventory-batch-queue tbody tr');await page.click('.inventory-batch-queue .el-table__header-wrapper .el-checkbox');await page.click('button:has-text("批量登记入库（2）")');await page.waitForSelector('input[aria-label="批次 12 实收数量"]');await page.fill('input[aria-label="批次 12 实收数量"]','3');await page.press('input[aria-label="批次 12 实收数量"]','Tab');await page.click('.purchase-quantity-difference .el-select');await page.click('text="分批到货，余量继续待到货"');await page.fill('input[placeholder="如部分到货、验货不合格"]','另外2件尚未到货');await page.click('text="核对数量，查看入库影响"');await page.waitForSelector('text="确认批量入库"');await page.evaluate(()=>{if(document.querySelector('.purchase-batch-action').textContent.includes('核实当前实物总数'))throw Error('Unexpected stocktake requirement');});console.log(await page.snapshot());await page.click('text="确认批量入库"');await page.waitForFunction(()=>document.querySelector('.purchase-batch-action')?.textContent.includes('已完成 2 / 2'));await page.evaluate(()=>{if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});console.log('BULK_RECEIVING_FREE_PURCHASE_OK');await task.finish({keep:[]});`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:165000,maxBuffer:1024*1024});run.child.stdin.end();let result;try{result=await run;}catch(e){await fs.mkdir('.verification',{recursive:true});await fs.writeFile('.verification/bulk-receive-browser.log',(e.stdout||'')+(e.stderr||''));throw e;}
  const log=result.stdout+result.stderr;await fs.mkdir('.verification',{recursive:true});await fs.writeFile('.verification/bulk-receive-browser.log',log);assert.match(log,/BULK_RECEIVING_FREE_PURCHASE_OK/);
  assert.ok(searches.some(search=>search.searchMode==='inventory_id'&&search.query==='1-501'));assert.equal(purchases.length,1);assert.equal(purchases[0].items[0].product_id,501);assert.equal(purchases[0].items[0].quantity,3);
  const arrival=calls.filter(r=>r.path.endsWith('purchase-arrivals'));assert.deepEqual(arrival.map(r=>r.body.id),[11,12,12]);assert.equal(arrival[1].body.request_key,arrival[2].body.request_key);
  const receipts=calls.filter(r=>r.path==='/api/inventory-workflow/receipts');assert.equal(receipts.length,2);assert.ok(receipts.every(r=>r.body.receipt_mode==='new_arrival'&&!('counted_quantity' in r.body)));assert.equal(stock[101],24);assert.equal(stock[102],3);assert.equal(rows.find(r=>r.id===12).quantity,2);
 }finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});
