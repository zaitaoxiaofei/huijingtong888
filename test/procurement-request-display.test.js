import assert from 'node:assert/strict';
import test from 'node:test';
import {procurementRequestDisplay as display} from '../src/shared/procurement-request-display.js';
test('legacy rule-generated requests show system identity, order and retain the full audit note',()=>{
 const note='系统按真实订单缺口自动生成：87239716-1006-1 / SKU 6010797962；系统按最新现货、在途和优先级重新计算';
 const row=display({source_order_id:1,created_by_person_id:null,note,status:'cancelled'});
 assert.equal(row.applicant_name,'系统规则');assert.equal(row.reason_summary,'真实订单创建 · 87239716-1006-1');assert.equal(row.reason_detail,note);
});
test('real creators remain real people and unavailable historical names never become system identities',()=>{
 assert.equal(display({created_by_person_id:4,applicant_name:'仓库张',note:'人工申请'}).applicant_name,'仓库张');
 assert.equal(display({created_by_person_id:4,note:'系统按真实订单缺口自动生成：x'}).applicant_name,'历史申请人待核对');
 const row=display({applicant_name:'运营李',request_reason_note:'临时增加备货',note:'临时增加备货\n拒绝原因：重复采购'});
 assert.equal(row.reason_summary,'临时增加备货');assert.equal(row.rejection_summary,'重复采购');
});
