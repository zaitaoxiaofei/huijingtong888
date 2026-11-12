import fs from 'node:fs/promises';
import {createWbPlatform} from '../src/services/wb-platform.js';
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
const tenant=Number(value('--tenant')),shop=Number(value('--shop')),file=value('--file');
if(!args.includes('--tenant')||!args.includes('--shop')||!args.includes('--file')||!Number.isSafeInteger(tenant)||tenant<=0||!Number.isSafeInteger(shop)||shop<=0)throw Error('Usage: node scripts/import-wb-review-draft.mjs --tenant ID --shop ID --file review.json [--apply]');
const review=JSON.parse(await fs.readFile(file,'utf8'));
if(review.draft?.currency!=='CNY'||!review.template?.subject_id||!review.draft?.card?.vendorCode)throw Error('Review must include a WB template and a CNY product draft');
if(!args.includes('--apply')){console.log(JSON.stringify({mode:'review only',tenant,shop,template:review.template.name,vendor_code:review.draft.card.vendorCode,currency:review.draft.currency,price:review.draft.card.sizes?.[0]?.price,publishes_to_wb:false},null,2));process.exit(0);}
const {mysqlQuery,closeMysqlPool}=await import('../src/mysql-pool.js');
try{
 const service=createWbPlatform({query:mysqlQuery});await service.account(tenant,shop);
 const existingTemplates=await service.listingTemplates(tenant,{shop_id:shop});
 let template=existingTemplates.rows.find(t=>t.name===review.template.name);
 if(template&&Number(template.subject_id)!==Number(review.template.subject_id))throw Error('Existing template name has another category; nothing overwritten');
 if(!template)template=(await service.saveListingTemplate(tenant,{shop_id:shop,name:review.template.name,subject_id:review.template.subject_id,defaults:review.template.defaults||{currency:'CNY',characteristics:[]}})).template;
 const existingDrafts=await service.listingDrafts(tenant,{shop_id:shop});
 const previous=existingDrafts.rows.find(d=>d.vendor_code===review.draft.card.vendorCode);
 if(previous){console.log(JSON.stringify({mode:'existing draft retained',draft_id:previous.id,publishes_to_wb:false}));}
 else{const saved=await service.saveListingDraft(tenant,{shop_id:shop,payload:{...review.draft,template_id:template.id}});console.log(JSON.stringify({mode:'ERP draft saved',template_id:template.id,draft_id:saved.draft_id,publishes_to_wb:false}));}
}finally{await closeMysqlPool();}
