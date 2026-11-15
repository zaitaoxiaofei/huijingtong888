<script setup>
import { FINANCE_GROUPS, MANUAL_EXPENSE_METRICS, UPLOAD_TYPES, financeMatrix, financeSourceShops, financeLineSign } from '../../../../src/shared/company-finance-report.js';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { apiClient, currentApiCacheScope, getAuthToken } from '../../utils/api';
import { useAuthStore } from '../../stores/auth';
import { canAccessPage } from '../../../../src/shared/permissions.js';
import { shanghaiDateKey, shanghaiDateTimeText } from '../../utils/shanghai-date.js';

const auth=useAuthStore(),router=useRouter(),route=useRoute();
const allowed=computed(()=>canAccessPage(auth.user,'/finance/company-statements'));
const initialMonth=/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(route.query.month||''))?String(route.query.month):shanghaiDateKey().slice(0,7);
const companies=ref([]),assignments=ref([]),allShops=ref([]),companyId=ref(''),shopId=ref(0),month=ref(initialMonth),period=ref('month');
const report=ref(null),error=ref(''),loading=ref(false),busy=ref(false),tab=ref('summary'),preview=ref(null),editManual=ref(null),review=ref(null),fileInput=ref(null),uploads=ref([]);
const uploadMonth=ref(initialMonth),uploadType=ref('auto'),displayName=ref(''),relatedDocumentId=ref(''),manual=ref({metric:'AI使用费',amount:undefined,currency:'CNY',note:''}),selection=ref(null);
const year=computed({get:()=>month.value.slice(0,4),set:value=>{if(/^20\d{2}$/.test(String(value)))month.value=`${value}-${month.value.slice(5)}`;}});
const expandedGroups=['income','platform'];
const selectedType=computed(()=>UPLOAD_TYPES.find(t=>t.value===uploadType.value));
let generation=0,controller;
const money=n=>n==null?'待补':Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const shops=computed(()=>allShops.value.filter(s=>assignments.value.some(a=>Number(a.company_id)===Number(companyId.value)&&Number(a.shop_id)===Number(s.id)&&a.effective_from<=`${uploadMonth.value}-31`&&(!a.effective_to||a.effective_to>=`${uploadMonth.value}-01`))));
const windowRange=computed(()=>({from:`${year.value}-01`,to:`${year.value}-12`}));
const query=computed(()=>new URLSearchParams({company_id:companyId.value,...windowRange.value,period_mode:period.value}).toString());
const matrix=computed(()=>financeMatrix(report.value?.lines||[],year.value,period.value));
const netSales=computed(()=>report.value?.metrics?.['已确认商品销售额']==null?null:report.value.metrics['已确认商品销售额']-(report.value.metrics['销售退回冲减额']||0));
const platformFees=computed(()=>{const names=FINANCE_GROUPS.find(g=>g.id==='platform').metrics,lines=(report.value?.lines||[]).filter(l=>names.includes(l.metric));return lines.length?lines.reduce((s,l)=>s+l.amount,0):null;});
const sourceLines=computed(()=>selection.value?(report.value?.lines||[]).filter(l=>l.month>=selection.value.period.from&&l.month<=selection.value.period.to&&selection.value.row.metrics.includes(l.metric)):[]);
const sourceShops=computed(()=>financeSourceShops(sourceLines.value,report.value?.shops||[]).map(s=>({...s,amount:s.lines.length?s.lines.reduce((n,l)=>n+l.amount*(selection.value?.row.id==='income'||selection.value?.row.refund?financeLineSign(l.metric):1),0):null})));
const linkableDocuments=computed(()=>(report.value?.documents||[]).filter(d=>d.parse_status==='confirmed'&&Number(d.shop_key)===Number(shopId.value)&&d.month_key===uploadMonth.value));
function selectCell(row,p){selection.value={row,period:p};}
const statuses={preview:'待确认',confirmed:'已确认归档',error:'解析/归属待处理'};
const reviews={pending:'待会计审核',accepted:'会计认可',needs_info:'需补资料',adjustment:'需纳税调整'};
function current(token,scope){return token===generation&&scope===currentApiCacheScope()&&allowed.value;}
async function load(){
 const token=++generation,scope=currentApiCacheScope();controller?.abort();controller=new AbortController();report.value=null;preview.value=null;selection.value=null;error.value='';
 if(!allowed.value||!companyId.value)return;
 loading.value=true;
 try{const data=await apiClient.get(`/api/finance-center/document-report?${query.value}`,{signal:controller.signal,noCache:true});if(current(token,scope)){if(!data?.coverage||!Array.isArray(data.lines)||!Array.isArray(data.documents))throw new Error('报表返回内容不完整，请刷新；持续出现时请检查当前访问的服务地址');report.value=data;}}
 catch(e){if(current(token,scope)&&e.name!=='AbortError')error.value=e.message;}
 finally{if(token===generation)loading.value=false;}
}
async function setup(){
 const scope=currentApiCacheScope(),token=++generation;controller?.abort();report.value=null;companies.value=[];allShops.value=[];assignments.value=[];companyId.value='';uploads.value=[];review.value=null;error.value='';
 if(!allowed.value)return;
 try{const data=await apiClient.get('/api/finance-center/companies',{noCache:true});if(!current(token,scope))return;companies.value=data.companies;assignments.value=data.assignments;allShops.value=data.shops;companyId.value=String(data.companies[0]?.id||'');}
 catch(e){if(current(token,scope))error.value=e.message;}
}
async function upload(event){
 const files=Array.from(event.target.files||[]);event.target.value='';if(!files.length)return;
 if(uploadType.value==='manual-expense'&&files.length!==1){ElMessage.error('手工费用请一次选择一份业务依据，避免同一金额重复记账');return;}
 const scope=currentApiCacheScope(),company=companyId.value,shop=shopId.value,selectedMonth=uploadMonth.value,type=uploadType.value,label=displayName.value,related=relatedDocumentId.value,manualValue={...manual.value};busy.value=true;uploads.value=[];
 try{
  for(const file of files){
   if(scope!==currentApiCacheScope()||!allowed.value)break;
   try{
    if(file.size>20*1024*1024)throw new Error('文件超过20MB，请拆分');
    const form=new FormData();form.append('file',file);const token=getAuthToken();
    const response=await fetch('/api/finance-center/voucher-attachments',{method:'POST',body:form,headers:token?{Authorization:`Bearer ${token}`}:{}});
    const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'原件上传失败');
    if(scope!==currentApiCacheScope()||!allowed.value)break;
    const parsed=await apiClient.post('/api/finance-center/document-import',{action:'preview',company_id:company,shop_id:shop,month:selectedMonth,attachment_url:data.url,upload_type:type,display_name:label,related_document_id:related||undefined,manual:type==='manual-expense'?manualValue:undefined});
    if(scope!==currentApiCacheScope())break;
    uploads.value.push({name:file.name,status:statuses[parsed.document.parse_status]+(parsed.duplicate?'（已有原件，未重复计费）':''),note:parsed.document.payload_json?.warnings?.join('；')});
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
watch(shopId,()=>{relatedDocumentId.value='';});
watch(companyId,()=>{uploadType.value='auto';displayName.value='';manual.value={metric:'AI使用费',amount:undefined,currency:'CNY',note:''};relatedDocumentId.value='';});
watch(uploadMonth,value=>{if(value&&value.slice(0,4)!==year.value)year.value=value.slice(0,4);});
watch([uploadMonth,uploadType],()=>{relatedDocumentId.value='';if(selectedType.value?.shared)shopId.value=0;});
watch([companyId,month,period],()=>{shopId.value=0;uploads.value=[];review.value=null;load();});
onBeforeUnmount(()=>{generation++;controller?.abort();});
</script>

<template>
 <div v-if="allowed" class="company-statements">
  <header><div><h1>公司账单与凭证</h1><p>公司汇总 → 店铺明细 → 原始文件。已采集金额与完整公司账分开显示。</p></div><el-button @click="router.push('/finance-center')">公司与店铺设置</el-button></header>
  <div class="toolbar">
   <el-select v-model="companyId" aria-label="公司主体" placeholder="选择公司" :disabled="busy"><el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" /></el-select>
   <el-date-picker v-model="year" type="year" value-format="YYYY" format="YYYY年" :clearable="false" aria-label="报表年度" :disabled="busy" />
   <el-radio-group v-model="period" :disabled="busy"><el-radio-button value="month">月度</el-radio-button><el-radio-button value="quarter">季度</el-radio-button><el-radio-button value="year">年度</el-radio-button></el-radio-group>
   <el-button :disabled="busy||!report" @click="download">导出全年交接包（草稿）</el-button><el-button :disabled="busy" @click="load">刷新</el-button>
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" />
  <el-empty v-if="!companies.length&&!error" description="请先在经营总览的公司设置中配置主体及店铺归属" />
  <template v-if="report">
   <el-alert type="warning" :closable="false" :title="`本年度已收到部分销售资料的店铺 ${report.coverage.shops_with_sales}/${report.coverage.shops_expected}。公司账尚未齐全，未提供金额不作零。采购、工资社保和银行到账仍需核对。`" />
   <el-tabs v-model="tab">
    <el-tab-pane label="公司汇总与店铺明细" name="summary">
     <div class="totals"><div><span>{{year}}年 · 已采集商品净销售 CNY</span><strong>{{money(netSales)}}</strong></div><div><span>{{year}}年 · 已采集平台费用 CNY</span><strong>{{money(platformFees)}}</strong></div><div><span>公司完整利润 / 税前扣除额</span><strong>待会计核对</strong></div></div>
     <p>收入减去退货冲减；支出按分类单列。所有金额为已确认资料的部分合计，采购支出与设备购置不直接计入当期费用。点击分类箭头展开项目，再点金额查看店铺及原件。</p>
     <el-table class="period-matrix" :data="matrix.rows" row-key="id" :expand-row-keys="expandedGroups" :row-class-name="({row})=>row.children?'finance-group-row':''" :tree-props="{children:'children'}" border v-loading="loading" :max-height="650">
      <el-table-column prop="name" label="项目 / CNY" fixed min-width="285"/>
      <el-table-column v-for="p in matrix.periods" :key="p.id" :label="p.label" :min-width="period==='month'?130:180" align="right"><template #header><span>{{p.label}}</span> <el-button link type="primary" :disabled="busy" :aria-label="`导出${p.label}交接包`" @click="download(p)">导出</el-button></template><template #default="{row}"><el-button v-if="row.cells[p.id]!=null" link type="primary" :aria-label="`${row.name} ${p.label} 查看明细`" @click="selectCell(row,p)">{{row.refund?'− ':''}}{{money(row.cells[p.id])}}</el-button><span v-else class="missing">待补</span></template></el-table-column>
     </el-table>
     <p>“待补”表示没有已确认金额，不等于零；分类合计仍可能缺少其他店铺或费用。人工、采购成本与税费尚未接入的项目保留待补，不推算完整利润。</p>
     <section v-if="selection" class="source-detail"><h2>{{selection.row.name}} · {{selection.period.label}} · 店铺及原始凭证</h2>
      <el-table :data="sourceShops" row-key="id" :default-expand-all="true">
       <el-table-column type="expand"><template #default="{row:shop}"><el-table v-if="shop.lines.length" :data="shop.lines" class="source-lines"><el-table-column prop="month" label="业务月份" width="110"/><el-table-column prop="metric" label="项目" min-width="170"/><el-table-column label="金额 CNY" width="130"><template #default="{row}">{{row.metric==='销售退回冲减额'?'− ':''}}{{money(row.amount)}}</template></el-table-column><el-table-column prop="source" label="提取位置 / 录入依据" min-width="220"/><el-table-column label="原件（原始名称保留）" min-width="260"><template #default="{row}"><el-button link type="primary" @click="openFile(row.attachment_url)">{{row.display_name||row.original_name}}</el-button><small v-if="row.display_name!==row.original_name">{{row.original_name}}</small><div v-for="e in row.linked_evidence" :key="e.document_id"><el-button link type="primary" @click="openFile(e.attachment_url)">配套：{{e.display_name}}</el-button><small>{{reviews[e.review_status]}}</small></div></template></el-table-column><el-table-column label="凭证审核" width="130"><template #default="{row}">{{reviews[row.review_status]||'待会计审核'}}</template></el-table-column></el-table><p v-else class="source-lines">该店铺在此期间尚无已确认来源，请补齐资料。</p></template></el-table-column>
       <el-table-column prop="name" label="店铺 / 公司共用"/><el-table-column label="已采集金额 CNY" align="right"><template #default="{row}">{{money(row.amount)}}</template></el-table-column>
      </el-table>
      <el-empty v-if="!sourceShops.length" description="该期间没有已确认来源"/>
     </section>
     <p>公司所属店铺：{{ report.shops.map(s=>s.name).join('、') || '尚未配置' }}。无对应资料的店铺继续列为缺件。</p>
    </el-tab-pane>
    <el-tab-pane label="上传、解析与归档" name="documents">
     <div class="upload-context"><strong>1. 确认业务归属与月份</strong><div class="toolbar"><el-date-picker v-model="uploadMonth" type="month" value-format="YYYY-MM" format="YYYY年MM月" :clearable="false" aria-label="上传业务月份" :disabled="busy"/><el-select v-model="shopId" aria-label="上传归属" :disabled="busy||selectedType?.shared"><el-option :value="0" label="公司共用（连连、场地、AI等）"/><el-option v-for="s in shops" :key="s.id" :label="s.name" :value="Number(s.id)"/></el-select></div>
      <strong>2. 选择报告用途</strong><el-select v-model="uploadType" aria-label="上传类型" :disabled="busy"><el-option v-for="t in UPLOAD_TYPES" :key="t.value" :value="t.value" :label="t.label"/></el-select><p>{{selectedType?.hint}}</p>
      <el-input v-model="displayName" :disabled="busy" maxlength="180" placeholder="中文显示名称（选填）；俄文原始文件名完整保留" aria-label="中文显示名称"/>
      <template v-if="uploadType==='manual-expense'"><div class="toolbar"><el-select v-model="manual.metric" aria-label="手工费用项目" :disabled="busy"><el-option v-for="m in MANUAL_EXPENSE_METRICS" :key="m" :label="m" :value="m"/></el-select><el-input-number v-model="manual.amount" :precision="2" :step="1" :disabled="busy" aria-label="手工金额CNY"/><span>CNY；本次仅录一笔。汇兑损益：损失填正数，收益填负数。</span></div><el-input v-model="manual.note" type="textarea" maxlength="1000" :disabled="busy" placeholder="填写费用用途、供应商、实际服务期间及依据；预付充值选择押金及预付款" aria-label="费用业务依据"/></template>
      <el-select v-if="['support','payroll'].includes(uploadType)" v-model="relatedDocumentId" clearable filterable placeholder="关联已确认业务（选填，不再记费）" aria-label="关联原业务" :disabled="busy"><el-option v-for="d in linkableDocuments" :key="d.id" :value="d.id" :label="`#${d.id} ${d.month_key} ${d.payload_json.display_name||d.original_name}`"/></el-select>
      <div><el-button type="primary" :disabled="busy||!companyId||!uploadMonth" @click="fileInput.click()">3. 选择原件，上传并预览</el-button><el-button v-if="uploadType==='payroll'" @click="router.push('/finance/payroll')">前往工资管理录入金额</el-button><input ref="fileInput" type="file" :multiple="uploadType!=='manual-expense'" accept=".pdf,.xlsx,.png,.jpg,.jpeg,.webp" hidden @change="upload"/></div>
     </div>
     <p>单文件不超过20MB。平台文件选择店铺；共用费用只录一次。按正文业务月份上传，跨月退货按本次账单月份汇总，原订单信息见原始报告；确认归档后才纳入金额。手工业务至少附一份账单或付款依据，后补发票用“仅归档”关联原业务。</p>
     <el-table v-if="uploads.length" :data="uploads"><el-table-column prop="name" label="本批文件"/><el-table-column prop="status" label="结果"/><el-table-column prop="note" label="提示" min-width="240"/></el-table>
     <el-table :data="report.documents"><el-table-column prop="month_key" label="归档月份" width="110"/><el-table-column label="显示名称 / 原始文件名" min-width="300"><template #default="{row}"><span>{{row.payload_json.display_name||row.original_name}}</span><small v-if="row.payload_json.display_name">{{row.original_name}}</small></template></el-table-column><el-table-column label="用途" min-width="150"><template #default="{row}">{{UPLOAD_TYPES.find(t=>t.value===row.payload_json.upload_type)?.label||'平台自动识别'}}<small v-if="row.payload_json.related_document_id">关联业务 #{{row.payload_json.related_document_id}}</small></template></el-table-column><el-table-column label="解析状态" width="140"><template #default="{row}">{{ statuses[row.parse_status] }}</template></el-table-column><el-table-column label="操作" width="240"><template #default="{row}"><el-button link :aria-label="`预览 ${row.original_name}`" @click="openPreview(row)">预览</el-button><el-button link @click="openFile(row.attachment_url)">原件</el-button><el-button v-if="row.parse_status==='preview'" link type="primary" :disabled="busy" :aria-label="`确认归档 ${row.original_name}`" @click="confirm(row)">确认归档</el-button></template></el-table-column></el-table>
    </el-tab-pane>
    <el-tab-pane label="结算与回款" name="cash">
     <el-table :data="report.cash_reconciliation.currencies"><el-table-column prop="currency" label="原币"/><el-table-column label="收款入账"><template #default="{row}">{{money(row.entries)}}</template></el-table-column><el-table-column label="提现本金"><template #default="{row}">{{money(row.withdrawals)}}</template></el-table-column><el-table-column label="提现手续费"><template #default="{row}">{{money(row.fees)}}</template></el-table-column></el-table>
     <el-table :data="report.cash_reconciliation.matches"><el-table-column label="平台转出日期"><template #default="{row}">{{row.payment.date}}</template></el-table-column><el-table-column label="平台转出 CNY"><template #default="{row}">{{money(row.payment.amount)}}</template></el-table-column><el-table-column label="入账日期"><template #default="{row}">{{row.entry?.date||'未匹配'}}</template></el-table-column><el-table-column label="入账 CNH"><template #default="{row}">{{money(row.entry?.amount)}}</template></el-table-column><el-table-column label="状态"><template #default="{row}">{{row.status==='amount_date_candidate'?'金额日期候选，归属待核':row.status==='ambiguous'?'多笔候选，待人工核对':'未匹配'}}</template></el-table-column></el-table>
     <el-alert :title="report.cash_reconciliation.note" type="warning" :closable="false"/><h2>文件内部核对</h2><div v-for="d in report.documents.filter(d=>d.parse_status==='confirmed'&&d.payload_json.controls?.length)" :key="d.id"><p>{{d.original_name}}</p><div v-for="c in d.payload_json.controls" :key="c.name">{{c.name}}：{{c.amount!=null?money(c.amount):money(c.difference)}} {{c.currency}} {{c.amount==null?'（差额）':''}}</div></div>
    </el-tab-pane>
    <el-tab-pane label="发票与会计审核" name="vouchers">
     <p>文件识别为发票不代表已经满足税前扣除条件；会计认可也不是税务审批。综合原件关联多项费用，金额不重复累计。</p>
     <el-table :data="report.documents"><el-table-column prop="original_name" label="文件" min-width="260"/><el-table-column label="审核状态"><template #default="{row}">{{reviews[row.review_status]}}</template></el-table-column><el-table-column prop="review_note" label="审核意见" min-width="200"/><el-table-column label="操作"><template #default="{row}"><el-button link @click="review={...row}">填写意见</el-button></template></el-table-column></el-table>
    </el-tab-pane>
    <el-tab-pane label="采购库存与缺件" name="gaps"><ul><li v-for="g in report.gaps" :key="g">{{g}}</li></ul><el-button @click="router.push('/profit/monthly-billing')">查看现有订单及采购成本</el-button><el-button @click="router.push('/finance/inventory-capital')">查看库存占用明细</el-button><el-button @click="router.push('/finance/payroll')">查看工资资料</el-button></el-tab-pane>
   </el-tabs>
  </template>
  <el-dialog v-if="preview" :model-value="true" title="解析预览：检查后确认归档" width="min(900px,95vw)" @close="preview=null"><p>{{preview.original_name}} · {{statuses[preview.parse_status]}}</p><div v-if="editManual" class="upload-context"><strong>修改尚未确认的手工草稿</strong><el-select v-model="editManual.metric" aria-label="草稿费用项目" :disabled="busy"><el-option v-for="m in MANUAL_EXPENSE_METRICS" :key="m" :label="m" :value="m"/></el-select><el-input-number v-model="editManual.amount" :precision="2" :disabled="busy" aria-label="草稿金额CNY"/><el-input v-model="editManual.note" type="textarea" maxlength="1000" :disabled="busy" aria-label="草稿业务依据"/><el-button type="primary" :disabled="busy" @click="saveManualDraft">保存草稿修改</el-button><span>保存后重新预览再确认；下方解析表展示上次保存内容。</span></div><el-alert v-for="w in preview.payload_json.warnings" :key="w" :title="w" type="warning" :closable="false"/><el-table :data="preview.payload_json.facts"><el-table-column prop="metric" label="项目"/><el-table-column prop="amount" label="金额"/><el-table-column prop="currency" label="原币"/><el-table-column prop="source" label="提取位置" min-width="240"/></el-table><p v-if="!preview.payload_json.facts?.length">此文件仅作业务/结算配套归档，不增加销售或费用金额。</p><p>原件上传时间：{{preview.created_at?shanghaiDateTimeText(preview.created_at):'本批上传'}}</p></el-dialog>
  <el-dialog v-if="review" :model-value="true" title="会计审核意见" width="min(650px,95vw)" @close="review=null"><p>{{review.original_name}}</p><el-select v-model="review.review_status"><el-option v-for="(label,value) in reviews" :key="value" :label="label" :value="value"/></el-select><el-input v-model="review.review_note" type="textarea" :rows="5" maxlength="1000" show-word-limit placeholder="填写认可依据、需补资料或纳税调整原因"/><template #footer><el-button type="primary" :loading="busy" @click="saveReview">保存审核意见</el-button></template></el-dialog>
 </div>
</template>

<style scoped>
.upload-context{display:grid;gap:12px;padding:18px;border:1px solid var(--el-border-color);border-radius:8px}.upload-context>.el-select{width:min(100%,520px)}.missing,small{color:var(--el-text-color-secondary)}small{display:block;overflow-wrap:anywhere;margin-top:5px}.source-lines{padding:10px 20px}.source-detail{border:1px solid var(--el-border-color);padding:16px;border-radius:8px}.period-matrix{width:100%}.period-matrix :deep(.finance-group-row td){font-weight:600;background:var(--el-fill-color-light)}
.company-statements,.company-statements>*{min-width:0;max-width:100%}
.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:12px 0 20px}.totals>div{display:grid;gap:8px;padding:16px;border:1px solid var(--el-border-color);border-radius:8px}.totals span{color:var(--el-text-color-secondary)}.totals strong{font-size:22px;font-weight:500}
.company-statements{display:grid;gap:18px}.company-statements header,.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.company-statements header{justify-content:space-between}.company-statements h1{font-size:24px;margin:0}.company-statements h2{font-size:18px;margin:18px 0 10px}.company-statements p{color:var(--el-text-color-secondary);overflow-wrap:anywhere}.toolbar .el-select{width:290px}.company-statements :deep(.el-button span){white-space:normal;overflow-wrap:anywhere}.company-statements :deep(.el-dialog__body){display:grid;gap:14px}@media(max-width:700px){.toolbar{align-items:stretch}.toolbar .el-select{width:100%}.company-statements h1{font-size:21px}}
</style>
