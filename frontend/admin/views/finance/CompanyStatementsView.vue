<script setup>
import FinanceDocumentSource from '../../components/finance/FinanceDocumentSource.vue';
import {OZON_DOCUMENT_FOLDERS,financeCategoryDownloadPaths,financeUploadDownloadPaths} from '../../../../src/shared/finance-document-locations.js';
import { FINANCE_FILE_CATEGORIES, financeDocumentCategories } from '../../../../src/shared/finance-document-categories.js';
import { FINANCE_GROUPS, MANUAL_EXPENSE_METRICS, UPLOAD_TYPES, financeMatrix, financeSourceShops, financeLineSign, financeExpenseRecordQuery } from '../../../../src/shared/company-finance-report.js';
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { apiClient, currentApiCacheScope, getAuthToken } from '../../utils/api';
import { useAuthStore } from '../../stores/auth';
import { canAccessPage } from '../../../../src/shared/permissions.js';
import { shanghaiDateKey, shanghaiDateTimeText } from '../../utils/shanghai-date.js';

const ApprovedH1Adjustments=defineAsyncComponent(()=>import('../../components/finance/ApprovedH1Adjustments.vue'));
const FinanceReconciliation=defineAsyncComponent(()=>import('./FinanceReconciliation.vue'));
const auth=useAuthStore(),router=useRouter(),route=useRoute();
const allowed=computed(()=>canAccessPage(auth.user,'/finance/company-statements'));
const initialMonth=/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(route.query.month||''))?String(route.query.month):shanghaiDateKey().slice(0,7);
const companies=ref([]),assignments=ref([]),allShops=ref([]),companyId=ref(''),shopId=ref(0),month=ref(initialMonth),period=ref('month');
const report=ref(null),error=ref(''),loading=ref(false),busy=ref(false),tab=ref(['documents','adjustments'].includes(route.query.tab)?route.query.tab:'summary'),preview=ref(null),editManual=ref(null),review=ref(null),fileInput=ref(null),uploads=ref([]);
const helpOpen=ref(false),costDetail=ref(null),costSyncOpen=ref(false),costSyncResults=ref([]);
let costGeneration=0;
const fileCategory=ref('all'),guideOpen=ref(false),documentMonth=ref(route.query.tab==='documents'?initialMonth:'');
const shopName=id=>Number(id)?allShops.value.find(s=>Number(s.id)===Number(id))?.name||`店铺 #${id}`:'公司共用';
const uploadMonth=ref(initialMonth),uploadType=ref('auto'),displayName=ref(''),relatedDocumentId=ref(''),manual=ref({metric:'AI使用费',amount:undefined,currency:'CNY',note:''}),selection=ref(null);
const year=computed({get:()=>month.value.slice(0,4),set:value=>{if(/^20\d{2}$/.test(String(value)))month.value=`${value}-${month.value.slice(5)}`;}});
const expandedGroups=[];
const sourcePanel=ref(null);
const sourceFolder=ref(''),sourceSection=ref('');
const selectedSourceFolder=computed(()=>OZON_DOCUMENT_FOLDERS.find(f=>f.id===sourceFolder.value));
const uploadPaths=computed(()=>financeUploadDownloadPaths(uploadType.value));
const fileCategoryGuide=FINANCE_FILE_CATEGORIES.map(c=>({...c,download_paths:financeCategoryDownloadPaths(c.id)}));

const selectedType=computed(()=>UPLOAD_TYPES.find(t=>t.value===uploadType.value));
let generation=0,controller;
const money=n=>n==null?'—':Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const shops=computed(()=>allShops.value.filter(s=>assignments.value.some(a=>Number(a.company_id)===Number(companyId.value)&&Number(a.shop_id)===Number(s.id)&&a.effective_from<=`${uploadMonth.value}-31`&&(!a.effective_to||a.effective_to>=`${uploadMonth.value}-01`))));
const windowRange=computed(()=>({from:`${year.value}-01`,to:`${year.value}-12`}));
const query=computed(()=>new URLSearchParams({company_id:companyId.value,...windowRange.value}).toString());
const categorizedDocuments=computed(()=>(report.value?.documents||[]).map(d=>({...d,categories:d.categories||financeDocumentCategories(d)})));
const monthDocuments=computed(()=>categorizedDocuments.value.filter(d=>!documentMonth.value||d.month_key===documentMonth.value));
const filteredDocuments=computed(()=>monthDocuments.value.filter(d=>fileCategory.value==='all'||d.categories.includes(fileCategory.value)));
const fileCategoryCounts=computed(()=>Object.fromEntries(FINANCE_FILE_CATEGORIES.map(c=>[c.id,monthDocuments.value.filter(d=>d.categories.includes(c.id)).length])));
const categoryName=id=>FINANCE_FILE_CATEGORIES.find(c=>c.id===id)?.name||id;
const collected=computed(()=>report.value?.collected_summary||report.value);
const matrix=computed(()=>financeMatrix(collected.value?.lines||[],year.value,period.value));
const netSales=computed(()=>collected.value?.metrics?.['已确认商品销售额']==null?null:collected.value.metrics['已确认商品销售额']-(collected.value.metrics['销售退回冲减额']||0));
const platformFees=computed(()=>{const names=FINANCE_GROUPS.find(g=>g.id==='platform').metrics,lines=(collected.value?.lines||[]).filter(l=>names.includes(l.metric));return lines.length?lines.reduce((s,l)=>s+l.amount,0):null;});
const registeredCosts=computed(()=>{const lines=(collected.value?.lines||[]).filter(l=>['payroll','recorded-expense'].includes(l.source_type));return lines.length?lines.reduce((n,l)=>n+l.amount,0):null;});
const sourceLines=computed(()=>selection.value?(collected.value?.lines||[]).filter(l=>l.month>=selection.value.period.from&&l.month<=selection.value.period.to&&selection.value.row.metrics.includes(l.metric)):[]);
const sourceShops=computed(()=>financeSourceShops(sourceLines.value,sourceLines.value.some(l=>Number(l.shop_id)>0&&!['payroll','recorded-expense'].includes(l.source_type))?(report.value?.shops||[]):[]).map(s=>({...s,amount:s.lines.some(l=>l.amount==null)?null:s.lines.length?s.lines.reduce((n,l)=>n+l.amount*(selection.value?.row.id==='income'||selection.value?.row.refund?financeLineSign(l.metric):1),0):null})));
const linkableDocuments=computed(()=>(report.value?.documents||[]).filter(d=>d.parse_status==='confirmed'&&Number(d.shop_key)===Number(shopId.value)&&d.month_key===uploadMonth.value));
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
async function upload(event){
 const files=Array.from(event.target.files||[]);event.target.value='';if(!files.length)return;
 if(uploadType.value==='manual-expense'&&files.length!==1){ElMessage.error('手工费用请一次选择一份业务依据，避免同一金额重复记账');return;}
 const scope=currentApiCacheScope(),company=companyId.value,shop=shopId.value,selectedMonth=uploadMonth.value,type=uploadType.value,label=displayName.value,related=relatedDocumentId.value,manualValue={...manual.value},location=sourceFolder.value?{platform:'ozon',folder_id:sourceFolder.value,section:sourceSection.value}:undefined;busy.value=true;uploads.value=[];
 try{
  for(const file of files){
   if(scope!==currentApiCacheScope()||!allowed.value)break;
   try{
    if(file.size>20*1024*1024)throw new Error('文件超过20MB，请拆分');
    const form=new FormData();form.append('file',file);const token=getAuthToken();
    const response=await fetch('/api/finance-center/voucher-attachments',{method:'POST',body:form,headers:token?{Authorization:`Bearer ${token}`}:{}});
    const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'原件上传失败');
    if(scope!==currentApiCacheScope()||!allowed.value)break;
    const parsed=await apiClient.post('/api/finance-center/document-import',{action:'preview',company_id:company,shop_id:shop,month:type==='collection-cash'?undefined:selectedMonth,attachment_url:data.url,upload_type:type,display_name:label,source_location:location,related_document_id:related||undefined,manual:type==='manual-expense'?manualValue:undefined});
    if(scope!==currentApiCacheScope())break;
    uploads.value.push({name:file.name,status:statuses[parsed.document.parse_status]+(parsed.duplicate?'（已有原件，未重复计费）':''),note:parsed.document.payload_json?.transaction_period?`${parsed.document.payload_json.transaction_period.from} 至 ${parsed.document.payload_json.transaction_period.to} · ${parsed.document.payload_json.cash.length} 笔`:parsed.document.payload_json?.warnings?.join('；')});
   }catch(e){if(scope!==currentApiCacheScope())break;uploads.value.push({name:file.name,status:'未完成',note:e.message});}
  }
  if(scope===currentApiCacheScope())await load();
 }finally{busy.value=false;}
}
function openPreview(doc){preview.value=doc;editManual.value=doc.parse_status==='preview'&&doc.payload_json.kind==='manual-expense'?{...doc.payload_json.manual}:null;}
async function saveManualDraft(){
 const scope=currentApiCacheScope(),doc=preview.value;busy.value=true;
 try{await apiClient.post('/api/finance-center/document-import',{action:'preview',company_id:companyId.value,shop_id:doc.shop_key,month:doc.month_key,attachment_url:doc.attachment_url,upload_type:'manual-expense',display_name:doc.payload_json.display_name,manual:{...editManual.value},expected_revision:Number(doc.revision||0)});if(scope!==currentApiCacheScope())return;preview.value=null;ElMessage.success('草稿已保存，请重新预览后确认归档');await load();}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
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
watch(uploadType,()=>{sourceFolder.value='';sourceSection.value='';});
watch(shopId,()=>{relatedDocumentId.value='';});
watch(companyId,()=>{sourceFolder.value='';sourceSection.value='';uploadType.value='auto';displayName.value='';manual.value={metric:'AI使用费',amount:undefined,currency:'CNY',note:''};relatedDocumentId.value='';});
watch(uploadMonth,value=>{if(value&&value.slice(0,4)!==year.value)year.value=value.slice(0,4);});
watch([uploadMonth,uploadType],()=>{relatedDocumentId.value='';if(selectedType.value?.shared)shopId.value=0;});
watch(query,()=>{if(documentMonth.value&&documentMonth.value.slice(0,4)!==year.value)documentMonth.value='';shopId.value=0;uploads.value=[];review.value=null;load();});
watch(period,()=>{selection.value=null;});
onBeforeUnmount(()=>{costGeneration++;generation++;controller?.abort();});
</script>

<template>
 <div v-if="allowed" class="company-statements">
  <header><div><h1>公司账单</h1></div><div class="toolbar"><el-button text @click="helpOpen=true">说明</el-button><el-button @click="router.push('/finance-center')">公司设置</el-button></div></header>
  <div class="toolbar">
   <el-select v-model="companyId" aria-label="公司主体" placeholder="选择公司" :disabled="busy"><el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" /></el-select>
   <el-date-picker v-if="tab!=='reconciliation'" v-model="year" type="year" value-format="YYYY" format="YYYY年" :clearable="false" aria-label="报表年度" :disabled="busy" />
   <el-radio-group v-if="tab!=='reconciliation'" v-model="period" :disabled="busy"><el-radio-button value="month">月度</el-radio-button><el-radio-button value="quarter">季度</el-radio-button><el-radio-button value="year">年度</el-radio-button></el-radio-group>
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
     <div class="toolbar"><el-button @click="guideOpen=!guideOpen">{{guideOpen?'收起分类':'文件分类'}}</el-button><span>{{monthDocuments.length}} 份原件</span></div>
     <el-table v-if="guideOpen" :data="fileCategoryGuide" border class="category-guide"><el-table-column prop="name" label="文件类别" min-width="160"/><el-table-column prop="examples" label="上传什么文件" min-width="260"/><el-table-column label="下载位置 / 提供方" min-width="340"><template #default="{row}"><div v-for="path in row.download_paths" :key="path">{{path}}</div><span v-if="!row.download_paths.length">供应商、公司或服务商提供凭证</span></template></el-table-column><el-table-column prop="effect" label="如何入账 / 避免重复" min-width="300"/></el-table>
     <div class="toolbar"><el-date-picker v-model="documentMonth" type="month" value-format="YYYY-MM" format="YYYY年MM月" placeholder="全部月份" aria-label="凭证月份筛选"/><el-select v-model="fileCategory" aria-label="文件类别筛选"><el-option value="all" :label="`全部类别（${monthDocuments.length}份）`"/><el-option v-for="c in FINANCE_FILE_CATEGORIES" :key="c.id" :value="c.id" :label="`${c.name}（${fileCategoryCounts[c.id]||0}份）`"/></el-select></div>
     <details :open="route.query.tab!=='documents'"><summary>手动上传原件</summary><div class="upload-context"><strong>业务归属</strong><div class="toolbar"><el-date-picker v-if="uploadType!=='collection-cash'" v-model="uploadMonth" type="month" value-format="YYYY-MM" format="YYYY年MM月" :clearable="false" aria-label="上传业务月份" :disabled="busy"/><el-select v-model="shopId" aria-label="上传归属" :disabled="busy||selectedType?.shared"><el-option :value="0" label="公司共用（连连、场地、AI等）"/><el-option v-for="s in shops" :key="s.id" :label="s.name" :value="Number(s.id)"/></el-select></div>
      <strong>报告用途</strong><el-select v-model="uploadType" aria-label="上传类型" :disabled="busy"><el-option v-for="t in UPLOAD_TYPES" :key="t.value" :value="t.value" :label="t.label"/></el-select><el-tooltip :content="selectedType?.hint" placement="top"><span class="help-icon" tabindex="0" aria-label="查看上传用途说明">ⓘ</span></el-tooltip>
      <div class="download-guide"><strong>到哪里下载</strong><div v-for="path in uploadPaths" :key="path">{{path}}</div></div>
      <div v-if="!['collection-cash','manual-expense','payroll','order-sales'].includes(uploadType)" class="toolbar"><el-select v-model="sourceFolder" clearable aria-label="原件在Ozon的下载目录" placeholder="Ozon 文件夹（选填）" :disabled="busy"><el-option v-for="f in OZON_DOCUMENT_FOLDERS" :key="f.id" :value="f.id" :label="f.name"/></el-select><el-select v-if="selectedSourceFolder?.sections.length" v-model="sourceSection" clearable aria-label="Ozon下载子目录" placeholder="子目录（选填）" :disabled="busy"><el-option v-for="section in selectedSourceFolder.sections" :key="section" :value="section" :label="section"/></el-select></div>
      <el-input v-model="displayName" :disabled="busy" maxlength="180" placeholder="显示名称（选填）" aria-label="中文显示名称"/>
      <template v-if="uploadType==='manual-expense'"><div class="toolbar"><el-select v-model="manual.metric" aria-label="手工费用项目" :disabled="busy"><el-option v-for="m in MANUAL_EXPENSE_METRICS" :key="m" :label="m" :value="m"/></el-select><el-input-number v-model="manual.amount" :precision="2" :step="1" :disabled="busy" aria-label="手工金额CNY"/><el-tooltip content="单位CNY；汇兑损益：损失填正数，收益填负数。"><span class="help-icon" tabindex="0" aria-label="金额填写说明">ⓘ</span></el-tooltip></div><el-input v-model="manual.note" type="textarea" maxlength="1000" :disabled="busy" placeholder="费用用途、服务期间及依据" aria-label="费用业务依据"/></template>
      <el-select v-if="['support','payroll'].includes(uploadType)" v-model="relatedDocumentId" clearable filterable placeholder="关联业务（选填）" aria-label="关联原业务" :disabled="busy"><el-option v-for="d in linkableDocuments" :key="d.id" :value="d.id" :label="`#${d.id} ${d.month_key} ${d.payload_json.display_name||d.original_name}`"/></el-select>
      <div><el-button type="primary" :disabled="busy||!companyId||(uploadType!=='collection-cash'&&!uploadMonth)" @click="fileInput.click()">上传原件</el-button><el-button v-if="uploadType==='payroll'" @click="router.push({path:'/finance/payroll',query:{companyId:companyId,month:uploadMonth}})">工资管理</el-button><input ref="fileInput" type="file" :multiple="uploadType!=='manual-expense'" accept=".pdf,.xlsx,.json,.png,.jpg,.jpeg,.webp" hidden @change="upload"/></div>
     </div>
     <el-table v-if="uploads.length" :data="uploads"><el-table-column prop="name" label="本批文件"/><el-table-column prop="status" label="结果"/><el-table-column prop="note" label="提示" min-width="240"/></el-table>
     </details>
     <el-table :data="filteredDocuments"><el-table-column label="店铺" min-width="150"><template #default="{row}">{{shopName(row.shop_key)}}</template></el-table-column><el-table-column prop="month_key" label="归档月份" width="110"/><el-table-column label="显示名称 / 原始文件名" min-width="300"><template #default="{row}"><span>{{row.payload_json.display_name||row.original_name}}</span><small v-if="row.payload_json.display_name">{{row.original_name}}</small></template></el-table-column><el-table-column label="平台目录 / 原件来源" min-width="350"><template #default="{row}"><FinanceDocumentSource :document="row"/></template></el-table-column><el-table-column label="文件分类" min-width="190"><template #default="{row}"><el-tag v-for="c in row.categories" :key="c" size="small" class="category-tag">{{categoryName(c)}}</el-tag></template></el-table-column><el-table-column label="用途" min-width="150"><template #default="{row}">{{UPLOAD_TYPES.find(t=>t.value===row.payload_json.upload_type)?.label||'平台自动识别'}}<small v-if="row.payload_json.archive_source">插件同步 · {{row.payload_json.archive_source.folder_name}}</small><small v-if="row.payload_json.related_document_id">关联业务 #{{row.payload_json.related_document_id}}</small></template></el-table-column><el-table-column label="解析状态" width="140"><template #default="{row}">{{ statuses[row.parse_status] }}</template></el-table-column><el-table-column label="操作" width="240"><template #default="{row}"><el-button link :aria-label="`预览 ${row.original_name}`" @click="openPreview(row)">预览</el-button><el-button link @click="openFile(row.attachment_url)">原件</el-button><el-button v-if="row.parse_status==='preview'" link type="primary" :disabled="busy" :aria-label="`确认归档 ${row.original_name}`" @click="confirm(row)">确认归档</el-button></template></el-table-column></el-table>
    </el-tab-pane>
    <el-tab-pane label="调整账簿" name="adjustments" lazy>
     <ApprovedH1Adjustments v-if="tab==='adjustments'" :key="companyId" :company-id="companyId" :from="windowRange.from" :to="windowRange.to" :shops="allShops.filter(s=>assignments.some(a=>Number(a.company_id)===Number(companyId)&&Number(a.shop_id)===Number(s.id)))"/>
    </el-tab-pane>
    <el-tab-pane label="订单对账" name="reconciliation" lazy>
     <FinanceReconciliation v-if="tab==='reconciliation'" :key="companyId" :company-id="companyId" :shops="allShops.filter(s=>assignments.some(a=>Number(a.company_id)===Number(companyId)&&Number(a.shop_id)===Number(s.id)))" :initial-month="month" @documents-changed="refreshDocuments"/>
    </el-tab-pane>
    <el-tab-pane label="结算回款" name="cash" lazy>
     <el-collapse><el-collapse-item :title="`重复交易来源（${report.cash_reconciliation.duplicates?.length||0}条）`"><el-table :data="report.cash_reconciliation.duplicates||[]"><el-table-column prop="reference" label="交易编号"/><el-table-column label="原件来源"><template #default="{row}"><el-button v-for="s in row.sources" :key="`${s.document_id}:${s.source}`" link @click="openFile(s.attachment_url)">#{{s.document_id}} {{s.original_name}}</el-button></template></el-table-column></el-table></el-collapse-item></el-collapse><p>相同连连交易号已去重 {{report.cash_reconciliation.duplicates?.length||0}} 条 · 冲突 {{report.cash_reconciliation.conflicts?.length||0}} 项。</p>
     <div v-for="c in report.cash_reconciliation.conflicts||[]" :key="c.key"><el-alert :title="c.note" type="error" :closable="false"/><el-button v-for="s in c.sources" :key="`${s.document_id}:${s.source}`" link @click="openFile(s.attachment_url)">#{{s.document_id}} {{s.original_name}}</el-button></div>
     <el-table :data="report.cash_reconciliation.currencies"><el-table-column prop="currency" label="原币"/><el-table-column label="收款入账"><template #default="{row}">{{money(row.entries)}}</template></el-table-column><el-table-column label="提现本金"><template #default="{row}">{{money(row.withdrawals)}}</template></el-table-column><el-table-column label="提现手续费"><template #default="{row}">{{money(row.fees)}}</template></el-table-column></el-table>
     <el-table :data="report.cash_reconciliation.monthly||[]">
      <el-table-column prop="month" label="交易月"/><el-table-column prop="currency" label="原币"/>
      <el-table-column label="公司入账"><template #default="{row}">{{money(row.entries)}} · {{row.entry_count}}笔</template></el-table-column>
      <el-table-column label="公司提现"><template #default="{row}">{{money(row.withdrawals)}} · {{row.withdrawal_count}}笔</template></el-table-column>
      <el-table-column label="实收手续费"><template #default="{row}">{{money(row.fees)}}</template></el-table-column>
      <el-table-column label="表列到账"><template #default="{row}"><div v-for="item in row.listed_arrivals" :key="item.currency">{{money(item.amount)}} {{item.currency}}</div></template></el-table-column>
     </el-table>
     <el-table :data="report.cash_reconciliation.shop_payments||[]">
      <el-table-column label="店铺"><template #default="{row}">{{report.shops.find(shop=>Number(shop.id)===row.shop_id)?.name||row.shop_id}}</template></el-table-column>
      <el-table-column label="Ozon付款凭证合计"><template #default="{row}">{{money(row.amount)}} {{row.currency}}</template></el-table-column>
      <el-table-column prop="payment_count" label="付款笔数"/><el-table-column prop="candidate_count" label="连连入账候选笔数"/>
     </el-table>
     <el-table :data="report.cash_reconciliation.matches"><el-table-column label="平台转出日期"><template #default="{row}">{{row.payment.date}}</template></el-table-column><el-table-column label="平台转出 CNY"><template #default="{row}">{{money(row.payment.amount)}}</template></el-table-column><el-table-column label="入账日期"><template #default="{row}">{{row.entry?.date||'未匹配'}}</template></el-table-column><el-table-column label="入账 CNH"><template #default="{row}">{{money(row.entry?.amount)}}</template></el-table-column><el-table-column label="状态"><template #default="{row}">{{row.status==='amount_date_candidate'?'金额日期候选，归属待核':row.status==='ambiguous'?'多笔候选，待人工核对':'未匹配'}}</template></el-table-column></el-table>
     <el-tooltip :content="report.cash_reconciliation.note"><span class="help-icon" tabindex="0" aria-label="回款匹配说明">ⓘ</span></el-tooltip><h2>文件内部核对</h2><div v-for="d in report.documents.filter(d=>d.parse_status==='confirmed'&&d.payload_json.controls?.length)" :key="d.id"><p>{{d.original_name}}</p><div v-for="c in d.payload_json.controls" :key="c.name">{{c.name}}：{{c.amount!=null?money(c.amount):money(c.difference)}} {{c.currency}} {{c.amount==null?'（差额）':''}}</div></div>
    </el-tab-pane>
    <el-tab-pane label="发票审核" name="vouchers" lazy>
     <el-table :data="report.documents"><el-table-column prop="original_name" label="文件" min-width="260"/><el-table-column label="审核状态"><template #default="{row}">{{reviews[row.review_status]}}</template></el-table-column><el-table-column prop="review_note" label="审核意见" min-width="200"/><el-table-column label="操作"><template #default="{row}"><el-button link @click="review={...row}">填写意见</el-button></template></el-table-column></el-table>
    </el-tab-pane>
    <el-tab-pane label="待补资料" name="gaps" lazy><ul><li v-for="g in report.gaps" :key="g">{{g}}</li></ul><el-button @click="router.push('/profit/monthly-billing')">查看现有订单及采购成本</el-button><el-button @click="router.push('/finance/inventory-capital')">查看库存占用明细</el-button><el-button @click="router.push({path:'/finance/payroll',query:{companyId:companyId,month:uploadMonth}})">查看工资资料</el-button></el-tab-pane>
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
.category-guide{margin:12px 0}.category-tag{margin:3px}.upload-context{display:grid;gap:12px;padding:18px;border:1px solid var(--el-border-color);border-radius:8px}.upload-context>.el-select{width:min(100%,520px)}.missing,small{color:var(--el-text-color-secondary)}small{display:block;overflow-wrap:anywhere;margin-top:5px}.source-lines{padding:10px 20px}.source-detail{border:1px solid var(--el-border-color);padding:16px;border-radius:8px}.period-matrix{width:100%}.period-matrix :deep(.finance-group-row td){font-weight:600;background:var(--el-fill-color-light)}
.company-statements,.company-statements>*{min-width:0;max-width:100%}
.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:12px 0 20px}.totals>div{display:grid;gap:8px;padding:16px;border:1px solid var(--el-border-color);border-radius:8px}.totals span{color:var(--el-text-color-secondary)}.totals strong{font-size:22px;font-weight:500}
.company-statements{display:grid;gap:18px}.company-statements header,.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.company-statements header{justify-content:space-between}.company-statements h1{font-size:24px;margin:0}.company-statements h2{font-size:18px;margin:18px 0 10px}.company-statements p{color:var(--el-text-color-secondary);overflow-wrap:anywhere}.toolbar .el-select{width:290px}.company-statements :deep(.el-button span){white-space:normal;overflow-wrap:anywhere}.company-statements :deep(.el-dialog__body){display:grid;gap:14px}@media(max-width:700px){.toolbar{align-items:stretch}.toolbar .el-select{width:100%}.company-statements h1{font-size:21px}}
</style>


<style scoped>.download-guide{padding:10px 12px;background:var(--el-fill-color-light);border-radius:6px;line-height:1.7;overflow-wrap:anywhere;}.download-guide small{color:var(--el-text-color-secondary);}</style>


<style scoped>.help-icon{display:inline-flex;align-items:center;cursor:help;color:var(--el-text-color-secondary);font-size:13px;}</style>
