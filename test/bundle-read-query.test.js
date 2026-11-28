import test from 'node:test';
import assert from 'node:assert/strict';
import {bundleReadQuery} from '../src/services/bundle-read-query.js';
test('one display request deduplicates identical reads without sharing mutable rows',async()=>{
 let calls=0;const source=async()=>{calls++;await new Promise(setImmediate);return[{quantity:5}];};const q=bundleReadQuery(source);const [a,b]=await Promise.all([q('SELECT stock',[2]),q('SELECT stock',[2])]);assert.equal(calls,1);a[0].quantity=0;assert.equal(b[0].quantity,5);await q('SELECT stock',[3]);assert.equal(calls,2);await bundleReadQuery(source)('SELECT stock',[2]);assert.equal(calls,3);
});
