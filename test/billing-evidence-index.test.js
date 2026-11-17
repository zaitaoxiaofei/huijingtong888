import test from 'node:test';import assert from 'node:assert/strict';
import {billingEvidenceIndex} from '../src/services/billing-evidence-index.js';
test('indexed evidence matches child/parent scans, preserves row order and isolates shops',()=>{
 const financeRows=[{shop_id:1,posting_number:'10-2-1',id:1},{shop_id:2,posting_number:'10-2',id:2},{shop_id:1,posting_number:'10-2',id:3}];
 const siblings=[{shop_id:1,order_number:'10-2',posting_number:'10-2-1'},{shop_id:1,order_number:'other',posting_number:'10-2-3'},{shop_id:2,order_number:'10-2',posting_number:'10-2-2'},{shop_id:1,order_number:'different',posting_number:'10-20-1'}];
 const archives=[{id:3},{id:1},{id:2}],index=billingEvidenceIndex({financeRows,siblings,archives});
 assert.deepEqual(index.finance(1,['10-2','10-2-1','10-2']),[financeRows[0],financeRows[2]]);
 for(const shop of [1,2,3])for(const parent of ['10-2','10-20','other','unknown'])assert.deepEqual(index.siblings(shop,parent),siblings.filter(r=>r.shop_id===shop&&(r.order_number===parent||r.posting_number.startsWith(parent+'-'))));
 assert.deepEqual(index.archives([1,'3',1]),[archives[0],archives[1]]);assert.deepEqual(index.finance(1,['unknown']),[]);
});
test('annual evidence lookup avoids rescanning the whole batch while preserving every row',()=>{
 const n=20000,financeRows=Array.from({length:n},(_,i)=>({id:i,shop_id:i%3,posting_number:'P-'+i})),siblings=financeRows.map(r=>({...r,order_number:r.posting_number,posting_number:r.posting_number+'-1'})),archives=[{id:1}];
 const start=performance.now();let scanned=0;for(let i=0;i<2000;i++)scanned+=financeRows.filter(r=>r.shop_id===i%3&&r.posting_number==='P-'+i).length;const scanMs=performance.now()-start;
 const indexedAt=performance.now(),index=billingEvidenceIndex({financeRows,siblings,archives});let found=0;for(let i=0;i<2000;i++)found+=index.finance(i%3,['P-'+i]).length;const indexMs=performance.now()-indexedAt;
 assert.equal(found,scanned);assert.equal(found,2000);console.log(`Evidence lookup: full scans=${Math.round(scanMs)}ms, build+indexed reads=${Math.round(indexMs)}ms; rows=${n}, lookups=2000`);
});
