import assert from 'node:assert/strict';
import test from 'node:test';
import {fbpReceiptEvidence} from '../src/shared/fbp-receipt-evidence.js';
const row={quantity:30,listed_quantity:0,shipped_at:'2026-10-01 00:00:00',expected_arrival_at:'2026-10-06 00:00:00'};
const baseline={present:32,synced_at:'2026-10-01 00:00:00'};
test('stock plus recorded depletion suggests arrival and never confirms quantity',()=>{
 const value=fbpReceiptEvidence(row,baseline,{present:32,synced_at:'2026-10-06 00:00:00'},30,Date.parse('2026-10-07T00:00:00Z'));
 assert.equal(value.inferred_arrival,30);assert.equal(value.suspected,true);assert.equal(value.remaining,30);assert.match(value.review_label,/待确认/);assert.equal(row.listed_quantity,0);
});
test('unknown/stale snapshots remain unknown; overdue no-growth shipments require review',()=>{
 assert.equal(fbpReceiptEvidence(row,null,{present:32,synced_at:'2026-10-06 00:00:00'}).inferred_arrival,null);
 assert.equal(fbpReceiptEvidence(row,baseline,baseline).inferred_arrival,null);
 const r=fbpReceiptEvidence(row,baseline,{present:5,synced_at:'2026-10-06 00:00:00'},27,Date.parse('2026-10-07T00:00:00Z'));
 assert.equal(r.inferred_arrival,0);assert.equal(r.overdue,true);assert.match(r.review_label,/需复核/);
});
