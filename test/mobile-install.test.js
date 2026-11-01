import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {Writable} from 'node:stream';
import {once} from 'node:events';
import {createStaticHandler} from '../src/http/static.js';
test('mobile install manifest points at the authorized mobile shell and serves valid standalone icons',async()=>{
 const root=new URL('../public/',import.meta.url).pathname;
 const manifest=JSON.parse(await readFile(root+'mobile.webmanifest','utf8'));
 assert.equal(manifest.start_url,'/admin.html#/mobile');assert.equal(manifest.display,'standalone');
 for(const icon of manifest.icons){const bytes=await readFile(root+icon.src);assert.equal(bytes.subarray(1,4).toString(),'PNG');const size=Number(icon.sizes.split('x')[0]);assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);}
 const chunks=[],response=new Writable({write(chunk,encoding,next){chunks.push(Buffer.from(chunk));next();}});
 response.writeHead=(status,headers)=>{response.statusCode=status;response.headers=headers;};
 const finished=once(response,'finish');createStaticHandler(root)('/mobile.webmanifest',{method:'GET',headers:{}},response);await finished;
 assert.equal(response.statusCode,200);assert.match(response.headers['Content-Type'],/^application\/manifest\+json/);assert.equal(JSON.parse(Buffer.concat(chunks)).start_url,manifest.start_url);
});
