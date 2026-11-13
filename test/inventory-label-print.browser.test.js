import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { startLabelPrintPreview } from './fixtures/inventory-label-print-preview.js';

test('single and batch inventory labels print immediately and download exact page counts at 70x30mm', {
  skip: process.env.RUN_TASK_BROWSER_TESTS !== '1', timeout: 120000
}, async () => {
  const { server, calls } = await startLabelPrintPreview();
  const output = path.resolve('.verification');
  await fs.mkdir(output, { recursive:true });
  const script = `
const task=await taskSpace('inventory-metrics-20261113'),page=task.page('p1');
await page.goto('http://[::1]:8788/admin.html?labels='+Date.now()+'#/inventory/products');
await page.waitForSelector('.product-inventory-number');console.log('LIST_READY');
await page.waitForFunction(()=>document.querySelector('.inventory-value-cell').textContent.includes('820.00'));
await page.evaluate(()=>{
 const rows=[...document.querySelectorAll('.el-table__body-wrapper tr')];
 if(document.querySelectorAll('.product-inventory-number').length!==4)throw Error('Duplicate inventory numbers');
 const headers=[...document.querySelectorAll('.el-table__header-wrapper th')].map(n=>n.textContent.trim());for(const label of ['销售数量','采购数量','历史出库数量'])if(!headers.includes(label))throw Error('Missing quantity header '+label);
 const metrics=rows[0].querySelectorAll('.metric-cell-link');if(metrics.length!==3)throw Error('Missing unified metrics');
 if(JSON.stringify([...metrics].map(n=>n.querySelector('strong').textContent.trim()))!==JSON.stringify(['3 件','10 件','5 件']))throw Error('Metrics do not lead with quantities');
 for(const metric of metrics){if(getComputedStyle(metric).backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('Metric background not transparent');}
 for(const b of rows[0].querySelectorAll('.inventory-action-row:last-child>button,.product-info-bottom button')){if(b.classList.contains('is-link')||!b.classList.contains('is-plain'))throw Error('Action must be a bordered button');}
 document.documentElement.dataset.theme='dark';for(const metric of metrics){if(getComputedStyle(metric).backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('Dark metric background not transparent');}
 for(const row of rows){
  const actions=[...row.querySelectorAll('.inventory-action-row:first-child button')].map(n=>n.textContent.trim());
  if(JSON.stringify(actions)!==JSON.stringify(['打印标签','更新库存','历史版本']))throw Error('Action order '+actions);
  if(row.querySelectorAll('.product-info-bottom button').length!==1||row.querySelector('.inventory-actions').textContent.includes('库存明细'))throw Error('Duplicate details');
 }
 if(!rows[1].textContent.includes('本地 ¥800.00')||!rows[1].textContent.includes('FBP 库存未完整同步'))throw Error('Missing partial valuation');
 const open=window.open.bind(window);
 window.open=(...args)=>{const target=open(...args);if(target){target.print=()=>{window.labelPrintCalls=(window.labelPrintCalls||0)+1;window.labelPrintedPages=target.document.querySelectorAll('#inventory-print-pages>img').length;};}return target;};
});
await page.click('.inventory-actions .inventory-action-row:first-child button:first-child >> nth=0');
await page.waitForSelector('.inventory-label-preview');console.log('SINGLE_READY');
if(await page.evaluate(()=>document.querySelector('input[aria-label="2-6-7 标签数量"]').value)!=='20')throw Error('Single label count must default to local physical stock');
await page.evaluate(async()=>{const img=document.querySelector('.inventory-label-preview');await img.decode();const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(437,100,360,1).data;let transitions=0;for(let i=4;i<pixels.length;i+=4)if((pixels[i]<128)!==(pixels[i-4]<128))transitions++;if(transitions<30)throw Error('Barcode bars missing from label preview');});
await page.fill('input[aria-label="2-6-7 标签数量"]','2');await page.press('input[aria-label="2-6-7 标签数量"]','Tab');
await page.click('.inventory-label-dialog .el-dialog__footer button:last-child');
await page.waitForFunction(()=>window.labelPrintedPages===2);console.log('SINGLE_PRINTED');
const imageData=await page.evaluate(()=>document.querySelector('.inventory-label-preview').src);const imageFs=await import('node:fs/promises');await imageFs.writeFile(${JSON.stringify(path.join(output,'label-barcode.png'))},Buffer.from(imageData.split(',')[1],'base64'));
const singleDownload=page.waitForEvent('download');await page.click('.inventory-label-dialog .el-dialog__footer button:nth-child(2)');
await (await singleDownload).saveAs(${JSON.stringify(path.join(output,'label-single.pdf'))});
await page.click('.inventory-label-dialog .el-dialog__footer button:first-child');
await page.waitForFunction(()=>!document.querySelector('.inventory-label-dialog'));
await page.fill('input[aria-label="搜索内容"]','2-6-7');await page.press('input[aria-label="搜索内容"]','Enter');
await page.waitForFunction(()=>document.querySelectorAll('.product-inventory-number').length===1&&document.querySelector('.product-inventory-number').textContent.trim()==='2-6-7');
await page.waitForFunction(()=>[...document.querySelectorAll('.el-table__body-wrapper .product-cell img')].some(img=>img.complete&&img.naturalWidth>0));
await page.click('.inventory-search-actions button:has-text("重置")');await page.waitForFunction(()=>document.querySelectorAll('.product-inventory-number').length===4);
await page.click('.el-table__body-wrapper tr:first-child .el-checkbox');
await page.click('.el-table__body-wrapper tr:nth-child(2) .el-checkbox');
await page.click('.inventory-search-actions button:has-text("打印标签")');
await page.waitForSelector('input[aria-label="2-20-8 标签数量"]');console.log('BATCH_READY');
if(await page.evaluate(()=>[...document.querySelectorAll('.inventory-label-dialog input[role="spinbutton"]')].every(input=>input.value==='20'))!==true)throw Error('Batch label counts must default to each local physical stock');
await page.fill('input[aria-label="2-6-7 标签数量"]','2');await page.press('input[aria-label="2-6-7 标签数量"]','Tab');
await page.fill('input[aria-label="2-20-8 标签数量"]','3');await page.press('input[aria-label="2-20-8 标签数量"]','Tab');
const popupWait=page.waitForEvent('popup');
await page.click('.inventory-label-dialog .el-dialog__footer button:last-child');
const printed=await popupWait;
await page.waitForFunction(()=>window.labelPrintedPages===5&&window.labelPrintCalls===2);
const printPdf=await printed.cdp('Page.printToPDF',{preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
const fs=await import('node:fs/promises');await fs.writeFile(${JSON.stringify(path.join(output,'label-browser-print.pdf'))},Buffer.from(printPdf.data,'base64'));
const batchDownload=page.waitForEvent('download');await page.click('.inventory-label-dialog .el-dialog__footer button:nth-child(2)');
await (await batchDownload).saveAs(${JSON.stringify(path.join(output,'label-batch.pdf'))});
await page.screenshot({path:${JSON.stringify(path.join(output,'label-batch.png'))}});
await page.fill('input[aria-label="2-6-7 标签数量"]','4');await page.press('input[aria-label="2-6-7 标签数量"]','Tab');
await page.waitForFunction(()=>!document.querySelector('.label-print-ready'));
const updated=page.waitForEvent('download');await page.click('.inventory-label-dialog .el-dialog__footer button:nth-child(2)');
await (await updated).saveAs(${JSON.stringify(path.join(output,'label-updated.pdf'))});
await page.evaluate(()=>{if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));window.dispatchEvent(new Event('erp:auth-scope-changed'));});
await page.waitForFunction(()=>!document.querySelector('.inventory-label-dialog'));
console.log('INVENTORY_LABEL_PRINT_OK');
`;
  try {
    const result = await promisify(execFile)('ego-browser', ['nodejs','-e',script], { timeout:110000,maxBuffer:1024*1024 });
    await fs.writeFile(path.join(output,'inventory-label-browser.log'),result.stdout+result.stderr);
    assert.match(result.stdout+result.stderr,/INVENTORY_LABEL_PRINT_OK/);
    for (const [file, count] of [['label-single.pdf',2],['label-batch.pdf',5],['label-updated.pdf',7],['label-browser-print.pdf',5]]) {
      const pdf = await PDFDocument.load(await fs.readFile(path.join(output,file)));
      assert.equal(pdf.getPageCount(),count);
      for(const page of pdf.getPages()) {
        assert.ok(Math.abs(page.getWidth()*25.4/72-70)<0.2);
        assert.ok(Math.abs(page.getHeight()*25.4/72-30)<0.2);
      }
    }
    assert.equal(calls.filter(call=>call.method!=='GET').length,0,'label printing never writes inventory');
  } finally { await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true}); }
});
