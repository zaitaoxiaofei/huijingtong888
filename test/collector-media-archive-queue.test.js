import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {parse} from 'acorn';
const source=readFileSync(new URL('../src/services/listing-automation.js',import.meta.url),'utf8');
const nodes=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.map(n=>n.type==='ExportNamedDeclaration'?n.declaration:n).filter(n=>n?.type==='FunctionDeclaration');
function fixture(fail=false){
 let active=0,peak=0;const requests=[];
 const context=vm.createContext({Map,Promise,Object,Array,Error,
  ossStorageConfig:()=>({enabled:true}),isCollectorMediaSource:v=>/^https:\/\//.test(v),isCollectorMediaField:k=>/^(images|url)$/.test(k),
  mapWithConcurrency:async(rows,limit,work)=>{let cursor=0;const result=[];await Promise.all(Array.from({length:Math.min(limit,rows.length)},async()=>{while(cursor<rows.length){const i=cursor++;result[i]=await work(rows[i],i)}}));return result},
  materializeListingMediaUrl:async(url,metadata)=>{requests.push(url);assert.equal(metadata.require_managed_oss,true);active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,3));if(fail)throw Error('origin timeout');return 'https://managed.example/'+url.split('/').pop()}finally{active--}}
 });
 for(const name of ['createCollectorMediaArchiveQueue','archiveCollectorMediaValue','archiveCollectedProductMediaValue','archiveCollectedProductMedia']){const n=nodes.find(n=>n.id.name===name);assert.ok(n);vm.runInContext(source.slice(n.start,n.end),context)}
 return{archive:value=>context.archiveCollectedProductMedia(value),requests,peak:()=>peak};
}
test('gallery duplicates across template, editable payload and provenance download once and share a global limit',async()=>{
 const f=fixture(),images=Array.from({length:8},(_,i)=>`https://public.example/${i}.jpg`);
 const result=await f.archive({sku:'fixture',images,editable_payload:{images},source_raw:{variants:[{images},{images}]}});
 assert.equal(f.requests.length,8);assert.equal(new Set(f.requests).size,8);assert.ok(f.peak()<=3);assert.ok(f.peak()>1);
 assert.deepEqual([...result.images],[...result.editable_payload.images]);assert.deepEqual([...result.images],[...result.source_raw.variants[0].images]);
 assert.ok(result.images.every(url=>url.startsWith('https://managed.example/')));
});
test('a failed shared image rejects archival without substituting an external URL or dropping the image',async()=>{
 const f=fixture(true),url='https://public.example/a.jpg';
 await assert.rejects(f.archive({sku:'fixture',images:[url],editable_payload:{images:[url]}}),/origin timeout/);
 assert.equal(f.requests.length,1);
});
