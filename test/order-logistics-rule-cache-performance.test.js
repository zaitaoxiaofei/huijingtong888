import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { orderLogisticsEvidence } from '../src/services/order-logistics-classification.js';
const source=readFileSync(new URL('../src/services/mysql-cutover.js',import.meta.url),'utf8');
const definition=source.match(/^function orderLogisticsMatchCacheKeyMysql\([^]*?^}/m)[0];
const key=vm.runInNewContext(definition+'\norderLogisticsMatchCacheKeyMysql',{createHash,orderLogisticsEvidence});
const prefix=methods=>createHash('sha1').update(methods.map(method=>`${method.value||''}:${method.label||''}:${(method.warehousePatterns||[]).join('|')}`).join(';')).update('\n');
test('batch rule prefix preserves every existing logistics cache key including raw fallback and changed settings',()=>{
 for(const methods of [[],[{value:'a',label:'OGL',warehousePatterns:['经济','OGL']}],[{label:'FBP',warehousePatterns:[]}]]){
  const hash=prefix(methods);
  for(const raw_json of [null,'invalid','{}','{"delivery_method":{"name":"OGL Economy Extra Small"}}','{"raw":{},"delivery_method":{"name":"ignored"}}','{"raw":{"delivery_method":{"warehouse":"Hunchun"}}}'])for(const tracking_number of ['',null,'OGL-123','CEL-456']){
   const row={raw_json,tracking_number};assert.equal(key(row,methods,hash),key(row,methods));
  }
 }
 const row={tracking_number:'OGL-123'};assert.notEqual(key(row,[{label:'A'}],prefix([{label:'A'}])),key(row,[{label:'B'}],prefix([{label:'B'}])));
});
test('31k-row hash benchmark produces the same digest with one rule-prefix computation',t=>{
 const methods=Array.from({length:100},(_,i)=>({value:'rule_'+i,label:'Rule '+i,warehousePatterns:['warehouse '+i,'物流 '+i]}));
 const rows=Array.from({length:31121},(_,i)=>({tracking_number:'tracking-'+i,raw_json:'{"delivery_method":{"name":"OGL Economy Extra Small"}}'}));
 const time=performance.now();const a=rows.map(row=>key(row,methods));const baseline=performance.now()-time;const hash=prefix(methods),start=performance.now();const b=rows.map(row=>key(row,methods,hash));const candidate=performance.now()-start;assert.deepEqual(b,a);t.diagnostic(JSON.stringify({rows:rows.length,rules:methods.length,baseline_ms:+baseline.toFixed(1),candidate_ms:+candidate.toFixed(1)}));
});
