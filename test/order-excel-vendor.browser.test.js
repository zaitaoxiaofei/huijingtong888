import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('the production spreadsheet chunk still writes and reads a workbook after isolation',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:90000},async()=>{
 const root=new URL('../public/vue-apps/',import.meta.url),manifest=JSON.parse(await readFile(new URL('.vite/manifest.json',root),'utf8'));
 const item=Object.values(manifest).find(item=>/\/vendor-exceljs-[^/]+\.js$/.test(item.file));assert.ok(item);
 const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><meta charset="utf-8"><title>Spreadsheet chunk verification</title><p>仅本地构建验证</p>');}
  if(!/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(req.url||'')){res.statusCode=404;return res.end();}
  try{res.setHeader('content-type','text/javascript');res.end(await readFile(new URL(req.url.slice(1),root)));}catch{res.statusCode=404;res.end();}
 });await new Promise((resolve,reject)=>server.once('error',reject).listen(8788,'127.0.0.1',resolve));
 try{
  const space=process.env.BROWSER_TASK_SPACE||'order-excel-vendor-verification';
  const script=`const task=await taskSpace(${JSON.stringify(space)});const page=task.page('p1');await page.goto('http://localhost:8788/');console.log('EXCEL_ROUNDTRIP',await page.evaluate(async path=>{const mod=await import(path),loader=Object.values(mod).find(value=>typeof value==='function'),excel=loader();const workbook=new excel.Workbook(),sheet=workbook.addWorksheet('采购');sheet.addRow(['库存','数量']);sheet.addRow(['配件测试',13]);const data=await workbook.xlsx.writeBuffer(),restored=new excel.Workbook();await restored.xlsx.load(data);if(restored.worksheets[0].getCell('A2').value!=='配件测试'||restored.worksheets[0].getCell('B2').value!==13)throw Error('Workbook mismatch');return {bytes:data.byteLength,rows:restored.worksheets[0].rowCount};},${JSON.stringify('/'+item.file)}));console.log(await page.snapshot());`;
  const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:80000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;assert.match(stdout+stderr,/EXCEL_ROUNDTRIP/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
