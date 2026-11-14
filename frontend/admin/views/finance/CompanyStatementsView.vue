<script setup>
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
const report=ref(null),error=ref(''),loading=ref(false),busy=ref(false),tab=ref('summary'),metric=ref(''),preview=ref(null),review=ref(null),fileInput=ref(null),uploads=ref([]);
let generation=0,controller;
const money=n=>n==null?'待补':Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const shops=computed(()=>allShops.value.filter(s=>assignments.value.some(a=>Number(a.company_id)===Number(companyId.value)&&Number(a.shop_id)===Number(s.id)&&a.effective_from<=`${month.value}-31`&&(!a.effective_to||a.effective_to>=`${month.value}-01`))));
const windowRange=computed(()=>{
 const year=month.value.slice(0,4),m=Number(month.value.slice(5));
 if(period.value==='year')return {from:`${year}-01`,to:`${year}-12`};
 if(period.value==='quarter'){const start=Math.floor((m-1)/3)*3+1;return {from:`${year}-${String(start).padStart(2,'0')}`,to:`${year}-${String(start+2).padStart(2,'0')}`};}
 return {from:month.value,to:month.value};
});
const query=computed(()=>new URLSearchParams({company_id:companyId.value,...windowRange.value}).toString());
const metricOrder=['已确认商品销售额','销售退回冲减额','合作伙伴补贴收入','佣金','点击广告费','星级商品推广费','国际物流费','一般收单支付服务费','平台物流连接服务费','国际货代合同管理服务费','国际运输合同缔约服务费','平台赔偿收入'];
const incomeMetrics=new Set(['已确认商品销售额','销售退回冲减额','合作伙伴补贴收入','平台赔偿收入']);
const amounts=computed(()=>Object.entries(report.value?.metrics||{}).map(([name,amount])=>({name,amount})).sort((a,b)=>metricOrder.indexOf(a.name)-metricOrder.indexOf(b.name)));
const netSales=computed(()=>report.value?.metrics?.['已确认商品销售额']==null?null:report.value.metrics['已确认商品销售额']-(report.value.metrics['销售退回冲减额']||0));
const platformFees=computed(()=>{const rows=amounts.value.filter(r=>!incomeMetrics.has(r.name));return rows.length?rows.reduce((s,r)=>s+r.amount,0):null;});
const details=computed(()=>report.value?.lines?.filter(l=>l.metric===metric.value).map(l=>({...l,shop_name:report.value.shops.find(s=>Number(s.id)===Number(l.shop_id))?.name||'店铺归属待核'}))||[]);
const monthlyRows=computed(()=>{
 const rows=[];let cursor=windowRange.value.from;
 while(cursor<=windowRange.value.to){const lines=(report.value?.lines||[]).filter(l=>l.month===cursor),sales=lines.filter(l=>l.metric==='已确认商品销售额'),refunds=lines.filter(l=>l.metric==='销售退回冲减额'),fees=lines.filter(l=>!incomeMetrics.has(l.metric));rows.push({month:cursor,net:sales.length?sales.reduce((s,r)=>s+r.amount,0)-refunds.reduce((s,r)=>s+r.amount,0):null,fees:fees.length?fees.reduce((s,r)=>s+r.amount,0):null});const [y,m]=cursor.split('-').map(Number);cursor=m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;}
 return rows;
});
const statuses={preview:'待确认',confirmed:'已确认归档',error:'解析/归属待处理'};
const reviews={pending:'待会计审核',accepted:'会计认可',needs_info:'需补资料',adjustment:'需纳税调整'};
function current(token,scope){return token===generation&&scope===currentApiCacheScope()&&allowed.value;}
async function load(){
 const token=++generation,scope=currentApiCacheScope();controller?.abort();controller=new AbortController();report.value=null;preview.value=null;metric.value='';error.value='';
 if(!allowed.value||!companyId.value)return;
 loading.value=true;
 try{const data=await apiClient.get(`/api/finance-center/document-report?${query.value}`,{signal:controller.signal,noCache:true});if(current(token,scope))report.value=data;}
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
 const scope=currentApiCacheScope(),company=companyId.value,shop=shopId.value,selectedMonth=month.value;busy.value=true;uploads.value=[];
 try{
  for(const file of files){
   if(scope!==currentApiCacheScope()||!allowed.value)break;
   try{
    if(file.size>20*1024*1024)throw new Error('文件超过20MB，请拆分');
    const form=new FormData();form.append('file',file);const token=getAuthToken();
    const response=await fetch('/api/finance-center/voucher-attachments',{method:'POST',body:form,headers:token?{Authorization:`Bearer ${token}`}:{}});
    const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'原件上传失败');
    if(scope!==currentApiCacheScope()||!allowed.value)break;
    const parsed=await apiClient.post('/api/finance-center/document-import',{action:'preview',company_id:company,shop_id:shop,month:selectedMonth,attachment_url:data.url});
    if(scope!==currentApiCacheScope())break;
    uploads.value.push({name:file.name,status:parsed.duplicate?'已存在，未重复计费':statuses[parsed.document.parse_status],note:parsed.document.payload_json?.warnings?.join('；')});
   }catch(e){if(scope!==currentApiCacheScope())break;uploads.value.push({name:file.name,status:'未完成',note:e.message});}
  }
  if(scope===currentApiCacheScope())await load();
 }finally{busy.value=false;}
}
async function confirm(doc){
 const scope=currentApiCacheScope();busy.value=true;
 try{await apiClient.post('/api/finance-center/document-import',{action:'confirm',company_id:companyId.value,document_id:doc.id});if(scope!==currentApiCacheScope())return;ElMessage.success('已确认，原件与明细已归档');await load();}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
}
async function saveReview(){
 const scope=currentApiCacheScope();busy.value=true;
 try{await apiClient.post('/api/finance-center/document-import',{action:'review',company_id:companyId.value,document_id:review.value.id,review_status:review.value.review_status,review_note:review.value.review_note});if(scope!==currentApiCacheScope())return;review.value=null;await load();}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
}
async function download(){
 const scope=currentApiCacheScope();busy.value=true;
 try{const response=await apiClient.blobResponse(`/api/finance-center/document-export?${query.value}`);if(scope!==currentApiCacheScope())return;const url=URL.createObjectURL(response.blob),a=document.createElement('a');a.href=url;a.download=`公司会计交接_${windowRange.value.from}_${windowRange.value.to}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
}
function openFile(url){if(/^\/uploads\/team-attachments\/[^/]+$/.test(url||''))window.open(url,'_blank','noopener,noreferrer');}
watch(()=>[auth.user?.id,auth.user?.tenant?.id,currentApiCacheScope(),allowed.value],setup,{immediate:true});
watch(()=>route.query.month,value=>{if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(value||'')))month.value=String(value);});
watch([companyId,month,period],()=>{shopId.value=0;uploads.value=[];review.value=null;load();});
onBeforeUnmount(()=>{generation++;controller?.abort();});
</script>

<template>
 <div v-if="allowed" class="company-statements">
  <header><div><h1>公司账单与凭证</h1><p>公司汇总 → 店铺明细 → 原始文件。已采集金额与完整公司账分开显示。</p></div><el-button @click="router.push('/finance-center')">公司与店铺设置</el-button></header>
  <div class="toolbar">
   <el-select v-model="companyId" aria-label="公司主体" placeholder="选择公司" :disabled="busy"><el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" /></el-select>
   <el-date-picker v-model="month" type="month" value-format="YYYY-MM" format="YYYY年MM月" :clearable="false" aria-label="业务月份" :disabled="busy" />
   <el-radio-group v-model="period" :disabled="busy"><el-radio-button value="month">月度</el-radio-button><el-radio-button value="quarter">季度</el-radio-button><el-radio-button value="year">年度</el-radio-button></el-radio-group>
   <el-button :disabled="busy||!report" @click="download">导出公司交接包（草稿）</el-button><el-button :disabled="busy" @click="load">刷新</el-button>
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" />
  <el-empty v-if="!companies.length&&!error" description="请先在经营总览的公司设置中配置主体及店铺归属" />
  <template v-if="report">
   <el-alert type="warning" :closable="false" :title="`已收到销售报告的店铺 ${report.coverage.shops_with_sales}/${report.coverage.shops_expected}。公司账尚未齐全，未提供金额不作零。采购、工资社保和银行到账仍需核对。`" />
   <el-tabs v-model="tab">
    <el-tab-pane label="公司汇总与店铺明细" name="summary">
     <div class="totals"><div><span>已采集商品净销售 CNY</span><strong>{{money(netSales)}}</strong></div><div><span>已采集平台费用 CNY</span><strong>{{money(platformFees)}}</strong></div><div><span>公司完整利润</span><strong>资料未齐</strong></div></div>
     <el-table v-if="period!=='month'" :data="monthlyRows"><el-table-column prop="month" label="月份"/><el-table-column label="已采集净销售 CNY"><template #default="{row}">{{money(row.net)}}</template></el-table-column><el-table-column label="已采集平台费用 CNY"><template #default="{row}">{{money(row.fees)}}</template></el-table-column><el-table-column label="公司合计"><template #default>待齐</template></el-table-column></el-table>
     <el-table :data="amounts" v-loading="loading"><el-table-column label="项目"><template #default="{row}"><el-button link type="primary" @click="metric=row.name">{{ row.name }} · 查看来源</el-button></template></el-table-column><el-table-column label="已采集金额 CNY" align="right"><template #default="{row}">{{ money(row.amount) }}</template></el-table-column><el-table-column label="公司完整合计"><template #default>资料未齐</template></el-table-column></el-table>
     <el-empty v-if="!amounts.length" description="尚无已确认金额。先上传原件并检查解析预览，再确认归档。" />
     <section v-if="metric"><h2>{{ metric }} · 已提供的店铺来源</h2><el-table :data="details"><el-table-column prop="month" label="业务月份" /><el-table-column prop="shop_name" label="店铺" min-width="150"/><el-table-column label="金额 CNY"><template #default="{row}">{{ money(row.amount) }}</template></el-table-column><el-table-column prop="source" label="提取位置" min-width="220"/><el-table-column label="原件" min-width="240"><template #default="{row}"><el-button link type="primary" @click="openFile(row.attachment_url)">{{ row.original_name }}</el-button></template></el-table-column></el-table></section>
     <p>公司所属店铺：{{ report.shops.map(s=>s.name).join('、') || '尚未配置' }}。无对应资料的店铺继续列为缺件。</p>
    </el-tab-pane>
    <el-tab-pane label="上传、解析与归档" name="documents">
     <div class="toolbar"><el-select v-model="shopId" aria-label="上传归属" :disabled="busy"><el-option :value="0" label="公司共用（连连流水等）"/><el-option v-for="s in shops" :key="s.id" :label="s.name" :value="Number(s.id)"/></el-select><el-button type="primary" :disabled="busy||!companyId" @click="fileInput.click()">选择原件，批量上传解析</el-button><input ref="fileInput" type="file" multiple accept=".pdf,.xlsx,.png,.jpg,.jpeg,.webp" hidden @change="upload"/></div>
     <p>文件逐个上传，单个不超过20MB。平台文件选择对应店铺；连连原始流水选择公司共用。解析失败保留原件和原因，不计入金额。</p>
     <el-table v-if="uploads.length" :data="uploads"><el-table-column prop="name" label="本批文件"/><el-table-column prop="status" label="结果"/><el-table-column prop="note" label="提示" min-width="240"/></el-table>
     <el-table :data="report.documents"><el-table-column prop="month_key" label="归档月份" width="110"/><el-table-column prop="original_name" label="原始文件名" min-width="260"/><el-table-column label="解析状态" width="140"><template #default="{row}">{{ statuses[row.parse_status] }}</template></el-table-column><el-table-column label="操作" width="240"><template #default="{row}"><el-button link @click="preview=row">预览</el-button><el-button link @click="openFile(row.attachment_url)">原件</el-button><el-button v-if="row.parse_status==='preview'" link type="primary" :disabled="busy" @click="confirm(row)">确认归档</el-button></template></el-table-column></el-table>
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
  <el-dialog v-if="preview" :model-value="true" title="解析预览：检查后确认归档" width="min(900px,95vw)" @close="preview=null"><p>{{preview.original_name}} · {{statuses[preview.parse_status]}}</p><el-alert v-for="w in preview.payload_json.warnings" :key="w" :title="w" type="warning" :closable="false"/><el-table :data="preview.payload_json.facts"><el-table-column prop="metric" label="项目"/><el-table-column prop="amount" label="金额"/><el-table-column prop="currency" label="原币"/><el-table-column prop="source" label="提取位置" min-width="240"/></el-table><p v-if="!preview.payload_json.facts?.length">此文件仅作业务/结算配套归档，不增加销售或费用金额。</p><p>原件上传时间：{{preview.created_at?shanghaiDateTimeText(preview.created_at):'本批上传'}}</p></el-dialog>
  <el-dialog v-if="review" :model-value="true" title="会计审核意见" width="min(650px,95vw)" @close="review=null"><p>{{review.original_name}}</p><el-select v-model="review.review_status"><el-option v-for="(label,value) in reviews" :key="value" :label="label" :value="value"/></el-select><el-input v-model="review.review_note" type="textarea" :rows="5" maxlength="1000" show-word-limit placeholder="填写认可依据、需补资料或纳税调整原因"/><template #footer><el-button type="primary" :loading="busy" @click="saveReview">保存审核意见</el-button></template></el-dialog>
 </div>
</template>

<style scoped>
.company-statements,.company-statements>*{min-width:0;max-width:100%}
.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:12px 0 20px}.totals>div{display:grid;gap:8px;padding:16px;border:1px solid var(--el-border-color);border-radius:8px}.totals span{color:var(--el-text-color-secondary)}.totals strong{font-size:22px;font-weight:500}
.company-statements{display:grid;gap:18px}.company-statements header,.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.company-statements header{justify-content:space-between}.company-statements h1{font-size:24px;margin:0}.company-statements h2{font-size:18px;margin:18px 0 10px}.company-statements p{color:var(--el-text-color-secondary);overflow-wrap:anywhere}.toolbar .el-select{width:290px}.company-statements :deep(.el-button span){white-space:normal;overflow-wrap:anywhere}.company-statements :deep(.el-dialog__body){display:grid;gap:14px}@media(max-width:700px){.toolbar{align-items:stretch}.toolbar .el-select{width:100%}.company-statements h1{font-size:21px}}
</style>
