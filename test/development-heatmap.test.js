import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDevelopmentHeatmap } from '../frontend/admin/utils/development-heatmap.js';
const range = ['2026-09-01', '2026-09-30'];
const task = (id, models, extra = {}) => ({ id, type:'product_development', created_at:'2026-09-10 00:00:00', due_at:'2026-10-01', development_plan:{brand:'TENET',category:'钥匙壳',models}, ...extra });
const model = (id, count, date = '2026-09-10 00:00:00', draftId = id) => ({model_id:id,model:`T${id}`,target:10,drafts:[{id:draftId,count,created_at:date}]});
test('heatmap uses Beijing calendar boundaries and excludes next-month drafts', () => {
 const result = buildDevelopmentHeatmap([task(1,[model(4,3,'2026-08-31 16:00:00'),model(7,9,'2026-09-30 16:00:00')])],{range});
 assert.equal(result.total,3);
 assert.equal(result.rows[0].label,'TENET · T4');
});
test('actual draft counts deduplicate repeated task links and reject ambiguous coordinates', () => {
 const rows = [task(1,[model(4,3)]),task(2,[model(4,3)])];
 let result = buildDevelopmentHeatmap(rows,{range});
 assert.equal(result.total,3); assert.equal(result.taskCount,2);
 assert.equal(result.cell(result.rows[0],'钥匙壳').tasks.size,2);
 result = buildDevelopmentHeatmap([...rows,task(3,[model(7,3,undefined,4)])],{range});
 assert.equal(result.total,0); assert.equal(result.conflicts,1);
});
test('model task cells can overlap but global task count and brand cells deduplicate', () => {
 const rows = [task(1,[model(4,2),model(7,3)])];
 let result = buildDevelopmentHeatmap(rows,{range,metric:'tasks',time:'created'});
 assert.equal(result.rows.length,2); assert.equal(result.total,1); assert.equal(result.columns[0].total,1);
 result = buildDevelopmentHeatmap(rows,{range,metric:'tasks',time:'created',dimension:'brand'});
 assert.equal(result.cell(result.rows[0],'钥匙壳').value,1);
 assert.equal(buildDevelopmentHeatmap(rows,{range,metric:'target',time:'due'}).total,0);
 assert.equal(buildDevelopmentHeatmap(rows,{range,metric:'target',time:'created'}).total,20);
});
test('rows and columns are sorted by current filtered counts, non-car is explicit', () => {
 const rows = [task(1,[model(4,3)]),task(2,[model(7,12)],{development_plan:{brand:'非汽车',scope:'non_automotive',category:'收纳袋',models:[model(0,12)]}}),{id:3,type:'product_development',created_at:'2026-09-01 00:00:00'}];
 const result = buildDevelopmentHeatmap(rows,{range});
 assert.equal(result.rows[0].label,'非汽车'); assert.equal(result.columns[0].label,'收纳袋');
 assert.equal(result.unclassified,1);
 assert.equal(buildDevelopmentHeatmap(rows,{range,scope:'non_automotive'}).taskCount,1);
 assert.equal(buildDevelopmentHeatmap(rows,{range,scope:'unknown',metric:'tasks',time:'created'}).total,1);
});
test('idea tasks with brand metadata and full draft rows participate without inventing a model', () => {
 const rows=[{id:9,idea_id:4,type:'product_development',development_brand:'TENET',development_category:'门槛条',development_created_at:'2026-08-01 00:00:00',created_at:'2026-09-16 00:00:00',target:20,development_drafts:[{id:500,count:8,created_at:'2026-09-10 00:00:00'}]}];
 const result=buildDevelopmentHeatmap(rows,{range});
 assert.equal(result.total,8); assert.equal(result.rows[0].label,'TENET · 未指定车型');
 assert.equal(buildDevelopmentHeatmap(rows,{range,metric:'tasks',time:'created'}).total,0);
});
