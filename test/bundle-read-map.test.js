import test from 'node:test';
import assert from 'node:assert/strict';
import {mapBundleReads} from '../src/services/bundle-read-map.js';
test('display reads overlap with bounded concurrency and preserve component order',async()=>{
 let active=0,peak=0;const result=await mapBundleReads([1,2,3,4],async id=>{active++;peak=Math.max(peak,active);await new Promise(setImmediate);active--;return id;});assert.equal(peak,2);assert.deepEqual(result,[1,2,3,4]);
});
test('transaction reads remain serial and failures propagate',async()=>{
 let active=0,peak=0;await mapBundleReads([1,2],async()=>{active++;peak=Math.max(peak,active);await new Promise(setImmediate);active--;},1);assert.equal(peak,1);await assert.rejects(mapBundleReads([1],async()=>{throw Error('denied');}),/denied/);
});
