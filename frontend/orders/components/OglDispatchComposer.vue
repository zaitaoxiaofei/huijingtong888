<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import OglOrderTable from './OglOrderTable.vue';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../../admin/stores/auth.js';
import { currentApiCacheScope } from '../../admin/utils/api.js';
import { shanghaiDateKey, shanghaiDateDaysAgo, shanghaiDateTimeText } from '../../admin/utils/shanghai-date.js';
import { oglDispatchService as service, normalizeOglOrderIds } from '../services/ogl-dispatch-service.js';
const props=defineProps({orderIds:{type:Array,default:()=>[]},batchId:{type:Number,default:0},orderRows:{type:Array,default:()=>[]}});
const emit=defineEmits(['close','created','open-batch','open-order']);
const visible=ref(true),busy=ref(false),loading=ref(false),error=ref(''),boot=ref({settings:{},shops:[]});
const filters=reactive({printed_from:shanghaiDateKey(),printed_to:shanghaiDateKey(),shop_id:'all',search:'',print_batch_id:'',binding:'unbound',review:'all',eligibility:'eligible',page:1,page_size:20});
const range=ref([shanghaiDateDaysAgo(6),shanghaiDateKey()]),rows=ref([]),rejected=ref([]),total=ref(0),officialRows=ref([]),target=ref(null),mode=ref('bind'),count=ref(1);
const summary=ref(null),rejectionSummary=ref([]);
const selected=ref(new Map(normalizeOglOrderIds(props.orderIds).map(id=>[id,props.orderRows?.find(row=>Number(row.id)===id)||{id,unknown:true}]))),reviewed=ref(new Map()),reviewNote=ref(''),requestKey=ref(crypto.randomUUID());
const auth=useAuthStore();
const currentScope=()=>`${currentApiCacheScope()}:${auth.user?.id||''}:${auth.user?.tenant?.id||''}`;
const scope=currentScope();let alive=true,readVersion=0,previewVersion=0;
const current=()=>alive&&scope===currentScope();
const historicalConfirmed=ref(false),historicalNote=ref('');
const historicalTarget=computed(()=>{const batch=target.value?.batch||{},saved=batch.official_result||{};return ['received','closed'].includes(String(saved.carriage?.status||saved.info?.status||'').toLowerCase())||['tracking','closed'].includes(batch.status)||(target.value?.members||[]).some(row=>row.dispatched_at);});
const selectedRows=computed(()=>[...selected.value.values()]);
const reviewRows=computed(()=>selectedRows.value.filter(row=>row.needs_review));
const selectedIds=()=>[...selected.value.keys()];
const blocked=computed(()=>selectedRows.value.some(row=>row.blocked||row.unknown));
const canSave=computed(()=>(!historicalTarget.value||(historicalConfirmed.value&&Boolean(historicalNote.value.trim())))&&selected.value.size>0&&!blocked.value&&reviewRows.value.every(row=>reviewed.value.get(Number(row.id))===row.review_signature)&&(!reviewRows.value.length||reviewNote.value.trim())&&(mode.value==='create'?Boolean(boot.value.settings.dispatch_shop_id):Boolean(target.value)));
const pageSelectable=computed(()=>rows.value.filter(row=>!row.blocked&&row.can_select!==false&&(!row.needs_review||reviewed.value.get(Number(row.id))===row.review_signature)));
const pageSelected=computed(()=>pageSelectable.value.length>0&&pageSelectable.value.every(row=>selected.value.has(Number(row.id))));
const time=value=>value?shanghaiDateTimeText(value,{assumeUtcWhenNaive:true}):'未记录';
function toggle(row,checked){const next=new Map(selected.value);if(checked)next.set(Number(row.id),row);else next.delete(Number(row.id));selected.value=next;}
function togglePage(checked){for(const row of pageSelectable.value)toggle(row,checked);}
function review(row,checked){const next=new Map(reviewed.value);if(checked)next.set(Number(row.id),row.review_signature);else next.delete(Number(row.id));reviewed.value=next;}
async function work(fn){if(busy.value||!current())return;busy.value=true;error.value='';try{await fn();}catch(e){if(current())error.value=e.message||'操作失败，请重试';}finally{if(current())busy.value=false;}}
async function load(reset=false){if(reset)filters.page=1;const version=++readVersion;loading.value=true;
 try{const result=await service.candidates({...filters,...(target.value?{batch_id:target.value.batch.id}:{})});if(!current()||version!==readVersion)return;rows.value=result.rows||[...(result.eligible||[]),...(result.rejected||[]).map(row=>({...row,blocked:true,can_select:false}))];rejected.value=result.rejected||[];total.value=Number(result.total||0);summary.value=result.summary||null;rejectionSummary.value=result.rejection_summary||[];}
 catch(e){if(current()&&version===readVersion)error.value=e.message;}finally{if(current()&&version===readVersion)loading.value=false;}}
async function recheck(){const ids=selectedIds(),version=++previewVersion;if(!ids.length)return;
 const result=await service.preview(ids,target.value?.batch.id||0);if(!current()||version!==previewVersion)return;
 const found=new Map((result.eligible||[]).map(row=>[Number(row.id),{...row,unknown:false,blocked:false,can_select:true}]));
 for(const row of result.rejected||[])found.set(Number(row.id||row.order_id),{...row,id:Number(row.id||row.order_id),blocked:true,unknown:false,can_select:false});
 // Retain removals made while the request was pending; never resurrect a row.
 const next=new Map(selected.value);for(const id of ids)if(next.has(id))next.set(id,found.has(id)?{...next.get(id),...found.get(id)}:{id,blocked:true,reason:'订单未返回，请重新核对'});selected.value=next;
}
async function savedApplications(sync=false){const [date_from,date_to]=range.value||[];
 const query={date_from:date_from||shanghaiDateKey(),date_to:date_to||shanghaiDateKey(),...(boot.value.settings.dispatch_shop_id?{shop_id:boot.value.settings.dispatch_shop_id}:{})};
 const result=sync?await service.discoverOfficial(query):await service.officialSnapshot(query);if(current())officialRows.value=result.rows||[];
}
async function choose(row){await work(async()=>{const id=Number(row.local_batch_id||row.batch_id);if(!id)throw Error('该申请尚未保存到本企业，请先点击“同步 Ozon 已有申请”');const result=await service.detail(id);if(!current())return;target.value=result;historicalConfirmed.value=false;historicalNote.value='';mode.value='bind';requestKey.value=crypto.randomUUID();reviewed.value=new Map();await recheck();await load(true);});}
async function save(){if(!canSave.value)return;await work(async()=>{
 await recheck();if(!canSave.value)throw Error('部分订单状态或标记已变化，请重新复核所选列表');
 const payload={order_ids:selectedIds(),client_request_id:requestKey.value,reviewed_order_ids:reviewRows.value.map(row=>Number(row.id)),review_signatures:Object.fromEntries(reviewRows.value.map(row=>[row.id,row.review_signature])),review_note:reviewNote.value.trim(),...(historicalTarget.value?{confirm_historical_binding:historicalConfirmed.value,historical_binding_note:historicalNote.value.trim()}:{})};
 const result=mode.value==='bind'?await service.action(target.value.batch.id,'bind-orders',payload):await service.create({...payload,container_count:Number(count.value)});
 if(!current())return;ElMessage.success(mode.value==='bind'?'已绑定，等待仓库确认实际交运':'内部批次已保存，请继续核对官方发运');emit('created',result);
 });}
onMounted(()=>work(async()=>{boot.value=await service.bootstrap();if(!current())return;if(props.batchId){target.value=await service.detail(props.batchId);if(!current())return;}await recheck();await Promise.all([load(),savedApplications()]);}));
watch(computed(currentScope),()=>{alive=false;visible.value=false;emit('close');});
watch(mode,value=>{if(value!=='create')return;target.value=null;reviewed.value=new Map();requestKey.value=crypto.randomUUID();work(async()=>{await recheck();await load(true);});});
onBeforeUnmount(()=>{alive=false;++readVersion;++previewVersion;});
</script>
<template>
 <el-dialog v-model="visible" title="OGL 组批与绑定发运" width="min(2200px,98vw)" top="3vh" class="ogl-composer-dialog" append-to-body destroy-on-close :close-on-click-modal="false" @closed="emit('close')">
  <section class="ogl-composer" v-loading="busy">
   <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon/>
   <el-alert title="绑定仅建立跟踪关系。仓库确认实际交运后才登记出库；各店铺订单仍由原店铺同步平台状态。" type="info" :closable="false"/>
   <el-radio-group v-model="mode" aria-label="发运处理方式"><el-radio-button value="bind">绑定已有 Ozon 发运单</el-radio-button><el-radio-button value="create">接口创建：先保存内部批次</el-radio-button></el-radio-group>
   <section v-if="mode==='bind'" class="composer-section">
    <header><strong>选择默认发运店铺的已有申请</strong><span>仅显示本企业有权访问的记录</span></header>
    <div class="composer-toolbar"><el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="发运开始日期" end-placeholder="发运结束日期"/><el-button @click="work(()=>savedApplications())">查询已保存申请</el-button><el-button type="primary" plain @click="work(()=>savedApplications(true))">同步 Ozon 已有申请</el-button></div>
    <p v-if="!boot.settings.dispatch_shop_id">尚未配置默认发运店铺，请从“OGL 发运 → 已申请”由企业管理员配置。</p>
    <el-table :data="officialRows" border max-height="220" row-key="local_batch_id" empty-text="此范围没有已保存的申请，可同步 Ozon 后重试">
     <el-table-column label="Ozon 申请 / 创建店铺" min-width="230"><template #default="{row}">{{row.carriage_id||row.id}} · {{row.dispatch_shop?.name||'待核对'}}</template></el-table-column>
     <el-table-column prop="departure_date" label="发运日期（北京）" width="170"/>
     <el-table-column label="货位 / 状态" min-width="150"><template #default="{row}">{{row.containers_count??'待核对'}} 个 · {{row.status_label||row.status}}</template></el-table-column>
     <el-table-column label="批次运单号" min-width="230"><template #default="{row}">{{row.tracking_numbers?.join('、')||row.master_tracking_number||'打开详情获取；不推断分箱关系'}}</template></el-table-column>
     <el-table-column label="选择" width="100"><template #default="{row}"><el-button type="primary" plain :disabled="!row.local_batch_id&&!row.batch_id" @click="choose(row)">{{Number(target?.batch.id)===Number(row.local_batch_id||row.batch_id)?'已选择':'选择'}}</el-button></template></el-table-column>
    </el-table>
    <div v-if="target" class="composer-target"><strong>已选：{{target.batch.official_carriage_id}} · {{target.batch.dispatch_shop_name}}</strong><el-button link type="primary" @click="emit('open-batch',target.batch.id)">查看申请、多个运单与分箱详情</el-button><span>关闭详情可回到本窗口，所选订单保留。</span></div>
    <div v-if="historicalTarget" class="composer-history-review"><el-alert title="历史批次补关联：请核对这些订单确实同批发出。这里只补充系统关联，仓库仍需单独确认实际交运。" type="warning" :closable="false"/><el-checkbox v-model="historicalConfirmed">确认这些订单当时实际同批发出，先补关联待仓库核实</el-checkbox><el-input v-model="historicalNote" type="textarea" :rows="2" maxlength="500" placeholder="填写核对依据，例如交运日期、打包批次或原始记录（必填）" aria-label="历史批次补关联说明"/></div>
   </section>
   <section class="composer-section">
    <header><strong>按打印记录选择订单</strong><span>默认今天打印 · 可跨页勾选 · 北京时间</span></header>
    <div class="composer-toolbar">
     <el-date-picker v-model="filters.printed_from" type="date" value-format="YYYY-MM-DD" placeholder="打印开始日期"/><el-date-picker v-model="filters.printed_to" type="date" value-format="YYYY-MM-DD" placeholder="打印结束日期"/>
     <el-select v-model="filters.shop_id" aria-label="打印订单店铺"><el-option value="all" label="全部店铺"/><el-option v-for="shop in boot.shops" :key="shop.id" :value="String(shop.id)" :label="shop.name"/></el-select>
     <el-input v-model="filters.search" placeholder="订单 / 货件号" aria-label="查找已打印订单" @keyup.enter="load(true)"/>
     <el-input v-model="filters.print_batch_id" placeholder="打印批次（选填）"/>
     <el-select v-model="filters.review" aria-label="标记复核筛选"><el-option value="all" label="全部标记情况"/><el-option value="clear" label="无标记和备注"/><el-option value="review" label="有标记或备注待复核"/></el-select>
     <el-select v-model="filters.binding" aria-label="绑定情况"><el-option value="unbound" label="未绑定 / 当前申请"/><el-option value="all" label="含已绑定其他批次"/></el-select>
     <el-button type="primary" :loading="loading" @click="load(true)">查询打印订单</el-button>
    </div>
    <el-alert v-if="summary" :title="`匹配 ${summary.matched} 单，可加入 ${summary.eligible} 单，不可加入 ${summary.rejected} 单。默认只展示可加入订单，分页数量与当前列表一致。`" type="info" :closable="false"/>
    <div class="composer-toolbar"><el-radio-group v-model="filters.eligibility" @change="load(true)" aria-label="订单加入状态"><el-radio-button value="eligible">可加入{{summary?`（${summary.eligible}）`:''}}</el-radio-button><el-radio-button value="rejected">不可加入{{summary?`（${summary.rejected}）`:''}}</el-radio-button><el-radio-button value="all">全部打印订单</el-radio-button></el-radio-group><span v-if="filters.eligibility==='eligible'&&!rows.length&&!loading">请查看不可加入原因，或调整打印日期；未打印订单需先完成打印。</span></div>
    <div v-if="rejectionSummary.length" class="composer-reasons"><el-tag v-for="item in rejectionSummary" :key="item.code" type="info">{{item.reason}}：{{item.count}} 单</el-tag></div>
    <OglOrderTable :rows="rows" :selected="selected" :reviewed="reviewed" :page-selected="pageSelected" v-loading="loading" @toggle="toggle" @toggle-page="togglePage" @review="review" @open-order="id=>emit('open-order',id)" @open-batch="id=>emit('open-batch',id)"/>
    <el-pagination v-model:current-page="filters.page" :page-size="filters.page_size" :total="total" layout="total,prev,pager,next" @current-change="load()"/>
   </section>
   <section class="composer-section">
    <header><strong>本次已选 {{selected.size}} 单（含其他页）</strong><el-button :disabled="!selected.size" @click="selected=new Map()">清空本次已选</el-button></header>
    <OglOrderTable v-if="selected.size" :rows="selectedRows" :selected="selected" :reviewed="reviewed" removable @toggle="toggle" @review="review" @open-order="id=>emit('open-order',id)" @open-batch="id=>emit('open-batch',id)"/>
    <p v-else>尚未选择订单。点击上方订单号可查看完整详情；关闭详情后会回到这里，保留筛选、页码和跨页选择。</p>
    <el-input v-if="reviewRows.length" v-model="reviewNote" type="textarea" :rows="2" maxlength="500" placeholder="填写人工复核说明；不会自动清除原标记或备注" aria-label="发运复核说明"/>
    <el-form-item v-if="mode==='create'" label="实际大袋 / 大箱数量"><el-input-number v-model="count" :min="1" :max="1000" :precision="0"/></el-form-item>
   </section>
  </section>
  <template #footer><div class="composer-footer"><span>已选 {{selected.size}} 单；绑定后待交运，实际交出后再确认出库。</span><el-button :disabled="busy" @click="visible=false">返回订单</el-button><el-button type="primary" :loading="busy" :disabled="!canSave" @click="save">{{mode==='bind'?(historicalTarget?'确认补关联，等待仓库核实':'确认绑定，保持待交运'):'保存内部批次并继续'}}</el-button></div></template>
 </el-dialog>
</template>
<style scoped>
.ogl-composer{display:grid;gap:16px;max-height:calc(90vh - 140px);overflow:auto;padding-right:4px}.composer-history-review{display:grid;gap:10px}.composer-reasons{display:flex;flex-wrap:wrap;gap:8px}.composer-section{display:grid;gap:12px;padding:14px;border:1px solid var(--el-border-color-lighter);border-radius:8px}.composer-section header,.composer-target,.composer-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between}.composer-section header span,.composer-target span,.composer-footer span{font-size:12px;color:var(--el-text-color-secondary)}.composer-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.composer-toolbar>.el-input,.composer-toolbar>.el-select{width:190px}.composer-toolbar :deep(.el-date-editor){max-width:300px}.composer-toolbar .el-button{margin:0}.ogl-composer small{display:block;color:var(--el-text-color-secondary);font-size:12px;margin-top:5px}.composer-target{padding:10px;background:var(--el-fill-color-light)}.composer-section>.el-pagination{justify-content:flex-end}.composer-footer .el-button{margin:0}
</style>
