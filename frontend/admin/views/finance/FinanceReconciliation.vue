<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient, currentApiCacheScope, getAuthToken } from '../../utils/api';
import { shanghaiDateTimeText } from '../../utils/shanghai-date';

const props=defineProps({companyId:{required:true},shops:{type:Array,default:()=>[]},initialMonth:String});
const emit=defineEmits(['documents-changed']);
const month=ref(props.initialMonth),shop=ref(props.shops[0]?.id||''),data=ref(null),error=ref(''),busy=ref(false),loading=ref(false),search=ref(''),status=ref('pending'),page=ref(1),selected=ref([]),preview=ref(null),reason=ref(''),acknowledge=ref(false),detail=ref(null),fileInput=ref(null),documentPreview=ref(null);
const outcomeLabels={sale:'销售',refunded:'全额退款',partial_refund:'部分退款'};
const importOpen=ref(false),evidenceSection=ref(null);
const pendingCount=computed(()=>(data.value?.rows||[]).filter(r=>r.status!=='calibrated').length);
const openedPanels=ref([]),unmatchedPage=ref(1),historyPage=ref(1);
const labels={pending:'待核对',calibrated:'已校准',conflict:'原件冲突',unmatched:'未匹配'};
const money=v=>v==null?'未核定':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const context=()=>({company_id:props.companyId,shop_id:shop.value,month:month.value});
const signature=()=>JSON.stringify([context(),currentApiCacheScope()]);
const filtered=computed(()=>(data.value?.rows||[]).filter(r=>(status.value==='all'||(status.value==='pending'?r.status!=='calibrated':r.status===status.value))&&(!search.value||`${r.posting_number} ${r.sku}`.includes(search.value.trim()))));
const visible=computed(()=>filtered.value.slice((page.value-1)*50,page.value*50));
let generation=0,controller;
async function load(){
 const version=++generation,scope=signature();controller?.abort();controller=new AbortController();data.value=null;selected.value=[];preview.value=null;detail.value=null;error.value='';page.value=1;
 if(!props.companyId||!shop.value||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month.value||''))return;
 loading.value=true;
 try{const v=await apiClient.get(`/api/finance-center/document-reconciliation?${new URLSearchParams(context())}`,{noCache:true,signal:controller.signal});if(version===generation&&scope===signature())data.value=v;}
 catch(e){if(version===generation&&scope===signature()&&e.name!=='AbortError')error.value=e.message;}
 finally{if(version===generation)loading.value=false;}
}
async function showEvidence(){openedPanels.value=openedPanels.value.includes('evidence')?openedPanels.value:['evidence',...openedPanels.value];await nextTick();evidenceSection.value?.scrollIntoView({behavior:'smooth',block:'start'});}
function openFile(url){if(/^\/uploads\/team-attachments\/[^/]+$/.test(url||''))window.open(url,'_blank','noopener,noreferrer');}
async function uploadFile(file,scope=signature()){
 if(!file||file.size>20*1024*1024)throw new Error('请选择不超过20MB的官方逐单原件');
 const form=new FormData();form.append('file',file);const token=getAuthToken();
 const response=await fetch('/api/finance-center/voucher-attachments',{method:'POST',body:form,headers:token?{Authorization:`Bearer ${token}`}:{}});
 const uploaded=await response.json();if(!response.ok||!uploaded.ok)throw new Error(uploaded.error||'上传失败');if(scope!==signature())return;
 const p=await apiClient.post('/api/finance-center/document-import',{...context(),action:'preview',upload_type:'order-sales',attachment_url:uploaded.url});
 if(scope===signature()){importOpen.value=false;documentPreview.value={...p.document,duplicate:p.duplicate};}
}
async function chooseFile(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;const scope=signature();busy.value=true;try{await uploadFile(file,scope);}catch(e){if(scope===signature())ElMessage.error(e.message);}finally{busy.value=false;}}
async function readOfficial(){const scope=signature();busy.value=true;
 try{const v=await apiClient.post('/api/finance-center/order-sales-source',context());if(scope!==signature())return;await uploadFile(new File([JSON.stringify(v.data)],v.filename,{type:'application/json'}),scope);}
 catch(e){if(scope===signature())ElMessage.error(e.message);}finally{busy.value=false;}
}
async function archive(){const scope=signature(),doc=documentPreview.value;busy.value=true;
 try{await apiClient.post('/api/finance-center/document-import',{company_id:props.companyId,action:'confirm',document_id:doc.id});if(scope!==signature())return;documentPreview.value=null;await load();emit('documents-changed');ElMessage.success('逐单原件已归档，尚未调整任何订单');}
 catch(e){if(scope===signature())ElMessage.error(e.message);}finally{busy.value=false;}
}
async function previewRows(){const scope=signature();busy.value=true;
 try{const v=await apiClient.post('/api/finance-center/document-calibration',{...context(),action:'preview',row_keys:selected.value.map(r=>r.key)});if(scope!==signature())return;preview.value=v;reason.value='';acknowledge.value=false;}
 catch(e){if(scope===signature())ElMessage.error(e.message);}finally{busy.value=false;}
}
async function confirm(){const scope=signature();busy.value=true;
 try{const v=await apiClient.post('/api/finance-center/document-calibration',{...context(),action:'confirm',rows:preview.value.rows.map(r=>({key:r.key,token:r.token})),reason:reason.value,acknowledge:acknowledge.value});if(scope!==signature())return;preview.value=null;await load();ElMessage.success(v.note);}
 catch(e){if(scope===signature())ElMessage.error(e.message);}finally{busy.value=false;}
}
const parsed=value=>typeof value==='string'?JSON.parse(value):value;
watch(()=>[props.companyId,props.initialMonth],()=>{month.value=props.initialMonth;shop.value=props.shops[0]?.id||'';documentPreview.value=null;importOpen.value=false;});
watch(()=>[month.value,shop.value,currentApiCacheScope()],load,{immediate:true});
watch(()=>[month.value,shop.value,props.companyId],()=>{documentPreview.value=null;});
watch(()=>[search.value,status.value],()=>{page.value=1;selected.value=[];});
onBeforeUnmount(()=>{generation++;controller?.abort();});
</script>

<template>
 <section class="reconciliation" v-loading="loading">
  <div class="controls scope-controls">
   <el-select v-model="shop" aria-label="对账店铺" :disabled="busy"><el-option v-for="s in shops" :key="s.id" :value="s.id" :label="s.name"/></el-select>
   <el-date-picker v-model="month" type="month" value-format="YYYY-MM" aria-label="对账业务月份" :disabled="busy"/>
   <span class="spacer"/><el-button :disabled="busy" @click="load">刷新</el-button>
   <el-button :disabled="busy||!shop||!month" @click="importOpen=true">添加对账资料</el-button>
   <input ref="fileInput" type="file" accept=".json" hidden @change="chooseFile"/>
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <template v-if="data">
   <div class="result-line"><div><strong class="result-state" :class="{matched:data.summary.complete_controls}">{{data.summary.complete_controls?'月报已对平':'资料待核对'}}</strong><span class="result-caption">{{data.summary.official_orders}} 笔官方订单 · {{data.summary.matched_rows}} / {{data.summary.official_rows}} 行已匹配</span></div><el-button link type="primary" @click="showEvidence">查看核对依据</el-button></div>
   <div class="totals"><div><span>官方净销售及补贴 · CNY</span><strong>{{money(data.summary.net_revenue)}}</strong></div><div><span>待确认商品行</span><strong>{{pendingCount}}<small>已校准 {{data.summary.adjusted_rows}} 行</small></strong></div><div><span>待补资料</span><strong>{{data.gaps.length?data.gaps.length+' 项':'无月报缺件'}}</strong><el-button v-if="data.gaps.length" link type="warning" @click="showEvidence">查看缺件</el-button></div></div>

   <div class="list-heading"><h3>订单差额</h3><el-button type="primary" :disabled="busy||!selected.length" @click="previewRows">预览校准{{selected.length?'（'+selected.length+'）':''}}</el-button></div>
   <div class="controls"><el-input v-model="search" placeholder="搜索货件号 / SKU" aria-label="搜索对账订单" clearable/><el-select v-model="status" aria-label="对账状态"><el-option value="all" label="全部订单"/><el-option v-for="(label,value) in labels" :key="value" :value="value" :label="value==='pending'?'待处理':label"/></el-select></div>
   <el-table :data="visible" row-key="key" max-height="480" @selection-change="selected=$event">
    <el-table-column type="selection" width="48" :selectable="row=>row.can_adjust"/>
    <el-table-column label="货件 / SKU" min-width="205"><template #default="{row}">{{row.posting_number}}<small>SKU {{row.sku}}</small></template></el-table-column>
    <el-table-column label="内部收入 CNY" min-width="130"><template #default="{row}">{{money(row.baseline?.revenue)}}</template></el-table-column>
    <el-table-column label="官方收入 CNY" min-width="130"><template #default="{row}">{{money(row.target.net_revenue)}}</template></el-table-column>
    <el-table-column label="差额 CNY" min-width="120"><template #default="{row}">{{money(row.difference)}}</template></el-table-column>
    <el-table-column label="状态" width="110"><template #default="{row}"><span class="row-status">{{labels[row.status]}}</span></template></el-table-column>
    <el-table-column label="" width="110"><template #default="{row}"><el-button link @click="detail=row">明细与凭证</el-button></template></el-table-column>
   </el-table>
   <el-pagination v-model:current-page="page" :page-size="50" :total="filtered.length" layout="total, prev, pager, next"/>
   <div ref="evidenceSection"><el-collapse v-model="openedPanels"><el-collapse-item name="evidence" :title="`核对依据与缺件（${data.gaps.length}项待补）`">   <el-table :data="data.controls" size="small"><el-table-column prop="metric" label="项目" min-width="180"/><el-table-column label="逐单合计 CNY"><template #default="{row}">{{money(row.detail_amount)}}</template></el-table-column><el-table-column label="原始月报 CNY"><template #default="{row}">{{money(row.monthly_amount)}}</template></el-table-column><el-table-column label="差额 CNY"><template #default="{row}">{{money(row.difference)}}</template></el-table-column><el-table-column label="原始凭证" min-width="230"><template #default="{row}"><el-button v-for="s in row.sources" :key="s.document_id" link @click="openFile(s.attachment_url)">#{{s.document_id}} {{s.original_name}}</el-button></template></el-table-column></el-table>
   <p>重复来源已复用 {{data.duplicates.length}} 项；冲突 {{data.conflicts.length}} 项。</p>
   <div v-for="g in data.gaps" :key="g.code" class="gap"><el-alert :title="g.message" type="warning" :closable="false"/><el-button v-for="s in g.sources" :key="s.document_id" link @click="openFile(s.attachment_url)">查看现有凭证 #{{s.document_id}}</el-button></div>
</el-collapse-item><el-collapse-item v-if="data.settlement_links?.length" name="settlement-links" :title="`平台未单列结算商品（${data.settlement_links.length}项）`"><el-table :data="data.settlement_links"><el-table-column prop="posting_number" label="货件号"/><el-table-column prop="sku" label="订单SKU"/><el-table-column label="报告SKU"><template #default="{row}">{{row.reported_skus.join('、')}}</template></el-table-column><el-table-column prop="note" label="核对结果" min-width="300"/><el-table-column label="原始凭证"><template #default="{row}"><el-button v-for="source in row.sources" :key="source.document_id" link @click="openFile(source.attachment_url)">#{{source.document_id}} {{source.original_name}}</el-button></template></el-table-column></el-table></el-collapse-item><el-collapse-item name="unmatched" :title="`本月下单但本月报告未列（${data.unmatched_internal.length}项）`"><el-table v-if="openedPanels.includes('unmatched')" :data="data.unmatched_internal.slice((unmatchedPage-1)*50,unmatchedPage*50)"><el-table-column prop="posting_number" label="货件号"/><el-table-column prop="sku" label="SKU"/><el-table-column prop="note" label="待核原因" min-width="320"/></el-table><el-pagination v-if="openedPanels.includes('unmatched')" v-model:current-page="unmatchedPage" :page-size="50" :total="data.unmatched_internal.length" layout="total, prev, pager, next"/></el-collapse-item>
    <el-collapse-item name="history" :title="`调整历史（${data.history.length}条）`"><el-table v-if="openedPanels.includes('history')" :data="data.history.slice((historyPage-1)*50,historyPage*50)"><el-table-column prop="posting_number" label="货件号" min-width="190"/><el-table-column prop="sku" label="SKU"/><el-table-column label="确认时间（北京时间）" min-width="180"><template #default="{row}">{{shanghaiDateTimeText(row.created_at)}}</template></el-table-column><el-table-column prop="created_by" label="经办人ID"/><el-table-column label="校准前 / 后 CNY" min-width="190"><template #default="{row}">{{money(parsed(row.before_json).effective?.net_revenue??parsed(row.before_json).baseline?.revenue)}} → {{money(parsed(row.after_json).net_revenue)}}</template></el-table-column><el-table-column prop="reason" label="调整依据" min-width="200"/><el-table-column label="凭证"><template #default="{row}"><el-button v-for="s in parsed(row.sources_json)" :key="s.document_id" link @click="openFile(s.attachment_url)">#{{s.document_id}}</el-button></template></el-table-column></el-table><el-pagination v-if="openedPanels.includes('history')" v-model:current-page="historyPage" :page-size="50" :total="data.history.length" layout="total, prev, pager, next"/></el-collapse-item></el-collapse></div>
  </template>
  <el-dialog v-if="importOpen" :model-value="true" title="添加对账资料" width="min(520px,95vw)" @close="importOpen=false"><p>选择一种方式获取本店本月的官方逐单销售凭证。</p><div class="import-actions"><el-button type="primary" :disabled="busy" @click="readOfficial">从Ozon读取</el-button><el-button :disabled="busy" @click="fileInput.click()">上传已有JSON</el-button></div><p class="quiet-note">月度销售报告、费用单和连连流水在“上传、解析与归档”中添加。重复资料会自动复用。</p></el-dialog>
  <el-dialog v-if="documentPreview" :model-value="true" title="逐单原件预览，确认后归档" width="min(800px,95vw)" @close="documentPreview=null"><p>{{documentPreview.original_name}}</p><p>{{documentPreview.duplicate?'已有相同业务原件，本次复用，不重复计费。':''}}</p><el-alert v-for="w in documentPreview.payload_json.warnings" :key="w" :title="w" type="warning" :closable="false"/><p>已解析 {{documentPreview.payload_json.order_rows?.length||0}} 行；本步骤只归档，不调整账簿。</p><el-button type="primary" :disabled="busy||documentPreview.parse_status==='error'" @click="archive">确认原件归档</el-button></el-dialog>
  <el-dialog v-if="preview" :model-value="true" title="校准预览：确认后才调整" width="min(1000px,95vw)" @close="preview=null"><p>{{preview.note}}</p><el-table :data="preview.rows"><el-table-column prop="posting_number" label="货件号" min-width="190"/><el-table-column label="原记录 CNY"><template #default="{row}">{{money(row.current?.net_revenue)}}</template></el-table-column><el-table-column label="校准后 CNY"><template #default="{row}">{{money(row.target.net_revenue)}}</template></el-table-column><el-table-column label="销售 / 退款 / 净补贴"><template #default="{row}">{{money(row.target.sales)}} / {{money(row.target.refunds)}} / {{money(row.target.partner-row.target.partner_refunds)}}</template></el-table-column><el-table-column label="佣金原值 / 校准后 CNY"><template #default="{row}">{{money(row.baseline?.commission)}} / {{money(row.target.commission_fee)}}</template></el-table-column><el-table-column label="依据"><template #default="{row}"><el-button v-for="s in row.sources" :key="s.document_id" link @click="openFile(s.attachment_url)">#{{s.document_id}}，行{{s.rows.join('、')}}</el-button></template></el-table-column></el-table><el-input v-model="reason" type="textarea" :maxlength="1000" placeholder="填写调整依据，至少4字" aria-label="校准调整依据"/><el-checkbox v-model="acknowledge">确认按所列官方凭证调整对账结果，并保留原值和历史；不据此认定最终利润。</el-checkbox><template #footer><el-button @click="preview=null">返回核对</el-button><el-button type="primary" :disabled="busy||!acknowledge||reason.trim().length<4" @click="confirm">确认调整并留存历史</el-button></template></el-dialog>
  <el-drawer v-if="detail" :model-value="true" title="逐单金额、差额和原始凭证" size="min(780px,95vw)" @close="detail=null"><p>{{detail.posting_number}} · SKU {{detail.sku}}</p><el-descriptions :column="1" border><el-descriptions-item label="销售 CNY">{{money(detail.target.sales)}}</el-descriptions-item><el-descriptions-item label="销售退回 CNY">{{money(detail.target.refunds)}}</el-descriptions-item><el-descriptions-item label="销售补贴 / 补贴退回 CNY">{{money(detail.target.partner)}} / {{money(detail.target.partner_refunds)}}</el-descriptions-item><el-descriptions-item label="官方净佣金 CNY">{{money(detail.target.commission_fee)}}</el-descriptions-item><el-descriptions-item label="内部保存佣金 / 差额 CNY">{{money(detail.baseline?.commission)}} / {{money(detail.commission_difference)}}</el-descriptions-item><el-descriptions-item label="佣金减免 CNY（不重复记收入）">{{money(detail.target.commission_reduction)}}</el-descriptions-item><el-descriptions-item label="净销售及净补贴 CNY">{{money(detail.target.net_revenue)}}</el-descriptions-item><el-descriptions-item label="已确认对账结果 CNY">{{money(detail.effective?.net_revenue)}}</el-descriptions-item><el-descriptions-item label="本期核定业务结果">{{outcomeLabels[detail.target.business_outcome]}}</el-descriptions-item><el-descriptions-item label="内部订单 / 结算记录"><span v-for="s in detail.baseline?.status||[]" :key="s[0]">商品行 #{{s[0]}}：{{s[1]==='delivered'?'已送达':s[1]}} / {{s[2]==='accrued'?'已结算':'待结算'}}；</span></el-descriptions-item><el-descriptions-item label="最终利润">未核定</el-descriptions-item></el-descriptions><p v-for="issue in detail.issues" :key="issue">{{issue}}</p><p v-for="s in detail.sources" :key="s.document_id"><el-button link @click="openFile(s.attachment_url)">#{{s.document_id}} {{s.original_name}}</el-button><small>原始商品行：{{s.rows.join('、')}}</small></p></el-drawer>
 </section>
</template>

<style scoped>
.controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:16px 0}.controls .el-select,.controls .el-input{width:230px}.totals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.totals>div{padding:16px;border:1px solid var(--el-border-color);border-radius:8px}.totals strong{display:block;font-size:22px;margin-top:8px}small{display:block;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.gap{margin:12px 0}.el-pagination{margin:16px 0}.el-textarea{margin-top:18px}
.scope-controls{margin-top:12px}.spacer{flex:1}.result-line,.list-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.result-line{padding:14px 0 4px}.result-caption{margin-left:12px;color:var(--el-text-color-secondary);font-size:13px}.quiet-note{color:var(--el-text-color-secondary);font-size:13px}.totals>div{border:0;background:var(--el-fill-color-light)}.totals strong small{display:inline;font-size:12px;font-weight:400;margin-left:12px}.list-heading h3{margin:12px 0 0}.list-heading+.controls{margin-top:12px}.import-actions{display:flex;gap:12px;margin:24px 0}@media(max-width:760px){.totals{grid-template-columns:1fr}.spacer{display:none}.result-line{align-items:flex-start}.result-caption{display:block;margin:8px 0 0}.scope-controls .el-select,.scope-controls .el-date-editor{width:100%}}
.result-state{color:var(--el-color-warning);font-size:15px}.result-state.matched{color:var(--el-color-success)}.row-status{color:var(--el-text-color-secondary);font-size:12px}
.reconciliation{max-width:1440px;margin:0 auto}
</style>
