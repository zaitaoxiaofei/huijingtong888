import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import{OZON_DOCUMENT_FOLDERS,financeDocumentLocation,normalizeFinanceSourceLocation,financeCategoryDownloadPaths,financeUploadDownloadPaths}from'../src/shared/finance-document-locations.js';
import{summarizeImportedDocuments}from'../src/services/company-finance-documents.js';
import{financeMatrix,financeSourceShops}from'../src/shared/company-finance-report.js';
test('actual archive folder and section survive summaries and take precedence over manual metadata',()=>{
 const doc={id:5,shop_key:2,month_key:'2026-01',parse_status:'preview',original_name:'原件.xlsx',payload_json:{archive_source:{folder_id:'agentReports',folder_name:'合作伙伴报告',section:'发票',document_id:'99'},source_location:{folder_name:'销售报告'},facts:[{metric:'已确认商品销售额',amount:100,currency:'CNY'},{metric:'销售退回冲减额',amount:20,currency:'CNY'}]}};
 const result=summarizeImportedDocuments([doc],null,{includePreview:true});assert.equal(result.lines[0].source_location.path,'Ozon Seller > 财务 > 文件 > 合作伙伴报告 > 发票');assert.equal(result.lines[0].source_location.method,'插件记录');assert.equal(result.lines[0].source_location.document_id,'99');
 const matrix=financeMatrix(result.lines,'2026','month');assert.equal(matrix.rows[0].name,'平台销售额');assert.equal(matrix.rows[1].name,'采购成本');assert.equal(matrix.rows[0].cells['2026-01'],80);assert.equal(matrix.rows[0].pending_cells['2026-01'],true);
 const shops=financeSourceShops(result.lines,[{id:2,name:'Z'},{id:3,name:'C'}]);assert.equal(shops[0].lines.reduce((n,l)=>n+l.amount*(l.metric==='销售退回冲减额'?-1:1),0),80);assert.equal(shops[1].lines.length,0);
});
test('missing provenance remains unknown and lookup suggestions never become recorded paths',()=>{
 const result=financeDocumentLocation({original_name:'Sales report.xlsx',payload_json:{kind:'sales'}});assert.equal(result.recorded,false);assert.equal(result.path,'未记录下载目录');assert.ok(financeCategoryDownloadPaths('sales')[0].endsWith('销售报告 > 结算单据'));assert.match(financeUploadDownloadPaths('order-sales')[0],/不属于/);
 assert.match(financeDocumentLocation({source_type:'payroll'}).path,/工资管理/);
});
test('manual source accepts only official folder identifiers and matching sections',()=>{
 const input=normalizeFinanceSourceLocation({platform:'ozon',folder_id:'agentReports',section:'报告'});assert.equal(input.folder_name,'合作伙伴报告');assert.equal(financeDocumentLocation({payload_json:{source_location:input}}).method,'上传时填写');
 assert.equal(normalizeFinanceSourceLocation(null),null);
 for(const value of [{platform:'ozon',folder_id:'bad'},{platform:'ozon',folder_id:'agentReports',section:'销售登记册'},{platform:'other',folder_id:'agentReports'}])assert.throws(()=>normalizeFinanceSourceLocation(value),/下载目录/);
 const plugin=fs.readFileSync(new URL('../ozon-erp-collector-plugin/finance-documents-core.js',import.meta.url),'utf8');for(const folder of OZON_DOCUMENT_FOLDERS)assert.ok(plugin.includes(`'${folder.id}', '${folder.name}'`),folder.id);
});
