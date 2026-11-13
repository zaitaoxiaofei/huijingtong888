<script setup>
import {computed,ref,onMounted,onBeforeUnmount,watch} from 'vue';
import {useRouter} from 'vue-router';
import {ElMessage,ElMessageBox} from 'element-plus';
import {Delete,Edit,Refresh} from '@element-plus/icons-vue';
import WbPublishMediaSummary from '../../components/listing/WbPublishMediaSummary.vue';
import PageFooterPagination from '../../components/PageFooterPagination.vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {wbPublishStatus,wbPublishPhase} from '../../../../src/shared/wb-publish-status.js';
import {wbListingVariants} from '../../../../src/shared/wb-listing-variants.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import {wbRecordProducts,wbRecordPriceText,wbRecordPriceSource,wbRecordScore,wbRecordHasOnlineSku,wbRecordCanDelete,wbRecordStatusType,wbRecordOnlineStatus,wbRecordMatches} from '../../utils/wb-publish-record-view.js';

const router=useRouter(),rows=ref([]),loading=ref(false),selected=ref(null),skuRecord=ref(null),syncingId=ref(null),deletingId=ref(null),resumingId=ref(null);
const syncWarnings=ref({});
const query=ref(''),shopId=ref(''),status=ref(''),page=ref(1),pageSize=ref(20);let timer,generation=0;
const working=computed(()=>Boolean(syncingId.value||deletingId.value||resumingId.value));
const shops=computed(()=>[...new Map(rows.value.map(row=>[Number(row.shop_id),{id:Number(row.shop_id),name:row.shop_name}])).values()]);
const filtered=computed(()=>rows.value.filter(row=>wbRecordMatches(row,{query:query.value,shopId:shopId.value,status:status.value})));
const paged=computed(()=>filtered.value.slice((page.value-1)*pageSize.value,page.value*pageSize.value));
watch([query,shopId,status,pageSize],()=>{page.value=1;});
const time=value=>shanghaiDateTimeText(value,{assumeUtcWhenNaive:true});
const firstProduct=job=>wbRecordProducts(job)[0]||{};
const statusOptions=['queued','processing','needs_review','paused','failed','completed','superseded'];
function edit(job){router.push({path:'/listing-automation',query:{platform:'wb',wbDraftId:String(job.draft_id)}});}
function schedule(){clearTimeout(timer);if(rows.value.some(row=>['queued','processing'].includes(row.status)))timer=setTimeout(load,10000);}
function updateRecord(job){rows.value=rows.value.map(row=>Number(row.id)===Number(job.id)?job:row);if(Number(selected.value?.id)===Number(job.id))selected.value=job;if(Number(skuRecord.value?.id)===Number(job.id))skuRecord.value=job;}
async function load(){
 if(working.value)return;clearTimeout(timer);const id=++generation,scope=currentApiCacheScope();loading.value=true;
 try{const result=await apiClient.get('/api/wb/publish-records',{noCache:true});if(id!==generation||scope!==currentApiCacheScope())return;rows.value=result.rows||[];selected.value=selected.value?rows.value.find(row=>Number(row.id)===Number(selected.value.id))||null:null;skuRecord.value=skuRecord.value?rows.value.find(row=>Number(row.id)===Number(skuRecord.value.id))||null:null;page.value=Math.min(page.value,Math.max(1,Math.ceil(filtered.value.length/pageSize.value)));schedule();}
 catch(error){if(id===generation&&scope===currentApiCacheScope())ElMessage.error(error.message);}
 finally{if(id===generation)loading.value=false;}
}
async function sync(job,open=false){
 if(working.value)return;const requestId=++generation;clearTimeout(timer);loading.value=false;const scope=currentApiCacheScope();syncingId.value=job.id;
 try{const result=await apiClient.post('/api/wb/publish-records/sync',{job_id:job.id});if(scope!==currentApiCacheScope()||requestId!==generation)return;if(!result.job)throw Error('同步结果暂未返回，请刷新记录后重试。');syncWarnings.value={...syncWarnings.value,[job.id]:result.warnings||[]};updateRecord(result.job);if(open)skuRecord.value=result.job;if(result.warnings?.length)ElMessage.warning('部分线上资料尚未返回，请查看同步提示。');else ElMessage.success('已核对 WB 线上商品资料');}
 catch(error){if(scope===currentApiCacheScope()&&requestId===generation)ElMessage.error(error.message);}
 finally{if(scope===currentApiCacheScope()&&requestId===generation){syncingId.value=null;schedule();}}
}
function openSku(job){if(wbRecordHasOnlineSku(job))skuRecord.value=job;else sync(job,true);}
async function remove(job){
 if(working.value)return;if(!wbRecordCanDelete(job))return ElMessage.warning('发布任务仍在处理，请完成后再删除这条记录。');
 const scope=currentApiCacheScope();
 try{await ElMessageBox.confirm('删除后将从 ERP 上架记录中移除；WB 商品和本地草稿继续保留。','删除上架记录',{type:'warning',confirmButtonText:'删除记录',cancelButtonText:'取消'});}catch{return;}
 if(scope!==currentApiCacheScope()||working.value)return;const requestId=++generation;clearTimeout(timer);loading.value=false;deletingId.value=job.id;
 try{await apiClient.post('/api/wb/publish-records/delete',{job_id:job.id});if(scope!==currentApiCacheScope()||requestId!==generation)return;rows.value=rows.value.filter(row=>Number(row.id)!==Number(job.id));if(Number(selected.value?.id)===Number(job.id))selected.value=null;if(Number(skuRecord.value?.id)===Number(job.id))skuRecord.value=null;page.value=Math.min(page.value,Math.max(1,Math.ceil(filtered.value.length/pageSize.value)));ElMessage.success('上架记录已删除');}
 catch(error){if(scope===currentApiCacheScope()&&requestId===generation)ElMessage.error(error.message);}
 finally{if(scope===currentApiCacheScope()&&requestId===generation){deletingId.value=null;schedule();}}
}
async function resume(job,retry=false){
 if(working.value)return;const scope=currentApiCacheScope();
 try{await ElMessageBox.confirm(retry?'将重试本次发布未确认的媒体或价格步骤，不会重复创建商品。':'将继续核对本次提交资料的发布结果。','继续核对发布结果',{type:'warning'});}catch{return;}
 if(scope!==currentApiCacheScope()||working.value)return;const requestId=++generation;clearTimeout(timer);resumingId.value=job.id;
 try{await apiClient.post('/api/wb/listing-publish/resume',{job_id:job.id,retry});if(scope===currentApiCacheScope()&&requestId===generation)ElMessage.success('已继续核对发布结果');}
 catch(error){if(scope===currentApiCacheScope()&&requestId===generation)ElMessage.error(error.message);}
 finally{if(scope===currentApiCacheScope()&&requestId===generation){resumingId.value=null;await load();}}
}
function reset(){generation++;clearTimeout(timer);rows.value=[];selected.value=null;skuRecord.value=null;syncWarnings.value={};syncingId.value=null;deletingId.value=null;resumingId.value=null;query.value='';shopId.value='';status.value='';load();}
onMounted(()=>{load();window.addEventListener('erp:auth-scope-changed',reset);});
onBeforeUnmount(()=>{generation++;clearTimeout(timer);window.removeEventListener('erp:auth-scope-changed',reset);});
</script>

<template>
 <div class="wb-publish-records">
  <div class="records-header"><h3>WB 上架记录</h3><el-button :icon="Refresh" :loading="loading" :disabled="working" @click="load">刷新记录</el-button></div>
  <div class="records-filters"><el-input v-model="query" clearable placeholder="商品名 / 货号 / 线上 SKU / 条码"/><el-select v-model="shopId" clearable placeholder="全部店铺"><el-option v-for="shop in shops" :key="shop.id" :value="shop.id" :label="shop.name"/></el-select><el-select v-model="status" clearable placeholder="全部状态"><el-option v-for="value in statusOptions" :key="value" :value="value" :label="wbPublishStatus(value)"/></el-select></div>
  <el-table :data="paged" v-loading="loading" border stripe row-key="id" class="erp-data-table records-table" empty-text="暂无匹配的 WB 上架记录">
   <el-table-column label="商品" min-width="330"><template #default="{row}"><div class="record-product"><el-image v-if="firstProduct(row).images?.length" :src="firstProduct(row).images[0]" :preview-src-list="firstProduct(row).images" preview-teleported fit="cover" class="product-thumb"/><div v-else class="product-thumb empty-thumb">无图</div><div class="product-info"><strong :title="firstProduct(row).title">{{firstProduct(row).title||'待填写标题'}}</strong><span>{{firstProduct(row).vendor_code||'未填写货号'}}</span><small>记录 {{row.id}} · {{wbRecordProducts(row).length}} 个变体</small><el-button link type="primary" @click="selected=row">查看详情</el-button></div></div></template></el-table-column>
   <el-table-column label="WB 类目" min-width="150" show-overflow-tooltip><template #default="{row}">{{row.category_name||'未返回'}}</template></el-table-column>
   <el-table-column label="上架人" min-width="100" show-overflow-tooltip><template #default="{row}">{{row.publisher_name||'未返回'}}</template></el-table-column>
   <el-table-column prop="shop_name" label="店铺" min-width="140" show-overflow-tooltip/>
   <el-table-column label="状态" min-width="110"><template #default="{row}"><el-tag :type="wbRecordStatusType(row)" effect="plain">{{wbPublishStatus(row.status)}}</el-tag></template></el-table-column>
   <el-table-column label="处理结果" min-width="220" show-overflow-tooltip prop="message"/>
   <el-table-column label="内容评分" min-width="140"><template #default="{row}"><div class="score-cell"><strong>{{wbRecordScore(row).text}}</strong><small>{{wbRecordScore(row).label}}</small></div></template></el-table-column>
   <el-table-column label="线上 SKU" width="110" align="center"><template #default="{row}"><el-button link type="primary" :loading="syncingId===row.id" :disabled="working&&syncingId!==row.id" @click="openSku(row)">{{wbRecordHasOnlineSku(row)?'查看':'同步'}}</el-button></template></el-table-column>
   <el-table-column label="售价" min-width="140"><template #default="{row}"><div class="score-cell"><span>{{wbRecordPriceText(row)}}</span><small>{{wbRecordPriceSource(row)}}</small></div></template></el-table-column>
   <el-table-column label="上架时间（北京）" width="180"><template #default="{row}">{{time(row.published_at)}}</template></el-table-column>
   <el-table-column label="更新时间（北京）" width="180"><template #default="{row}">{{time(row.updated_at)}}</template></el-table-column>
   <el-table-column label="操作" width="205" fixed="right"><template #default="{row}"><div class="row-actions"><el-button link type="primary" :icon="Edit" :disabled="working" @click="edit(row)">编辑</el-button><el-tooltip :disabled="wbRecordCanDelete(row)" content="发布任务仍在处理，请完成后再删除记录。"><span><el-button link type="danger" :icon="Delete" :loading="deletingId===row.id" :disabled="working||!wbRecordCanDelete(row)" @click="remove(row)">删除</el-button></span></el-tooltip><el-button v-if="['needs_review','paused'].includes(row.status)" link type="primary" :disabled="working" @click="resume(row)">继续核对</el-button></div></template></el-table-column>
  </el-table>
  <PageFooterPagination :total="filtered.length" :page="page" :page-size="pageSize" :disabled="loading||working" @update:page="page=$event" @update:page-size="pageSize=$event"/>

  <el-drawer v-if="skuRecord" :model-value="true" title="WB 线上 SKU 与条码" size="min(900px,95vw)" @close="skuRecord=null">
   <div class="drawer-heading"><p>店铺：{{skuRecord.shop_name}} · 记录 {{skuRecord.id}}</p><el-button type="primary" :loading="syncingId===skuRecord.id" :disabled="working&&syncingId!==skuRecord.id" @click="sync(skuRecord)">同步线上资料</el-button></div>
   <el-alert v-for="warning in syncWarnings[skuRecord.id]||[]" :key="warning" :title="warning" type="warning" :closable="false"/>
   <el-alert v-if="!wbRecordHasOnlineSku(skuRecord)" title="WB 尚未返回线上 SKU，请稍后同步。" type="info" :closable="false"/>
   <section v-for="(product,index) in wbRecordProducts(skuRecord)" :key="product.vendor_code||index" class="online-product">
    <div class="record-product"><el-image v-if="product.images.length" :src="product.images[0]" :preview-src-list="product.images" preview-teleported fit="cover" class="product-thumb"/><div v-else class="product-thumb empty-thumb">无图</div><div class="product-info"><strong>{{product.title||'待填写标题'}}</strong><span>{{product.vendor_code}}</span></div></div>
    <dl class="online-fields"><dt>线上 SKU（nmID）</dt><dd>{{product.nm_id||'未返回'}}</dd><dt>商品条码</dt><dd><template v-if="product.barcodes.length"><p v-for="barcode in product.barcodes" :key="barcode">{{barcode}}</p></template><template v-else>未同步返回</template></dd><dt>售价</dt><dd>{{wbRecordPriceText({products:[product]})}}<small> · {{wbRecordPriceSource({products:[product]})}}</small></dd><dt>内容评分</dt><dd>{{wbRecordScore({products:[product]}).text}}<small v-if="product.score_label"> · {{product.score_label}}</small></dd><dt>线上状态</dt><dd>{{wbRecordOnlineStatus(product)}}</dd><dt>商品创建（北京）</dt><dd>{{time(product.published_at)}}</dd><dt>同步时间（北京）</dt><dd>{{time(product.synced_at)}}</dd></dl>
   </section>
  </el-drawer>

  <el-drawer v-if="selected" :model-value="true" title="WB 上架记录详情" size="min(900px,95vw)" @close="selected=null">
   <el-alert :title="wbPublishStatus(selected.status)+'：'+(selected.message||'等待核对发布结果')" :type="selected.status==='failed'?'error':wbRecordStatusType(selected)" :closable="false"/>
   <p>店铺：{{selected.shop_name}} · 上架人：{{selected.publisher_name||'未返回'}}</p><p>WB 类目：{{selected.category_name||'未返回'}} · 本次提交草稿版本 {{selected.draft_revision}}</p><p>上架时间（北京）：{{time(selected.published_at)}} · 更新时间（北京）：{{time(selected.updated_at)}}</p>
   <section v-for="(variant,index) in wbListingVariants(selected.payload||{})" :key="index" class="snapshot-product"><h4>{{variant.card?.title||'待填写标题'}}</h4><p>{{variant.card?.vendorCode}} · {{wbPublishPhase(selected.state?.items?.[index]?.phase)}}</p><WbPublishMediaSummary :row="variant" :phase="selected.state?.items?.[index]?.phase||''"/><el-alert v-for="(error,errorIndex) in selected.state?.items?.[index]?.price_errors||[]" :key="errorIndex" :title="String(error.errors||error.status||'价格尚未确认')" type="warning" :closable="false"/></section>
   <div class="record-actions"><el-button :disabled="working" @click="edit(selected)">编辑工作草稿</el-button><el-button type="primary" :disabled="working" @click="openSku(selected)">查看线上 SKU 与条码</el-button><el-button v-if="['needs_review','paused'].includes(selected.status)" :disabled="working" @click="resume(selected)">继续核对发布结果</el-button><el-button v-if="selected.status==='needs_review'&&['media','price'].includes(selected.state?.items?.find(item=>item.phase!=='done')?.phase)" type="warning" :disabled="working" @click="resume(selected,true)">重试当前步骤</el-button></div>
  </el-drawer>
 </div>
</template>

<style scoped>
.wb-publish-records{display:grid;gap:16px;min-width:0}.records-header{display:flex;justify-content:space-between;align-items:center;gap:12px}.records-header h3{margin:0}.records-filters{display:flex;gap:8px;flex-wrap:wrap;padding:12px;border:1px solid var(--el-border-color-lighter);border-radius:8px}.records-filters>.el-input{width:320px}.records-filters>.el-select{width:180px}.record-product{display:flex;align-items:center;gap:10px;min-height:92px}.product-thumb{width:64px;height:84px;flex:none;border-radius:4px}.empty-thumb{display:flex;align-items:center;justify-content:center;background:var(--el-fill-color-light);color:var(--el-text-color-secondary)}.product-info{display:flex;flex-direction:column;gap:5px;min-width:0;align-items:flex-start}.product-info strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;overflow-wrap:anywhere}.product-info span,.product-info small,.score-cell small{color:var(--el-text-color-secondary);font-size:12px}.score-cell{display:flex;flex-direction:column;gap:5px}.row-actions,.record-actions,.drawer-heading{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row-actions .el-button,.record-actions .el-button{margin:0}.row-actions>span{display:inline-flex}.record-actions{margin-top:16px}.drawer-heading{justify-content:space-between;margin-bottom:16px}.online-product,.snapshot-product{padding:16px 0;border-bottom:1px solid var(--el-border-color-lighter)}.online-fields{display:grid;grid-template-columns:145px minmax(0,1fr);gap:12px;margin-bottom:0}.online-fields dt{color:var(--el-text-color-secondary)}.online-fields dd{margin:0;overflow-wrap:anywhere}.online-fields p{margin:0 0 5px}.records-table :deep(.el-table__cell){padding:8px}.wb-publish-records :deep(.el-drawer__body){min-width:0}@media(max-width:700px){.records-filters>.el-input,.records-filters>.el-select{width:100%}.online-fields{grid-template-columns:115px minmax(0,1fr)}}
</style>
