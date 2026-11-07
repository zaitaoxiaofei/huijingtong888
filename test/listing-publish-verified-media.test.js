import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {parse} from "acorn";
const source=readFileSync(new URL("../src/services/listing-automation.js",import.meta.url),"utf8");
const fn=parse(source,{ecmaVersion:"latest",sourceType:"module"}).body.map(node=>node.declaration||node)
  .find(node=>node.id?.name==="assertPublishPayloadMediaReachable");
function fixture(ok){
  const probes=[];
  const url="https://public.example/image.png";
  const context=vm.createContext({
    tryRepairPayloadListingMediaReachability:async payload=>payload,
    normalizeArray:value=>Array.isArray(value)?value:[],uniqueStringValues:values=>[...new Set(values)],
    prewarmPublishMediaUrls:async()=>({total:1,image_results:[{url,ok}],failed_urls:ok?[]:[url]}),
    unreachablePublishMediaUrls:async urls=>{probes.push(...urls);return [];}
  });
  vm.runInContext(source.slice(fn.start,fn.end),context);
  return {probes,url,run:()=>context.assertPublishPayloadMediaReachable({items:[{primary_image:url,images:[]}]})};
}
test("two complete public image downloads cannot be invalidated by an unrelated later HEAD timeout",async()=>{
  const f=fixture(true);
  assert.equal((await f.run()).ok,true);
  assert.deepEqual(f.probes,[]);
});
test("a successful HEAD cannot override an incomplete full-image verification",async()=>{
  const f=fixture(false);
  await assert.rejects(f.run(),/Public media is not fully downloadable/);
  assert.deepEqual(f.probes,[f.url]);
});
