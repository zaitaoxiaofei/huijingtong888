<script setup>
import FinanceDocumentSource from '../../components/finance/FinanceDocumentSource.vue';
import {OZON_DOCUMENT_FOLDERS,financeDocumentLocation} from '../../../../src/shared/finance-document-locations.js';
import { FINANCE_FILE_CATEGORIES, financeDocumentCategories } from '../../../../src/shared/finance-document-categories.js';
import { FINANCE_GROUPS, MANUAL_EXPENSE_METRICS, UPLOAD_TYPES, financeMatrix, financeSourceShops, financeLineSign, financeExpenseRecordQuery } from '../../../../src/shared/company-finance-report.js';
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient, currentApiCacheScope, getAuthToken } from '../../utils/api';
import { useAuthStore } from '../../stores/auth';
import { canAccessPage } from '../../../../src/shared/permissions.js';
import { shanghaiDateKey, shanghaiDateTimeText } from '../../utils/shanghai-date.js';

const ApprovedH1Adjustments=defineAsyncComponent(()=>import('../../components/finance/ApprovedH1Adjustments.vue'));
const FinanceReconciliation=defineAsyncComponent(()=>import('./FinanceReconciliation.vue'));
const auth=useAuthStore(),router=useRouter(),route=useRoute();
const allowed=computed(()=>canAccessPage(auth.user,'/finance/company-statements'));
const initialMonth=/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(route.query.month||''))?String(route.query.month):shanghaiDateKey().slice(0,7);
const companies=ref([]),assignments=ref([]),allShops=ref([]),companyId=ref(''),shopId=ref(null),month=ref(initialMonth),period=ref('month');
const report=ref(null),error=ref(''),loading=ref(false),busy=ref(false),tab=ref(['documents','adjustments','cash'].includes(route.query.tab)?route.query.tab:'summary'),preview=ref(null),editManual=ref(null),review=ref(null),fileInput=ref(null),uploads=ref([]);
const helpOpen=ref(false),costDetail=ref(null),costSyncOpen=ref(false),costSyncResults=ref([]);
let costGeneration=0;
const fileCategory=ref('all'),documentMonth=ref(route.query.tab==='documents'&&route.query.month?initialMonth:'');
const documentShop=ref(null),documentFolder=ref(''),documentSearch=ref(''),documentPage=ref(1),documentPageSize=ref(20);
const cashMonth=ref(''),cashShop=ref(null),archiveUploadOpen=ref(false),cashFileInput=ref(null),cashUploads=ref([]);
const uploadMonth=ref(''),sourceFolder=ref(''),sourceSection=ref('');
const shopName=id=>Number(id)?allShops.value.find(s=>Number(s.id)===Number(id))?.name||`店铺 #${id}`:'公司共用';
const selection=ref(null);
const year=computed({get:()=>month.value.slice(0,4),set:value=>{if(/^20\d{2}$/.test(String(value)))month.value=`${value}-${month.value.slice(5)}`;}});
const expandedGroups=[];
const sourcePanel=ref(null);
const selectedSourceFolder=computed(()=>OZON_DOCUMENT_FOLDERS.find(f=>f.id===sourceFolder.value));
let generation=0,controller;
const money=n=>n==null?'—':Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const companyShops=computed(()=>allShops.value.filter(s=>assignments.value.some(a=>Number(a.company_id)===Number(companyId.value)&&Number(a.shop_id)===Number(s.id))));
const shops=computed(()=>companyShops.value.filter(s=>!uploadMonth.value||assignments.value.some(a=>Number(a.company_id)===Number(companyId.value)&&Number(a.shop_id)===Number(s.id)&&a.effective_from<=`${uploadMonth.value}-31`&&(!a.effective_to||a.effective_to>=`${uploadMonth.value}-01`))));
const windowRange=computed(()=>({from:`${year.value}-01`,to:`${year.value}-12`}));
const query=computed(()=>new URLSearchParams({company_id:companyId.value,...windowRange.value}).toString());
const categorizedDocuments=computed(()=>(report.value?.documents||[]).map(d=>({...d,categories:d.categories||financeDocumentCategories(d)})));
const documentSource=d=>{
 const p=d.payload_json;
 if(p.kind==='collection-cash'||p.upload_type==='collection-cash')return '结算回款 > 连连流水';
 if(p.kind==='payroll'||p.upload_type==='payroll')return '财务中心 > 工资管理';
 if(p.kind==='manual-expense'||p.upload_type==='manual-expense')return '历史手工费用';
 if(p.kind==='order-sales'&&!financeDocumentLocation(d).recorded)return 'Ozon > 官方逐单销售接口';
 const location=financeDocumentLocation(d);
 return location.recorded?location.path:'来源待确认';
};
const filteredDocuments=computed(()=>{
 const search=documentSearch.value.trim().toLowerCase();
 return categorizedDocuments.value.filter(d=>
  d.month_key.startsWith(documentMonth.value||year.value)&&
  (documentShop.value==null||Number(d.shop_key)===documentShop.value)&&
  (!documentFolder.value||financeDocumentLocation(d).folder_id===documentFolder.value)&&
  (fileCategory.value==='all'||d.categories.includes(fileCategory.value))&&
  (!search||d.original_name.toLowerCase().includes(search))
 ).sort((a,b)=>b.month_key.localeCompare(a.month_key)||documentSource(a).localeCompare(documentSource(b),'zh-CN')||a.original_name.localeCompare(b.original_name,'zh-CN',{numeric:true})||Number(a.id)-Number(b.id));
});
const pagedDocuments=computed(()=>filteredDocuments.value.slice((documentPage.value-1)*documentPageSize.value,documentPage.value*documentPageSize.value));
const cashMatchesAll=computed(()=>report.value?.cash_reconciliation?.matches||[]);
const cashMatches=computed(()=>cashMatchesAll.value.filter(row=>
 (!cashMonth.value||(row.entry||row.payment).date.startsWith(cashMonth.value))&&
 (cashShop.value==null||cashShop.value>0&&Number(row.payment.shop_id)===cashShop.value)));
const confirmedCashShops=computed(()=>new Map(cashMatchesAll.value.filter(row=>row.status==='confirmed'&&row.entry).map(row=>[row.entry.reference,Number(row.payment.shop_id)])));
const cashTransactions=computed(()=>(report.value?.cash_reconciliation?.rows||[]).filter(row=>
 (!cashMonth.value||row.date.startsWith(cashMonth.value))&&
 (cashShop.value==null||row.type==='entry'&&(confirmedCashShops.value.get(row.reference)||0)===cashShop.value)
).slice().sort((a,b)=>b.date.localeCompare(a.date)));
const cashIssues=kind=>(report.value?.cash_reconciliation?.[kind]||[]).filter(issue=>!cashMonth.value||issue.sources.some(row=>row.date.startsWith(cashMonth.value)));
const cashDuplicates=computed(()=>cashIssues('duplicates'));
const cashConflicts=computed(()=>cashIssues('conflicts'));
const cashShopEntries=computed(()=>(report.value?.cash_reconciliation?.shop_entries||[]).filter(row=>
 (!cashMonth.value||row.month===cashMonth.value)&&(cashShop.value==null||Number(row.shop_id||0)===cashShop.value)));
const cashDocuments=computed(()=>categorizedDocuments.value.filter(d=>{
 const p=d.payload_json;
 if(p.kind!=='collection-cash'&&p.upload_type!=='collection-cash')return false;
 if(cashShop.value>0)return cashMatches.value.some(row=>row.status==='confirmed'&&Number(row.entry?.document_id)===Number(d.id));
 if(cashShop.value===0){
  return (p.cash||[]).some(row=>row.type==='entry'&&!confirmedCashShops.value.has(row.reference)&&(!cashMonth.value||row.date.startsWith(cashMonth.value)));
 }
 const transactions=p.cash||[],period=cashMonth.value||year.value;
 return transactions.length?transactions.some(row=>row.date.startsWith(period)):d.month_key.startsWith(period);
}).sort((a,b)=>b.month_key.localeCompare(a.month_key)||Number(b.id)-Number(a.id)));
const cashPage=ref(1),cashPageSize=30;
const cashPageRows=computed(()=>cashTransactions.value.slice((cashPage.value-1)*cashPageSize,cashPage.value*cashPageSize));
const filterMonthOutsideYear=date=>String(date.getFullYear())!==year.value;
const cashDocumentPeriod=d=>{
 const p=d.payload_json;
 if(p.transaction_period)return p.transaction_period;
 const dates=(p.cash||[]).map(row=>row.date.slice(0,10)).sort();
 return {from:dates[0],to:dates.at(-1)};
};
const categoryName=id=>FINANCE_FILE_CATEGORIES.find(c=>c.id===id)?.name||id;
const collected=computed(()=>report.value?.collected_summary||report.value);
const matrix=computed(()=>financeMatrix(collected.value?.lines||[],year.value,period.value));
const netSales=computed(()=>collected.value?.metrics?.['已确认商品销售额']==null?null:collected.value.metrics['已确认商品销售额']-(collected.value.metrics['销售退回冲减额']||0));
const platformFees=computed(()=>{const names=FINANCE_GROUPS.find(g=>g.id==='platform').metrics,lines=(collected.value?.lines||[]).filter(l=>names.includes(l.metric));return lines.length?lines.reduce((s,l)=>s+l.amount,0):null;});
const registeredCosts=computed(()=>{const lines=(collected.value?.lines||[]).filter(l=>['payroll','recorded-expense'].includes(l.source_type));return lines.length?lines.reduce((n,l)=>n+l.amount,0):null;});
const sourceLines=computed(()=>selection.value?(collected.value?.lines||[]).filter(l=>l.month>=selection.value.period.from&&l.month<=selection.value.period.to&&selection.value.row.metrics.includes(l.metric)):[]);
const sourceShops=computed(()=>financeSourceShops(sourceLines.value,sourceLines.value.some(l=>Number(l.shop_id)>0&&!['payroll','recorded-expense'].includes(l.source_type))?(report.value?.shops||[]):[]).map(s=>({...s,amount:s.lines.some(l=>l.amount==null)?null:s.lines.length?s.lines.reduce((n,l)=>n+l.amount*(selection.value?.row.id==='income'||selection.value?.row.refund?financeLineSign(l.metric):1),0):null})));
async function selectCell(row,p){
 selection.value={row,period:p};await nextTick();
 requestAnimationFrame(()=>{
  const target=sourcePanel.value;if(!target)return;
  let host=target.parentElement;
  while(host&&host!==document.body){
   if(/auto|scroll/.test(getComputedStyle(host).overflowY)&&host.scrollHeight>host.clientHeight){host.scrollTo({top:host.scrollTop+target.getBoundingClientRect().top-host.getBoundingClientRect().top-12,behavior:'auto'});return;}
   host=host.parentElement;
  }
  window.scrollTo({top:window.scrollY+target.getBoundingClientRect().top-12,behavior:'auto'});
 });
}

const costCellHasSources=(row,p)=>row.metrics.includes('已售商品采购成本')&&(collected.value?.lines||[]).some(l=>l.metric==='已售商品采购成本'&&l.month>=p.from&&l.month<=p.to);
async function openCostDetail(row,page=1){
 const scope=currentApiCacheScope(),token=++costGeneration,company=String(companyId.value);
 costDetail.value={month:row.month,shop_id:row.shop_id,page,rows:[],total:0,loading:true,error:''};
 try{const data=await apiClient.get('/api/finance-center/document-report?'+new URLSearchParams({company_id:company,from:row.month,to:row.month,purchase_cost_details:'1',cost_shop_id:row.shop_id,cost_page:page}),{noCache:true});if(token!==costGeneration||scope!==currentApiCacheScope()||company!==String(companyId.value))return;Object.assign(costDetail.value,{rows:data.purchase_cost.details.rows,total:data.purchase_cost.details.total,loading:false});}
 catch(e){if(token===costGeneration&&costDetail.value)Object.assign(costDetail.value,{error:e.message,loading:false});}
}
async function syncCostSources(){
 const scope=currentApiCacheScope(),company=String(companyId.value),targets=(report.value?.purchase_cost?.pending_sources||[]).filter(r=>r.month<shanghaiDateKey().slice(0,7));
 if(!targets.length){ElMessage.info('已归档来源齐全，或月份尚未结束');return;}
 busy.value=true;costSyncOpen.value=true;costSyncResults.value=[];
 try{for(const target of targets){
  if(scope!==currentApiCacheScope()||company!==String(companyId.value))break;
  const result={...target,status:'读取中',note:''};costSyncResults.value.push(result);
  try{
   const original=await apiClient.post('/api/finance-center/order-sales-source',{company_id:company,shop_id:target.shop_id,month:target.month});
   if(scope!==currentApiCacheScope()||company!==String(companyId.value))break;
   const file=new File([JSON.stringify(original.data)],original.filename,{type:'application/json'});if(file.size>20*1024*1024)throw Error('逐单报告超过20MB，请按月下载后拆分');
   const form=new FormData();form.append('file',file);const authToken=getAuthToken(),response=await fetch('/api/finance-center/voucher-attachments',{method:'POST',headers:authToken?{Authorization:'Bearer '+authToken}:{},body:form}),uploaded=await response.json();if(!response.ok||!uploaded.ok)throw Error(uploaded.error||'原件归档失败');
   if(scope!==currentApiCacheScope()||company!==String(companyId.value))break;
   const parsed=await apiClient.post('/api/finance-center/document-import',{action:'preview',company_id:company,shop_id:target.shop_id,month:target.month,attachment_url:uploaded.url,upload_type:'order-sales'});
   if(parsed.document.parse_status==='error')throw Error(parsed.document.payload_json.warnings.join('；'));
   result.status=parsed.duplicate?'已复用':'已读取';result.note='已用于参考成本；未调整订单';
  }catch(e){result.status='未完成';result.note=e.message;}
  costSyncResults.value=[...costSyncResults.value];
 }
 if(scope===currentApiCacheScope()&&company===String(companyId.value))await load();
 }finally{busy.value=false;}
}
const statuses={preview:'待确认',confirmed:'已确认归档',error:'解析/归属待处理'};
const reviews={pending:'待会计审核',accepted:'会计认可',needs_info:'需补资料',adjustment:'需纳税调整'};
function current(token,scope){return token===generation&&scope===currentApiCacheScope()&&allowed.value;}
async function load(){
 const token=++generation,scope=currentApiCacheScope();controller?.abort();controller=new AbortController();report.value=null;preview.value=null;selection.value=null;costDetail.value=null;costGeneration++;error.value='';
 if(!allowed.value||!companyId.value)return;
 loading.value=true;
 try{const data=await apiClient.get(`/api/finance-center/document-report?${query.value}`,{signal:controller.signal,noCache:true});if(current(token,scope)){if(!data?.coverage||!Array.isArray(data.lines)||!Array.isArray(data.documents))throw new Error('报表返回内容不完整，请刷新；持续出现时请检查当前访问的服务地址');report.value=data;}}
 catch(e){if(current(token,scope)&&e.name!=='AbortError')error.value=e.message;}
 finally{if(token===generation)loading.value=false;}
}
async function refreshDocuments(){const token=generation,scope=currentApiCacheScope();try{const data=await apiClient.get(`/api/finance-center/document-report?${query.value}`,{noCache:true});if(current(token,scope))report.value=data;}catch(e){if(current(token,scope))ElMessage.error(e.message);}}
async function setup(){
 const scope=currentApiCacheScope(),token=++generation;controller?.abort();report.value=null;companies.value=[];allShops.value=[];assignments.value=[];companyId.value='';costSyncOpen.value=false;costSyncResults.value=[];costDetail.value=null;costGeneration++;uploads.value=[];review.value=null;error.value='';
 if(!allowed.value)return;
 try{const data=await apiClient.get('/api/finance-center/companies',{noCache:true});if(!current(token,scope))return;companies.value=data.companies;assignments.value=data.assignments;allShops.value=data.shops;companyId.value=String(data.companies.find(c=>String(c.id)===String(route.query.company_id||''))?.id||data.companies[0]?.id||'');}
 catch(e){if(current(token,scope))error.value=e.message;}
}
async function upload(event,cash=false){
 const files=Array.from(event.target.files||[]);event.target.value='';if(!files.length)return;
 await importOriginals(files.map(file=>({name:file.name,file})),cash);
}
async function importOriginals(originals,cash=false){
 if(busy.value||!companyId.value||!cash&&(!selectedSourceFolder.value||!shopId.value||selectedSourceFolder.value.sections.length&&!sourceSection.value))return;
 if(cash){cashMonth.value='';cashShop.value=null;}
 const scope=currentApiCacheScope(),company=companyId.value,shop=cash?0:shopId.value,selectedMonth=uploadMonth.value;
 const results=cash?cashUploads:uploads;
 const location=cash?undefined:{platform:'ozon',folder_id:sourceFolder.value,section:sourceSection.value};
 busy.value=true;results.value=[];
 try{
  for(const {name,file,url} of originals){
   if(scope!==currentApiCacheScope()||!allowed.value)break;
   let attachmentUrl=url;
   try{
    if(!attachmentUrl){
     if(file.size>20*1024*1024)throw new Error('文件超过20MB，请拆分');
     const form=new FormData();form.append('file',file);const token=getAuthToken();
     const response=await fetch('/api/finance-center/voucher-attachments',{method:'POST',body:form,headers:token?{Authorization:`Bearer ${token}`}:{}});
     const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'原件上传失败');
     attachmentUrl=data.url;
    }
    if(scope!==currentApiCacheScope()||!allowed.value)break;
    const parsed=await apiClient.post('/api/finance-center/document-import',{
     action:'preview',company_id:company,shop_id:shop,month:cash?undefined:selectedMonth||undefined,
     attachment_url:attachmentUrl,upload_type:cash?'collection-cash':'auto',upload_channel:cash?undefined:'ozon-archive',source_location:location
    });
    if(scope!==currentApiCacheScope())break;
    const doc=parsed.document;
    results.value.push({name,status:statuses[doc.parse_status]+(parsed.duplicate?'（已有原件）':''),note:[doc.month_key,doc.payload_json?.warnings?.join('；')].filter(Boolean).join(' · ')});
   }catch(e){
    if(scope!==currentApiCacheScope())break;
    const needsMonth=!cash&&!selectedMonth&&attachmentUrl&&e.message.includes('待确认月份');
    results.value.push({name,status:needsMonth?'待确认月份':'未完成',note:e.message,url:needsMonth?attachmentUrl:undefined});
   }
  }
  if(scope===currentApiCacheScope())await refreshDocuments();
 }finally{busy.value=false;}
}
function openPreview(doc){preview.value=doc;editManual.value=doc.parse_status==='preview'&&doc.payload_json.kind==='manual-expense'?{...doc.payload_json.manual}:null;}
async function saveManualDraft(){
 const scope=currentApiCacheScope(),doc=preview.value;busy.value=true;
 try{await apiClient.post('/api/finance-center/document-import',{action:'preview',company_id:companyId.value,shop_id:doc.shop_key,month:doc.month_key,attachment_url:doc.attachment_url,upload_type:'manual-expense',display_name:doc.payload_json.display_name,manual:{...editManual.value},expected_revision:Number(doc.revision||0)});if(scope!==currentApiCacheScope())return;preview.value=null;ElMessage.success('草稿已保存，请重新预览后确认归档');await load();}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
}
const payoutCandidates=computed(()=>cashMatches.value.filter(row=>row.status==='amount_date_candidate').slice(0,500));
const payoutStatuses={confirmed:'归属已确认',amount_date_candidate:'待确认归属',ambiguous:'多笔候选，待核对',unmatched:'未匹配',evidence_missing:'原件待核对'};
async function confirmPayouts(rows){
 const company=String(companyId.value),scope=currentApiCacheScope(),bounds={...windowRange.value};
 try{await ElMessageBox.confirm(`确认这 ${rows.length} 笔连连入账的店铺归属？`,'确认回款归属',{type:'warning'});}
 catch{return;}
 if(busy.value||company!==String(companyId.value)||scope!==currentApiCacheScope()||bounds.from!==windowRange.value.from)return;
 busy.value=true;
 try{
  const result=await apiClient.post('/api/finance-center/document-import',{action:'confirmPayouts',company_id:company,...bounds,matches:rows.map(({entry,payment})=>({
   entry_reference:String(entry.reference),payment_document_id:payment.document_id,payment_source:payment.source
  }))});
  if(company!==String(companyId.value)||scope!==currentApiCacheScope())return;
  ElMessage.success(result.confirmed?`已确认 ${result.confirmed} 笔回款归属`:'所选回款归属已确认');
  await load();
 }catch(e){ElMessage.error(e.message);}
 finally{busy.value=false;}
}
async function confirm(doc){
 const scope=currentApiCacheScope();busy.value=true;
 try{await apiClient.post('/api/finance-center/document-import',{action:'confirm',company_id:companyId.value,document_id:doc.id,expected_revision:Number(doc.revision||0)});if(scope!==currentApiCacheScope())return;ElMessage.success('已确认，原件与明细已归档');await load();}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
}
async function saveReview(){
 const scope=currentApiCacheScope();busy.value=true;
 try{await apiClient.post('/api/finance-center/document-import',{action:'review',company_id:companyId.value,document_id:review.value.id,review_status:review.value.review_status,review_note:review.value.review_note});if(scope!==currentApiCacheScope())return;review.value=null;await load();}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
}
async function download(p=null){
 const scope=currentApiCacheScope(),target=p?.from?p:windowRange.value,exportQuery=new URLSearchParams({company_id:companyId.value,from:target.from,to:target.to,period_mode:period.value});busy.value=true;
 try{const response=await apiClient.blobResponse(`/api/finance-center/document-export?${exportQuery}`);if(scope!==currentApiCacheScope())return;const url=URL.createObjectURL(response.blob),a=document.createElement('a');a.href=url;a.download=`公司会计交接_${target.from}_${target.to}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
}
function openFile(url){if(/^\/uploads\/team-attachments\/[^/]+$/.test(url||''))window.open(url,'_blank','noopener,noreferrer');}
watch(()=>[auth.user?.id,auth.user?.tenant?.id,currentApiCacheScope(),allowed.value],setup,{immediate:true});
watch(()=>route.query.month,value=>{if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(value||'')))month.value=String(value);});
watch(sourceFolder,()=>{sourceSection.value='';});
watch(companyId,()=>{sourceFolder.value='';sourceSection.value='';uploadMonth.value='';shopId.value=null;documentShop.value=null;cashShop.value=null;cashUploads.value=[];archiveUploadOpen.value=false;});
watch(uploadMonth,()=>{if(!shops.value.some(s=>Number(s.id)===shopId.value))shopId.value=null;});
watch([documentMonth,documentShop,documentFolder,fileCategory,documentSearch,documentPageSize,query],()=>{documentPage.value=1;});
watch(()=>filteredDocuments.value.length,total=>{documentPage.value=Math.min(documentPage.value,Math.max(1,Math.ceil(total/documentPageSize.value)));});
watch(query,()=>{if(documentMonth.value&&documentMonth.value.slice(0,4)!==year.value)documentMonth.value='';if(cashMonth.value&&cashMonth.value.slice(0,4)!==year.value)cashMonth.value='';uploads.value=[];review.value=null;load();});
watch([cashMonth,cashShop,query],()=>{cashPage.value=1;});
watch(()=>cashTransactions.value.length,total=>{cashPage.value=Math.min(cashPage.value,Math.max(1,Math.ceil(total/cashPageSize)));});
watch(period,()=>{selection.value=null;});
onBeforeUnmount(()=>{costGeneration++;generation++;controller?.abort();});
</script>

<template>
 <div v-if="allowed" class="company-statements">
  <header><div><h1>公司账单</h1></div><div class="toolbar"><el-button text @click="helpOpen=true">说明</el-button><el-button @click="router.push('/finance-center')">公司设置</el-button></div></header>
  <div class="toolbar">
   <el-select v-model="companyId" aria-label="公司主体" placeholder="选择公司" :disabled="busy"><el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" /></el-select>
   <el-date-picker v-if="tab!=='reconciliation'" v-model="year" type="year" value-format="YYYY" format="YYYY年" :clearable="false" aria-label="报表年度" :disabled="busy" />
   <el-radio-group v-if="!['reconciliation','documents','cash'].includes(tab)" v-model="period" :disabled="busy"><el-radio-button value="month">月度</el-radio-button><el-radio-button value="quarter">季度</el-radio-button><el-radio-button value="year">年度</el-radio-button></el-radio-group>
   <el-button v-if="tab!=='reconciliation'" :disabled="busy||!report" @click="download">导出全年交接包（草稿）</el-button><el-button v-if="tab!=='reconciliation'" :disabled="busy" @click="load">刷新</el-button><el-tooltip content="读取缺少的已结束月份官方逐单凭证，匹配ERP历史成本；不调整订单账簿。"><el-button v-if="tab==='summary'" :disabled="busy||!report" :loading="busy" @click="syncCostSources">同步成本</el-button></el-tooltip>
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" />
  <el-empty v-if="!companies.length&&!error" description="请先在经营总览的公司设置中配置主体及店铺归属" />
  <template v-if="report">
   <el-tabs v-model="tab">
    <el-tab-pane label="公司汇总" name="summary" lazy>
     <div class="totals"><div><span>{{year}}年 · 已解析商品净销售 CNY</span><strong>{{money(netSales)}}</strong></div><div><span>{{year}}年 · 已解析平台费用 CNY</span><strong>{{money(platformFees)}}</strong></div><div><span>{{year}}年 · 已登记工资及经营费用 CNY</span><strong>{{money(registeredCosts)}}</strong></div></div>
<el-button v-if="collected.error_documents" link type="warning" @click="tab='documents'">{{collected.error_documents}}份解析异常</el-button>
     <el-table class="period-matrix" :data="matrix.rows" row-key="id" :expand-row-keys="expandedGroups" :row-class-name="({row})=>row.children?'finance-group-row':''" :tree-props="{children:'children'}" border v-loading="loading" :max-height="650">
      <el-table-column prop="name" label="项目 / CNY" fixed min-width="285"/>
      <el-table-column v-for="p in matrix.periods" :key="p.id" :label="p.label" :min-width="period==='month'?130:180" align="right"><template #header><span>{{p.label}}</span> <el-button link type="primary" :disabled="busy" :aria-label="`导出${p.label}交接包`" @click="download(p)">导出</el-button></template><template #default="{row}"><el-button v-if="row.cells[p.id]!=null||costCellHasSources(row,p)" link type="primary" :aria-label="`${row.name} ${p.label} 查看明细`" @click="selectCell(row,p)">{{row.refund?'− ':''}}{{money(row.cells[p.id])}}</el-button><span v-else class="missing">—</span></template></el-table-column>
     </el-table>
     <section v-if="selection" ref="sourcePanel" class="source-detail"><h2>{{selection.row.name}} · {{selection.period.label}} · 店铺及原始凭证</h2>
      <el-table :data="sourceShops" row-key="id" :default-expand-all="true">
       <el-table-column type="expand"><template #default="{row:shop}"><el-table v-if="shop.lines.length" :data="shop.lines" class="source-lines"><el-table-column prop="month" label="业务月份" width="110"/><el-table-column prop="metric" label="项目" min-width="170"/><el-table-column label="金额 CNY" width="130"><template #default="{row}">{{row.metric==='销售退回冲减额'?'− ':''}}{{money(row.amount)}}</template></el-table-column><el-table-column prop="source" label="提取位置 / 录入依据" min-width="220"/><el-table-column label="原件（原始名称保留）" min-width="260"><template #default="{row}"><el-button v-if="row.source_type==='payroll'" link type="primary" @click="router.push({path:'/finance/payroll',query:{companyId:companyId,month:row.month}})">查看工资明细</el-button><el-button v-else-if="row.source_type==='purchase-cost'" link type="primary" @click="openCostDetail(row)">查看订单成本</el-button><el-button v-else-if="row.source_type==='recorded-expense'" link type="primary" @click="router.push({path:'/profit/monthly-billing',query:financeExpenseRecordQuery(companyId,row.month)})">查看费用记录 #{{row.expense_id}}</el-button><el-button v-else link type="primary" @click="openFile(row.attachment_url)">{{row.display_name||row.original_name}}</el-button><small v-if="row.source_type==='recorded-expense'&&!row.linked_evidence?.length">暂无关联原件</small><small v-if="row.source_type!=='recorded-expense'&&row.display_name!==row.original_name">{{row.original_name}}</small><FinanceDocumentSource :document="row"/><div v-for="e in row.linked_evidence" :key="e.document_id||`voucher-${e.voucher_id}`"><el-button link type="primary" @click="openFile(e.attachment_url)">配套：{{e.display_name}}</el-button><small>{{e.original_name}} · {{reviews[e.review_status]}}</small><FinanceDocumentSource :document="e"/></div></template></el-table-column><el-table-column label="金额状态" width="100"><template #default="{row}"><span>{{row.amount_status==='missing'?'缺少来源':row.source_type==='purchase-cost'?'已匹配':row.amount_status==='estimated'?'已登记（估算）':row.source_type==='recorded-expense'?'已登记':row.parse_status==='preview'?'已解析':'已确认'}}</span></template></el-table-column><el-table-column label="凭证审核" width="130"><template #default="{row}">{{reviews[row.review_status]||'待会计审核'}}</template></el-table-column></el-table><p v-else class="source-lines">该店铺在此期间暂无对应金额来源。</p></template></el-table-column>


       <el-table-column prop="name" label="店铺 / 公司共用"/><el-table-column label="已采集金额 CNY" align="right"><template #default="{row}">{{money(row.amount)}}</template></el-table-column>
      </el-table>
      <el-empty v-if="!sourceShops.length" description="该期间没有已解析来源"/>
     </section>
    </el-tab-pane>
    <el-tab-pane label="凭证归档" name="documents" lazy>
     <div class="toolbar tab-toolbar">
      <el-date-picker v-model="documentMonth" :disabled-date="filterMonthOutsideYear" type="month" value-format="YYYY-MM" placeholder="全部月份" aria-label="凭证月份筛选"/>
      <el-select v-model="documentFolder" clearable placeholder="全部平台目录" aria-label="凭证目录筛选"><el-option v-for="f in OZON_DOCUMENT_FOLDERS" :key="f.id" :value="f.id" :label="f.name"/></el-select>
      <el-select v-model="documentShop" clearable :value-on-clear="null" placeholder="全部店铺" aria-label="凭证店铺筛选"><el-option :value="0" label="公司共用"/><el-option v-for="s in companyShops" :key="s.id" :label="s.name" :value="Number(s.id)"/></el-select>
      <el-select v-model="fileCategory" aria-label="文件类别筛选"><el-option value="all" label="全部分类"/><el-option v-for="c in FINANCE_FILE_CATEGORIES" :key="c.id" :value="c.id" :label="c.name"/></el-select>
      <el-input v-model="documentSearch" clearable placeholder="搜索原始文件名" aria-label="搜索原始文件名"/>
      <el-button class="tab-upload-button" type="primary" :disabled="busy" @click="archiveUploadOpen=true">上传 Ozon 原件</el-button>
     </div>
     <el-table v-if="uploads.length" :data="uploads"><el-table-column prop="name" label="本批文件"/><el-table-column prop="status" label="结果"/><el-table-column prop="note" label="提示" min-width="240"/></el-table>
     <el-table :data="pagedDocuments">
      <el-table-column prop="month_key" label="月份" width="110"/>
      <el-table-column label="平台目录 / 原件来源" min-width="230"><template #default="{row}">{{documentSource(row)}} <el-button v-if="row.payload_json.kind==='collection-cash'||row.payload_json.upload_type==='collection-cash'" link @click="tab='cash'">查看</el-button></template></el-table-column>
      <el-table-column prop="original_name" label="原始文件名" min-width="260"/>
      <el-table-column label="店铺名称" min-width="150"><template #default="{row}">{{shopName(row.shop_key)}}</template></el-table-column>
      <el-table-column label="文件分类" min-width="190"><template #default="{row}"><el-tag v-for="c in row.categories" :key="c" size="small" class="category-tag">{{categoryName(c)}}</el-tag></template></el-table-column><el-table-column label="用途" min-width="150"><template #default="{row}">{{UPLOAD_TYPES.find(t=>t.value===(row.payload_json.kind==='collection-cash'?'collection-cash':row.payload_json.upload_type))?.label||'平台自动识别'}}<small v-if="row.payload_json.archive_source">插件同步 · {{row.payload_json.archive_source.folder_name}}</small><small v-if="row.payload_json.related_document_id">关联业务 #{{row.payload_json.related_document_id}}</small></template></el-table-column><el-table-column label="解析状态" width="140"><template #default="{row}">{{ statuses[row.parse_status] }}</template></el-table-column><el-table-column label="操作" width="240"><template #default="{row}"><el-button link :aria-label="`预览 ${row.original_name}`" @click="openPreview(row)">预览</el-button><el-button link @click="openFile(row.attachment_url)">原件</el-button><el-button v-if="row.parse_status==='preview'" link type="primary" :disabled="busy" :aria-label="`确认归档 ${row.original_name}`" @click="confirm(row)">确认归档</el-button></template></el-table-column></el-table>
     <el-pagination v-model:current-page="documentPage" v-model:page-size="documentPageSize" :page-sizes="[20,50,100]" :total="filteredDocuments.length" layout="total, sizes, prev, pager, next"/>
     <el-dialog v-if="archiveUploadOpen" v-model="archiveUploadOpen" title="上传 Ozon 原件" width="min(580px,95vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy">
      <div class="upload-context">
       <el-select v-model="sourceFolder" placeholder="选择 Ozon 平台目录" aria-label="Ozon 下载目录" :disabled="busy"><el-option v-for="f in OZON_DOCUMENT_FOLDERS" :key="f.id" :value="f.id" :label="f.name"/></el-select>
       <el-select v-if="selectedSourceFolder?.sections.length" v-model="sourceSection" clearable placeholder="选择子目录" aria-label="Ozon 下载子目录" :disabled="busy"><el-option v-for="section in selectedSourceFolder.sections" :key="section" :value="section" :label="section"/></el-select>
       <el-select v-model="shopId" placeholder="选择店铺" aria-label="上传店铺" :disabled="busy||!sourceFolder"><el-option v-for="s in shops" :key="s.id" :value="Number(s.id)" :label="s.name"/></el-select>
       <el-date-picker v-model="uploadMonth" type="month" value-format="YYYY-MM" placeholder="业务月份（选填，留空自动识别）" aria-label="上传业务月份" :disabled="busy||!sourceFolder"/>
       <div><el-button type="primary" :loading="busy" :disabled="!sourceFolder||!shopId||(selectedSourceFolder?.sections.length>0&&!sourceSection)" @click="fileInput.click()">选择文件并上传</el-button><input ref="fileInput" type="file" multiple accept=".pdf,.xlsx,.json,.png,.jpg,.jpeg,.webp" hidden @change="upload($event)"/></div>
       <el-button v-if="uploads.some(row=>row.url)" :disabled="busy||!uploadMonth||!shopId" @click="importOriginals(uploads.filter(row=>row.url))">按所选月份归档待确认文件</el-button>
       <el-table v-if="uploads.length" :data="uploads"><el-table-column prop="name" label="本批文件"/><el-table-column prop="status" label="结果"/><el-table-column prop="note" label="提示" min-width="230"/></el-table>
      </div>
     </el-dialog>
    </el-tab-pane>
    <el-tab-pane label="调整账簿" name="adjustments" lazy>
     <ApprovedH1Adjustments v-if="tab==='adjustments'" :key="companyId" :company-id="companyId" :from="windowRange.from" :to="windowRange.to" :shops="allShops.filter(s=>assignments.some(a=>Number(a.company_id)===Number(companyId)&&Number(a.shop_id)===Number(s.id)))"/>
    </el-tab-pane>
    <el-tab-pane label="订单对账" name="reconciliation" lazy>
     <FinanceReconciliation v-if="tab==='reconciliation'" :key="companyId" :company-id="companyId" :shops="allShops.filter(s=>assignments.some(a=>Number(a.company_id)===Number(companyId)&&Number(a.shop_id)===Number(s.id)))" :initial-month="month" @documents-changed="refreshDocuments"/>
    </el-tab-pane>
    <el-tab-pane label="结算回款" name="cash" lazy>
     <div class="toolbar tab-toolbar">
      <span>{{report.company.name}}</span>
      <el-date-picker v-model="cashMonth" :disabled-date="filterMonthOutsideYear" type="month" value-format="YYYY-MM" placeholder="全部交易月份" aria-label="回款月份筛选"/>
      <el-select v-model="cashShop" clearable :value-on-clear="null" placeholder="全部店铺" aria-label="回款店铺筛选"><el-option :value="0" label="待确认归属"/><el-option v-for="s in companyShops" :key="s.id" :value="Number(s.id)" :label="s.name"/></el-select>
      <el-button class="tab-upload-button" type="primary" :loading="busy" @click="cashFileInput.click()">上传连连原件</el-button>
      <input ref="cashFileInput" type="file" multiple accept=".xlsx" hidden @change="upload($event,true)"/>
     </div>
     <el-table v-if="cashUploads.length" :data="cashUploads"><el-table-column prop="name" label="本批文件"/><el-table-column prop="status" label="结果"/><el-table-column prop="note" label="提示" min-width="240"/></el-table>
     <h2>连连原件</h2>
     <el-table :data="cashDocuments" empty-text="此筛选下没有连连原件">
      <el-table-column prop="original_name" label="原始文件名" min-width="230"/>
      <el-table-column label="原件交易期间" min-width="210"><template #default="{row}">{{cashDocumentPeriod(row).from||'—'}} 至 {{cashDocumentPeriod(row).to||'—'}}</template></el-table-column>
      <el-table-column label="解析状态" width="140"><template #default="{row}">{{statuses[row.parse_status]}}</template></el-table-column>
      <el-table-column label="操作" min-width="230"><template #default="{row}"><el-button link @click="openPreview(row)">预览</el-button><el-button link @click="openFile(row.attachment_url)">原件</el-button><el-button v-if="row.parse_status==='preview'" link type="primary" :disabled="busy" @click="confirm(row)">确认归档</el-button></template></el-table-column>
     </el-table>
     <template v-if="cashShop==null">

     <el-collapse><el-collapse-item :title="`重复交易来源（${cashDuplicates.length}条）`"><el-table :data="cashDuplicates"><el-table-column prop="reference" label="交易编号"/><el-table-column label="原件来源"><template #default="{row}"><el-button v-for="s in row.sources" :key="`${s.document_id}:${s.source}`" link @click="openFile(s.attachment_url)">#{{s.document_id}} {{s.original_name}}</el-button></template></el-table-column></el-table></el-collapse-item></el-collapse><p>相同连连交易号已去重 {{cashDuplicates.length}} 条 · 冲突 {{cashConflicts.length}} 项。</p>
     <div v-for="c in cashConflicts" :key="c.key"><el-alert :title="c.note" type="error" :closable="false"/><el-button v-for="s in c.sources" :key="`${s.document_id}:${s.source}`" link @click="openFile(s.attachment_url)">#{{s.document_id}} {{s.original_name}}</el-button></div>
     <el-table v-if="!cashMonth" :data="report.cash_reconciliation.currencies"><el-table-column prop="currency" label="原币"/><el-table-column label="收款入账"><template #default="{row}">{{money(row.entries)}}</template></el-table-column><el-table-column label="提现本金"><template #default="{row}">{{money(row.withdrawals)}}</template></el-table-column><el-table-column label="提现手续费"><template #default="{row}">{{money(row.fees)}}</template></el-table-column></el-table>
     <el-table :data="(report.cash_reconciliation.monthly||[]).filter(row=>!cashMonth||row.month===cashMonth)">
      <el-table-column prop="month" label="交易月"/><el-table-column prop="currency" label="原币"/>
      <el-table-column label="公司入账"><template #default="{row}">{{money(row.entries)}} · {{row.entry_count}}笔</template></el-table-column>
      <el-table-column label="公司提现"><template #default="{row}">{{money(row.withdrawals)}} · {{row.withdrawal_count}}笔</template></el-table-column>
      <el-table-column label="实收手续费"><template #default="{row}">{{money(row.fees)}}</template></el-table-column>
      <el-table-column label="表列到账"><template #default="{row}"><div v-for="item in row.listed_arrivals" :key="item.currency">{{money(item.amount)}} {{item.currency}}</div></template></el-table-column>
     </el-table>
     </template>
     <h2>按实际入账月份归属</h2>
     <el-table :data="cashShopEntries">
      <el-table-column prop="month" label="入账月份"/>
      <el-table-column label="店铺"><template #default="{row}">{{row.shop_id?shopName(row.shop_id):'待确认归属'}}</template></el-table-column>
      <el-table-column prop="count" label="入账笔数"/>
      <el-table-column label="入账金额"><template #default="{row}">{{money(row.amount)}} {{row.currency}}</template></el-table-column>
     </el-table>
     <h2>连连交易明细</h2>
     <el-table :data="cashPageRows">
      <el-table-column prop="date" label="交易日期" min-width="155"/>
      <el-table-column label="店铺归属" min-width="150"><template #default="{row}">{{row.type==='withdrawal'?'公司共用':confirmedCashShops.get(row.reference)?shopName(confirmedCashShops.get(row.reference)):'待确认归属'}}</template></el-table-column>
      <el-table-column label="类型" width="95"><template #default="{row}">{{row.type==='entry'?'入账':'提现'}}</template></el-table-column>
      <el-table-column label="金额" min-width="130"><template #default="{row}">{{money(row.amount)}} {{row.currency}}</template></el-table-column>
      <el-table-column prop="reference" label="交易号" min-width="160"/>
      <el-table-column label="凭证" min-width="100"><template #default="{row}"><el-button link @click="openFile(row.attachment_url)">连连原件</el-button></template></el-table-column>
     </el-table>
     <el-pagination v-model:current-page="cashPage" :page-size="cashPageSize" :total="cashTransactions.length" layout="total, prev, pager, next"/>
     <h2>Ozon 付款匹配</h2>
     <el-button v-if="payoutCandidates.length" type="primary" :disabled="busy" @click="confirmPayouts(payoutCandidates)">确认 {{payoutCandidates.length}} 笔唯一匹配</el-button>
     <el-table :data="cashMatches">
      <el-table-column label="店铺" min-width="130"><template #default="{row}">{{shopName(row.payment.shop_id)}}</template></el-table-column>
      <el-table-column label="Ozon付款日期"><template #default="{row}">{{row.payment.date}}</template></el-table-column>
      <el-table-column label="平台转出 CNY"><template #default="{row}">{{money(row.payment.amount)}}</template></el-table-column>
      <el-table-column label="实际入账日期" min-width="150"><template #default="{row}">{{row.entry?.date||'—'}}</template></el-table-column>
      <el-table-column label="入账 CNH"><template #default="{row}">{{money(row.entry?.amount)}}</template></el-table-column>
      <el-table-column label="连连交易号" min-width="160"><template #default="{row}">{{row.entry?.reference||'—'}}</template></el-table-column>
      <el-table-column label="凭证" min-width="130"><template #default="{row}"><el-button link @click="openFile(row.payment.attachment_url)">Ozon · {{row.payment.source}}</el-button><el-button v-if="row.entry" link @click="openFile(row.entry.attachment_url)">连连原件</el-button></template></el-table-column>
      <el-table-column label="状态" min-width="140"><template #default="{row}">{{payoutStatuses[row.status]}} <el-button v-if="row.status==='amount_date_candidate'" link type="primary" :disabled="busy" @click="confirmPayouts([row])">确认</el-button></template></el-table-column>
     </el-table>
     <el-tooltip :content="report.cash_reconciliation.note"><span class="help-icon" tabindex="0" aria-label="回款匹配说明">ⓘ</span></el-tooltip><details><summary>文件内部核对</summary><div v-for="d in report.documents.filter(d=>d.parse_status==='confirmed'&&d.payload_json.controls?.length&&(!cashMonth||d.month_key===cashMonth)&&(cashShop==null||Number(d.shop_key)===cashShop))" :key="d.id"><p>{{d.original_name}}</p><div v-for="c in d.payload_json.controls" :key="c.name">{{c.name}}：{{c.amount!=null?money(c.amount):money(c.difference)}} {{c.currency}} {{c.amount==null?'（差额）':''}}</div></div></details>
    </el-tab-pane>
    <el-tab-pane label="发票审核" name="vouchers" lazy>
     <el-table :data="report.documents"><el-table-column prop="original_name" label="文件" min-width="260"/><el-table-column label="审核状态"><template #default="{row}">{{reviews[row.review_status]}}</template></el-table-column><el-table-column prop="review_note" label="审核意见" min-width="200"/><el-table-column label="操作"><template #default="{row}"><el-button link @click="review={...row}">填写意见</el-button></template></el-table-column></el-table>
    </el-tab-pane>
    <el-tab-pane label="待补资料" name="gaps" lazy><ul><li v-for="g in report.gaps" :key="g">{{g}}</li></ul><el-button @click="router.push('/profit/monthly-billing')">查看现有订单及采购成本</el-button><el-button @click="router.push('/finance/inventory-capital')">查看库存占用明细</el-button><el-button @click="router.push({path:'/finance/payroll',query:{companyId:companyId,month:month}})">查看工资资料</el-button></el-tab-pane>
   </el-tabs>
  </template>
  <el-dialog v-if="preview" :model-value="true" title="解析预览：检查后确认归档" width="min(900px,95vw)" @close="preview=null"><p>{{preview.original_name}} · {{statuses[preview.parse_status]}}</p><FinanceDocumentSource :document="preview"/><div v-if="editManual" class="upload-context"><strong>修改尚未确认的手工草稿</strong><el-select v-model="editManual.metric" aria-label="草稿费用项目" :disabled="busy"><el-option v-for="m in MANUAL_EXPENSE_METRICS" :key="m" :label="m" :value="m"/></el-select><el-input-number v-model="editManual.amount" :precision="2" :disabled="busy" aria-label="草稿金额CNY"/><el-input v-model="editManual.note" type="textarea" maxlength="1000" :disabled="busy" aria-label="草稿业务依据"/><el-button type="primary" :disabled="busy" @click="saveManualDraft">保存草稿修改</el-button></div><template v-if="preview.parse_status==='error'"><el-alert v-for="w in preview.payload_json.warnings" :key="w" :title="w" type="error" :closable="false"/></template><details v-else-if="preview.payload_json.warnings?.length"><summary>解析说明</summary><p v-for="w in preview.payload_json.warnings" :key="w">{{w}}</p></details><el-table :data="preview.payload_json.facts"><el-table-column prop="metric" label="项目"/><el-table-column prop="amount" label="金额"/><el-table-column prop="currency" label="原币"/><el-table-column prop="source" label="提取位置" min-width="240"/></el-table><p v-if="preview.payload_json.order_rows?.length">逐单明细 {{preview.payload_json.order_rows.length}} 行</p><p v-if="!preview.payload_json.facts?.length&&!preview.payload_json.order_rows?.length">配套凭证 · 仅归档</p><p>原件上传时间：{{preview.created_at?shanghaiDateTimeText(preview.created_at):'本批上传'}}</p></el-dialog>
  <el-dialog v-if="costDetail" :model-value="true" :title="costDetail.month+' · 订单采购成本'" width="min(1100px,96vw)" @close="costGeneration++;costDetail=null">
   <el-alert v-if="costDetail.error" :title="costDetail.error" type="error" :closable="false"/>
   <el-table :data="costDetail.rows" v-loading="costDetail.loading"><el-table-column prop="posting_number" label="货件号" min-width="175"/><el-table-column prop="sku" label="SKU" width="110"/><el-table-column prop="sold_quantity" label="销售件数" width="90"/><el-table-column prop="returned_quantity" label="退回件数" width="90"/><el-table-column label="采购成本 CNY" width="140"><template #default="{row}">{{money(row.amount)}}</template></el-table-column><el-table-column prop="source" label="成本依据 / 缺项" min-width="260"/><el-table-column label="原件" min-width="160"><template #default="{row}"><el-button v-for="e in row.linked_evidence" :key="e.document_id" link @click="openFile(e.attachment_url)">{{e.original_name||e.display_name}}</el-button></template></el-table-column></el-table>
   <el-pagination v-if="costDetail.total>50" :current-page="costDetail.page" :page-size="50" :total="costDetail.total" layout="total, prev, pager, next" @current-change="page=>openCostDetail(costDetail,page)"/>
  </el-dialog>
  <el-dialog v-if="costSyncOpen" :model-value="true" title="成本来源同步" width="min(800px,95vw)" :close-on-click-modal="!busy" :show-close="!busy" @close="costSyncOpen=false"><el-table :data="costSyncResults"><el-table-column prop="month" label="月份" width="110"/><el-table-column label="店铺" width="170"><template #default="{row}">{{shopName(row.shop_id)}}</template></el-table-column><el-table-column prop="status" label="状态" width="100"/><el-table-column prop="note" label="结果" min-width="260"/></el-table></el-dialog>
  <el-dialog v-if="helpOpen" :model-value="true" title="账单说明" width="min(600px,95vw)" @close="helpOpen=false">
   <p>点击金额查看店铺、项目和原件；“—”表示尚无金额记录，不等于零。</p>
   <p v-if="report">销售资料覆盖 {{report.coverage.shops_with_sales}} / {{report.coverage.shops_expected}} 家店铺。所属店铺：{{report.shops.map(s=>s.name).join('、')||'未配置'}}。</p>
   <p>参考汇总包含已解析原件和已登记费用。会计审核状态见明细；归档或会计认可不等于税务审批。</p>
   <p>原件上限20MB。平台文件选择店铺，共用费用选择公司；工资在工资管理录入。后补发票关联原业务，避免重复计费。</p>
   <p>下载指引用于查找文件；原件目录以插件记录或上传时填写的实际来源为准。</p>
  </el-dialog>
  <el-dialog v-if="review" :model-value="true" title="会计审核意见" width="min(650px,95vw)" @close="review=null"><p>{{review.original_name}}</p><el-select v-model="review.review_status"><el-option v-for="(label,value) in reviews" :key="value" :label="label" :value="value"/></el-select><el-input v-model="review.review_note" type="textarea" :rows="5" maxlength="1000" show-word-limit placeholder="填写认可依据、需补资料或纳税调整原因"/><template #footer><el-button type="primary" :loading="busy" @click="saveReview">保存审核意见</el-button></template></el-dialog>
 </div>
</template>

<style scoped>
.tab-toolbar .el-select{width:176px}.tab-toolbar :deep(.el-date-editor){width:170px}.tab-toolbar .el-input{width:190px}.tab-upload-button{margin-left:auto}.el-pagination{margin-top:14px}.category-tag{margin:3px}.upload-context{display:grid;gap:12px;padding:18px;border:1px solid var(--el-border-color);border-radius:8px}.upload-context>.el-select{width:min(100%,520px)}.missing,small{color:var(--el-text-color-secondary)}small{display:block;overflow-wrap:anywhere;margin-top:5px}.source-lines{padding:10px 20px}.source-detail{border:1px solid var(--el-border-color);padding:16px;border-radius:8px}.period-matrix{width:100%}.period-matrix :deep(.finance-group-row td){font-weight:600;background:var(--el-fill-color-light)}
.company-statements,.company-statements>*{min-width:0;max-width:100%}
.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:12px 0 20px}.totals>div{display:grid;gap:8px;padding:16px;border:1px solid var(--el-border-color);border-radius:8px}.totals span{color:var(--el-text-color-secondary)}.totals strong{font-size:22px;font-weight:500}
.company-statements{display:grid;gap:18px}.company-statements header,.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.company-statements header{justify-content:space-between}.company-statements h1{font-size:24px;margin:0}.company-statements h2{font-size:18px;margin:18px 0 10px}.company-statements p{color:var(--el-text-color-secondary);overflow-wrap:anywhere}.toolbar .el-select{width:290px}.company-statements :deep(.el-button span){white-space:normal;overflow-wrap:anywhere}.company-statements :deep(.el-dialog__body){display:grid;gap:14px}@media(max-width:700px){.toolbar{align-items:stretch}.toolbar .el-select{width:100%}.company-statements h1{font-size:21px}}
</style>


<style scoped>.download-guide{padding:10px 12px;background:var(--el-fill-color-light);border-radius:6px;line-height:1.7;overflow-wrap:anywhere;}.download-guide small{color:var(--el-text-color-secondary);}</style>


<style scoped>.help-icon{display:inline-flex;align-items:center;cursor:help;color:var(--el-text-color-secondary);font-size:13px;}</style>
