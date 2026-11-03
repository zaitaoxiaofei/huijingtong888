<script setup>
import { onBeforeUnmount,onMounted, ref,watch } from "vue";
import { ElDialog,ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "../../stores/auth";
import { apiClient,currentApiCacheScope } from "../../utils/api";
import { invalidateInventoryNamingOptions, invalidateInventoryVehicleCatalog } from "../../utils/inventory-naming-options";
import { dateText } from "../../views/inventory/inventory-utils.js";
import ProductCreateEditDialog from "./ProductCreateEditDialog.vue";

const props = defineProps({
  embedded:Boolean,
  requestId:{type:Number,default:0},
  people: { type: Array, default: () => [] },
  suppliers: { type: Array, default: () => [] },
  logisticsRules: { type: Array, default: () => [] }
});
const emit = defineEmits(["close", "changed"]);
const authStore = useAuthStore();
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const status = ref("pending");
const canReview = ref(false);
const loading = ref(false);
const busyId = ref(null);
const detail = ref(null);
const editorVisible = ref(false);
const editorRequest = ref(null);
let alive=true,readVersion=0,detailVersion=0;
const pendingCount=ref(0);
const labels = { pending: "待审核", returned: "已退回", approved: "已通过" };

async function load() {
  const scope=currentApiCacheScope(),version=++readVersion;
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/inventory-product-requests?status=${status.value}&page=${page.value}`, { noCache: true });
    if(!alive||scope!==currentApiCacheScope()||version!==readVersion)return;
    pendingCount.value=Number(result.pending_count||0);
    rows.value = result.rows || [];
    total.value = result.total || 0;
    canReview.value = result.can_review;
  } catch (error) { if(alive&&scope===currentApiCacheScope()&&version===readVersion)ElMessage.error(error.message || "建品申请加载失败"); }
  finally { if(alive&&scope===currentApiCacheScope()&&version===readVersion)loading.value = false; }
}

async function openEditor(row, action) {
  const scope=currentApiCacheScope(),version=++detailVersion;
  busyId.value = row.id;
  try {
    const result = await apiClient.get(`/api/inventory-product-requests/${row.id}`, { noCache: true });
    if(!alive||scope!==currentApiCacheScope()||version!==detailVersion)return;
    detail.value=result;
    editorRequest.value = { id: row.id, revision: detail.value.revision, action };
    editorVisible.value = true;
  } catch (error) { if(alive&&scope===currentApiCacheScope()&&version===detailVersion)ElMessage.error(error.message || "申请详情加载失败"); }
  finally { if(scope===currentApiCacheScope()&&version===detailVersion)busyId.value = null; }
}

async function returnRequest(row) {
  try {
    const { value } = await ElMessageBox.prompt("请说明需要补充或修改的信息，员工可在原申请中修改后重新提交。", "退回建品申请", {
      inputType: "textarea", inputValidator: value => Boolean(String(value || "").trim()) || "请填写退回原因",
      confirmButtonText: "退回", cancelButtonText: "取消"
    });
    busyId.value = row.id;
    await apiClient.put(`/api/inventory-product-requests/${row.id}`, { action: "return", revision: row.revision, review_note: value });
    ElMessage.success("已退回，原建品信息已保留");
    await load();
  } catch (error) { if (error !== "cancel" && error !== "close") ElMessage.error(error.message || "退回失败"); }
  finally { busyId.value = null; }
}

async function retryBinding(row) {
  busyId.value = row.id;
  try {
    const result = await apiClient.put(`/api/inventory-product-requests/${row.id}`, { action: "retry_binding" });
    if (result.binding_status === "failed") ElMessage.error(result.binding_error);
    else ElMessage.success("订单绑定已完成");
    await changed();
  } catch (error) { ElMessage.error(error.message || "重试失败"); }
  finally { busyId.value = null; }
}

async function changed() {
  invalidateInventoryNamingOptions();
  invalidateInventoryVehicleCatalog();
  window.dispatchEvent(new CustomEvent('erp:inventory-product-requests-changed'));
  emit("changed");
  await load();
}

async function openRequested(){
 if(!props.requestId)return;
 const scope=currentApiCacheScope(),version=++detailVersion;
 try{const row=await apiClient.get(`/api/inventory-product-requests/${props.requestId}`,{noCache:true});if(!alive||scope!==currentApiCacheScope()||version!==detailVersion)return;detail.value=row;editorRequest.value={id:row.id,revision:row.revision,action:row.status==='pending'&&row.can_review?'approve':'view'};editorVisible.value=true;}catch(error){if(alive&&scope===currentApiCacheScope())ElMessage.error(error.message||'申请详情加载失败');}
}
watch(()=>props.requestId,openRequested);
watch(()=>currentApiCacheScope(),()=>{readVersion++;detailVersion++;busyId.value=null;rows.value=[];total.value=0;pendingCount.value=0;editorVisible.value=false;detail.value=null;void load();});
onMounted(async()=>{await load();await openRequested();});
onBeforeUnmount(()=>{alive=false;readVersion++;detailVersion++;});
</script>

<template>
  <component :is="embedded?'section':ElDialog" :model-value="true" title="库存申请" width="min(1280px, 96vw)" class="inventory-request-center" @update:model-value="!$event && emit('close')">
    <h2 v-if="embedded">库存申请 <el-tag :type="pendingCount?'danger':'info'">待审核 {{pendingCount}}</el-tag></h2>
    <el-alert type="info" :closable="false" :title="canReview ? '审核新名称和完整建品信息，通过后自动创建库存。可在审核表单中改成标准名称或选用已有名称。' : '这里显示你提交的建品申请。退回后可修改原表单，通过后自动创建库存。'" />
    <div class="request-toolbar">
      <el-select v-model="status" style="width: 160px" @change="page = 1; load()">
        <el-option label="全部状态" value="" />
        <el-option v-for="(label, value) in labels" :key="value" :label="label" :value="value" />
      </el-select>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-table v-loading="loading" :data="rows" row-key="id" max-height="560" :row-style="{ height: '92px' }">
      <el-table-column label="图片" width="88">
        <template #default="{ row }">
          <el-image v-if="row.image_url" :src="row.image_url" class="request-image" fit="cover" :preview-src-list="[row.image_url]" :initial-index="0" preview-teleported />
          <span v-else class="request-image request-image--empty">无图</span>
        </template>
      </el-table-column>
      <el-table-column label="建品信息" min-width="230">
        <template #default="{ row }">
          <strong>{{ row.name }}</strong>
          <div class="request-meta">申请 #{{ row.id }} · {{ row.applicant_name }}</div>
          <div class="request-meta">{{ dateText(row.created_at) }}</div>
          <div v-if="row.product_id">已关联库存 #{{ row.product_id }}</div>
        </template>
      </el-table-column>
      <el-table-column label="新增选项" min-width="200">
        <template #default="{ row }"><div v-for="item in row.new_options" :key="`${item.type}:${item.value}`">{{ item.label }}：{{ item.brand ? `${item.brand} / ` : '' }}{{ item.value }}</div></template>
      </el-table-column>
      <el-table-column label="状态 / 审核反馈" min-width="190">
        <template #default="{ row }">
          <el-tag :type="row.status === 'approved' ? 'success' : row.status === 'returned' ? 'danger' : 'warning'">{{ labels[row.status] }}</el-tag>
          <div v-if="row.review_note">{{ row.review_note }}</div>
          <div v-if="['pending', 'failed'].includes(row.binding_status)">库存已创建，订单待绑定：{{ row.binding_error || '可重试完成绑定' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }">
          <el-button v-if="!canReview || row.status !== 'pending'" link type="primary" :disabled="busyId !== null" @click="openEditor(row, 'view')">查看详情</el-button>
          <template v-if="canReview && row.status === 'pending'">
            <el-button link type="primary" :disabled="busyId !== null" @click="openEditor(row, 'approve')">查看并审核</el-button>
            <el-button link type="danger" :disabled="busyId !== null" @click="returnRequest(row)">退回</el-button>
          </template>
          <el-button v-if="row.status === 'returned' && Number(row.applicant_id) === Number(authStore.user?.personId || authStore.user?.id)" link type="primary" :disabled="busyId !== null" @click="openEditor(row, 'resubmit')">修改并重提</el-button>
          <el-button v-if="canReview && row.status === 'approved' && ['pending', 'failed'].includes(row.binding_status)" link type="warning" :disabled="busyId !== null" @click="retryBinding(row)">重试订单绑定</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination v-model:current-page="page" :page-size="20" :total="total" layout="total, prev, pager, next" @current-change="load" />
    <ProductCreateEditDialog v-if="editorVisible" v-model:visible="editorVisible" mode="create" target="inventory"
      :value="detail.payload" :inventory-request="editorRequest" :people="props.people" :suppliers="props.suppliers" :logistics-rules="props.logisticsRules" @submitted="changed" />
  </component>
</template>

<style scoped>
.inventory-request-center{min-width:0;background:var(--el-bg-color);padding:16px;border-radius:8px}.inventory-request-center h2{display:flex;align-items:center;gap:12px;font-size:18px;margin:0 0 16px}
.request-toolbar { display: flex; gap: 12px; margin: 16px 0; }
.request-image { display: inline-flex; width: 64px; height: 84px; border-radius: 6px; vertical-align: middle; }
.request-image--empty { align-items: center; justify-content: center; background: var(--erp-detail-surface-alt, #f5f7fa); color: var(--erp-detail-text-secondary, #909399); }
.request-meta { color: var(--erp-detail-text-regular, #606266); font-size: 12px; margin-top: 4px; }
.el-pagination { margin-top: 16px; justify-content: flex-end; }
</style>
