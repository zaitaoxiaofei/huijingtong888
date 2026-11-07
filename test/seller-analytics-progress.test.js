import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectionRefreshGate} from '../frontend/admin/utils/seller-analytics-progress.js';
const run=(n,status='running')=>({id:'fixture',completed_count:n,status});
test('first received data is visible before completion, repeated progress is bounded',()=>{
 let now=1000;const check=createCollectionRefreshGate({clock:()=>now});
 assert.equal(check(run(0),run(0)),false);
 assert.equal(check(run(0),run(1)),true);
 now+=5000;assert.equal(check(run(1),run(20)),false);
 now+=15000;assert.equal(check(run(20),run(30)),true);
 now+=20000;assert.equal(check(run(30),run(30)),false);
 assert.equal(check(run(30),run(31,'success')),true);
});
test('finished, failed and cancelled runs always refresh their retained received data',()=>{
 const check=createCollectionRefreshGate({clock:()=>1000});
 assert.equal(check(run(1),run(2)),true);
 assert.equal(check(run(2),run(2,'failed')),true);
 assert.equal(check(run(2),run(2,'cancelled')),true);
 assert.equal(check(run(2),undefined),true);
 assert.equal(check(undefined,run(2)),false);
});
