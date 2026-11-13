import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Writable} from 'node:stream';
import test from 'node:test';
import {createStaticHandler} from '../src/http/static.js';

test('only the ERP document permits same-origin cameras, including HEAD, compressed and cached responses',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'erp-camera-policy-'));
 try{
  await fs.writeFile(path.join(root,'admin.html'),'<html>ERP</html>');
  await fs.writeFile(path.join(root,'other.html'),'<html>Other</html>');
  const serve=createStaticHandler(root);
  async function request(url,method='GET',headers={}){
   const res=new Writable({write(_chunk,_encoding,next){next();}});
   res.writeHead=(status,value)=>{res.status=status;res.headers=value;};
   const done=once(res,'finish');serve(url,{method,headers},res);await done;return res;
  }
  const first=await request('/admin.html');
  for(const res of [first,await request('/admin.html','HEAD'),await request('/admin.html','GET',{'accept-encoding':'gzip'}),await request('/admin.html','GET',{'if-none-match':first.headers.ETag}),await request('/')]){
   assert.equal(res.headers['Permissions-Policy'],'camera=(self), microphone=(), geolocation=()');
   assert.equal(res.headers['X-Frame-Options'],'DENY');
  }
  assert.equal((await request('/other.html')).headers['Permissions-Policy'],'camera=(), microphone=(), geolocation=()');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
