import test from 'node:test';
import assert from 'node:assert/strict';
import { oglOfficialDateRange, oglOfficialCreatedAt } from '../src/services/ogl-official-range.js';
test('official ranges use seven inclusive Beijing days, explicit month ranges and strict bounded dates',()=>{
  const range=oglOfficialDateRange({},new Date('2026-10-21T16:01:00Z'));
  assert.equal(range.date_from,'2026-10-16');assert.equal(range.date_to,'2026-10-22');assert.equal(range.days.length,7);
  assert.deepEqual(oglOfficialDateRange({date:'2026-10-21'}).days,['2026-10-21']);
  assert.equal(oglOfficialDateRange({date_from:'2026-10-01',date_to:'2026-10-31'}).days.length,31);
  for(const query of [{date:'2026-02-30'},{date_from:'2026-10-22',date_to:'2026-10-21'},{date_from:'2026-09-01',date_to:'2026-10-02'}])assert.throws(()=>oglOfficialDateRange(query),{statusCode:400});
});
test('official creation time is a real timestamp, never a guessed departure or date-only midnight',()=>{
  assert.equal(oglOfficialCreatedAt('2026-10-22T07:21:15.322672Z'),'2026-10-22T07:21:15.322672Z');
  for(const value of [undefined,'','2026-10-22','invalid'])assert.equal(oglOfficialCreatedAt(value),null);
});
