import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseQueueDays,purchaseQueueDayGroups,purchaseQueueDayAge,purchaseQueueBadgeTone} from '../frontend/admin/utils/purchase-queue-days.js';

test('queue age follows Beijing calendar midnight, including month and year boundaries',()=>{
  assert.equal(purchaseQueueDayAge('2026-11-04',new Date('2026-11-05T15:59:59Z')),1);
  assert.equal(purchaseQueueDayAge('2026-11-04',new Date('2026-11-05T16:00:00Z')),2);
  assert.equal(purchaseQueueDayAge('2026-12-31',new Date('2026-12-31T16:00:00Z')),1);
  assert.equal(purchaseQueueDayAge('2026-12-30',new Date('2026-12-31T16:00:00Z')),2);
  assert.equal(purchaseQueueDayAge('2024-02-28',new Date('2024-02-29T16:00:00Z')),2);
});

test('today and yesterday with pending batches are green, older pending batches red, and zero always gray',()=>{
  const now=new Date('2026-11-05T16:01:00Z');
  const days=purchaseQueueDays([{date:'2026-11-06',open:1},{date:'2026-11-05',open:12},{date:'2026-11-04',open:3},{date:'2026-01-01',open:0,arrived:40}],{now});
  const tone=date=>{const day=days.find(day=>day.date===date);return purchaseQueueBadgeTone(day.count,day.ageDays>=2);};
  assert.equal(tone('2026-11-06'),'recent');assert.equal(tone('2026-11-05'),'recent');assert.equal(tone('2026-11-04'),'overdue');assert.equal(days.some(day=>day.date==='2026-01-01'),false);
  assert.equal(purchaseQueueBadgeTone(0,true),'empty');assert.equal(purchaseQueueBadgeTone(5,false),'recent');
  const arrived=purchaseQueueDays([{date:'2026-01-01',open:0,arrived:40}],{now,status:'arrived'}).find(day=>day.date==='2026-01-01');
  assert.equal(purchaseQueueBadgeTone(arrived.count,arrived.ageDays>=2),'overdue');
});

test('only pending dates are grouped by month, oldest first, without hiding old work or reviving selected empty dates',()=>{
  const input=[{date:'2026-11-06',open:2},{date:'2025-12-31',open:1},{date:'2026-11-05',open:0,arrived:3},{date:'2026-01-01',open:4}];
  const days=purchaseQueueDays(input,{selectedDay:'2026-11-05'});
  assert.deepEqual(days.map(day=>day.date),['2025-12-31','2026-01-01','2026-11-06']);
  assert.deepEqual(purchaseQueueDayGroups(days).map(group=>[group.monthLabel,group.days.map(day=>day.dayLabel)]),[['2025年12月',['31号']],['2026年1月',['1号']],['2026年11月',['6号']]]);
  assert.deepEqual(purchaseQueueDays(input,{startDate:'2026-01-01',endDate:'2026-10-31'}).map(day=>day.date),['2026-01-01']);
  assert.equal(input[0].date,'2026-11-06','sorting does not change the API index');
});
