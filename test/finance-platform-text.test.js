import test from 'node:test';import assert from 'node:assert/strict';
import {platformInvoiceFacts,rechargedServiceFacts,paymentAdjustmentFacts} from '../src/services/finance-platform-text.js';
import {financeDocumentCategories} from '../src/shared/finance-document-categories.js';
import {readFileSync} from 'node:fs';import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
const row=(i,label,gross)=>`${i} ${label} - 642 pcs 1.00 ${gross} ${gross} ex.excs w/o VAT — ${gross}`;
test('one-line legacy advertising and Russian commission invoices retain their printed amounts',()=>{
 assert.deepEqual(platformInvoiceFacts(row(1,'Cost Per Click','4.48')+' In total for payment 4.48 — 4.48').map(f=>[f.metric,f.amount]),[['点击广告费',4.48]]);
 assert.deepEqual(platformInvoiceFacts('1 Агентское вознаграждение за продажу (Маркетплейс) - 642 pcs 1,00 22,75 22,75 ex.excs 0% 0,00 22,75 In total for payment 22,75 0,00 22,75').map(f=>[f.metric,f.amount]),[['佣金',22.75]]);
});
test('multi-line invoices support variable row counts and match the complete printed gross total',()=>{
 const text=row(1,'Agency fee for the administration and management of the contract on international freight forwarding services','250.08')+' '+row(2,'Cost Per Click','1,772.91')+' '+row(3,'Ozon agency fee','61.70')+' In total for payment 2,084.69 — 2,084.69';
 const facts=platformInvoiceFacts(text);assert.equal(facts.length,3);assert.equal(Math.round(facts.reduce((n,f)=>n+f.amount,0)*100),208469);
 assert.throws(()=>platformInvoiceFacts(text.replace('2,084.69 — 2,084.69','2,084.69 — 2,085.69')),/总额不符/);
 assert.throws(()=>platformInvoiceFacts(row(1,'Unknown platform charge','1.00')+' In total for payment 1.00 — 1.00'),/未支持项目/);
});
test('last mile stays separate from international delivery and acquiring reversals retain their sign',()=>{
 const text='No. Name of works, services Amount(CNY) 1 Payment for acquiring services 1,00 2 Payment for acquiring services -0,43 3 Reinvoicing for last mile services 8,53 4 Cross charging for international delivery services 4,21 Total 13,31 Total services provided: 4';
 const facts=rechargedServiceFacts(text);assert.deepEqual(facts.map(f=>[f.metric,f.amount]),[['一般收单支付服务费',1],['一般收单支付服务费',-0.43],['尾程派送费',8.53],['国际物流费',4.21]]);
 assert.throws(()=>rechargedServiceFacts(text.replace('3 Reinvoicing','5 Reinvoicing')),/编号不连续/);
 assert.throws(()=>rechargedServiceFacts(text.replace('Total 13,31','Total 14,31')),/总额不符/);
});
const adjustment=(date,type,amount)=>`Payments report № 20260930 from ${date} for the period from ${date==='15.09.2026'?'01.09.2026 to 15.09.2026':'16.09.2026 to 30.09.2026'} CNY No. Shipment number Accrual date Accrual type Amount 1 12345678-0001-1 ${date} ${type} 0,00 0,00 0,00 -${amount} -${amount} 0,00 0,00 0,00 -${amount} -${amount} Total payable -${amount}`;
test('same-number half-month adjustment reports remain distinct and do not become revenue or cash',()=>{
 const a=paymentAdjustmentFacts(adjustment('30.09.2026','Частичная компенсация клиенту','41,82')),b=paymentAdjustmentFacts(adjustment('15.09.2026','Удержание за недовложение товара','31,92'));
 assert.equal(a.document_number,b.document_number);assert.notEqual(a.business_scope,b.business_scope);assert.deepEqual(a.facts.map(f=>[f.metric,f.amount]),[['客户部分补偿扣款',41.82]]);assert.deepEqual(b.facts.map(f=>[f.metric,f.amount]),[['缺件扣款',31.92]]);
 assert.throws(()=>paymentAdjustmentFacts(adjustment('30.09.2026','Unknown adjustment','41,82')),/未支持/);
 assert.throws(()=>paymentAdjustmentFacts(adjustment('30.09.2026','Частичная компенсация клиенту','41,82').replace('Total payable -41,82','Total payable -42,82')),/总额不一致/);
});
test('file classification can associate one original with several fee categories without duplicating facts',()=>{
 const doc={payload_json:{kind:'platform-invoice',facts:[{metric:'佣金',amount:1},{metric:'点击广告费',amount:2},{metric:'国际货代合同管理服务费',amount:3}]}};
 assert.deepEqual(financeDocumentCategories(doc),['platform','advertising']);assert.equal(doc.payload_json.facts.length,3);
 assert.deepEqual(financeDocumentCategories({original_name:'Счет-фактура_ЗВ - 123.pdf',payload_json:{kind:'foreign-invoice',facts:[]}}),['advertising']);
 assert.deepEqual(financeDocumentCategories({original_name:'Payments report_20260930.pdf',payload_json:{kind:'unparsed',facts:[]}}),['adjustments']);
});
test('company document guide and overview disclosure compile as production Vue components',()=>{
 for(const filename of ['frontend/admin/views/finance/CompanyStatementsView.vue','frontend/admin/views/finance/FinanceOverviewView.vue']){const {descriptor,errors}=parse(readFileSync(filename,'utf8'),{filename});assert.deepEqual(errors,[]);const script=compileScript(descriptor,{id:'legacy-finance'});assert.deepEqual(compileTemplate({source:descriptor.template.content,filename,id:'legacy-finance',compilerOptions:{bindingMetadata:script.bindings}}).errors,[]);}
});
