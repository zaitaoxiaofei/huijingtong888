import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
const page = readFileSync(new URL('../frontend/admin/views/procurement/ProcurementWorkspaceView.vue',import.meta.url),'utf8');
const navigation = readFileSync(new URL('../frontend/admin/constants/navigation.js',import.meta.url),'utf8');

test('the retired registration workspace cannot mount through its menu or legacy query string',()=>{
 assert.doesNotMatch(navigation,/procurement-workspace-legacy|label: "登记采购"/);
 assert.equal((navigation.match(/route: "\/procurement\/workspace"/g)||[]).length,1);
 const {descriptor,errors}=parse(page);assert.equal(errors.length,0);
 assert.match(descriptor.template.content,/<InventorySupplyWorkspace entry="procurement"/);
 assert.doesNotMatch(page,/workMode|startPurchaseView|旧版登记采购|apiClient\.(?:get|post)\("\/api\/procurement(?:\?|\/workbench)/);
 assert.match(page,/mode === "purchase"[\s\S]*router\.replace/);
 assert.match(page,/route\.query\.product_id \|\| route\.query\.review_product_id/);
});

test('the current workspace retains batch records, daily export, message context and historical review',()=>{
 for(const capability of ['ProcurementArrivalTracker','DailyPurchaseExport','ProcurementLedgerDialog','initial-tab="history"','message_request_id','/api/enterprise/messages/reference?type=procurement','currentApiCacheScope','shanghaiDateTimeText','messageRequestController?.abort()'])assert.ok(page.includes(capability),capability);
 assert.match(page,/route\.query\.mode === 'arrivals' \? 'incoming'/);
});
