<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { parse1688File, parsePddFile } from "../../utils/procurement-file-parsers.js";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const loading = ref(false);
const importing = ref(false);
const fileInput = ref(null);
const bindVisible = ref(false);
const candidates = ref([]);
const selectedIds = ref([]);
const currentOrder = ref(null);
const state = reactive({ rows: [], total: 0, filters: { platform: "pdd", bindingStatus: "all", query: "", page: 1, pageSize: 20 } });
const selectedCandidates = computed(() => candidates.value.filter((item) => selectedIds.value.includes(Number(item.id))));

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams(Object.entries(state.filters).filter(([, value]) => value !== ""));
    const result = await apiClient.get(`/api/procurement/platform-orders?${params}`);
    state.rows = result.rows || [];
    state.total = Number(result.total || 0);
  } catch (error) { ElMessage.error(error.message || "平台订单加载失败"); }
  finally { loading.value = false; }
}

function chooseFile() { fileInput.value?.click(); }
async function importFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  importing.value = true;
  try {
    const rows = state.filters.platform === "1688" ? await parse1688File(file) : await parsePddFile(file);
    const result = await apiClient.post("/api/procurement/platform-orders/import", { platform: state.filters.platform, rows });
    ElMessage.success(`导入 ${result.total} 单：新增 ${result.inserted}，更新 ${result.updated}`);
    state.filters.page = 1;
    await load();
  } catch (error) { ElMessage.error(error.message || "导入失败，请确认文件来自当前选择的平台"); }
  finally { importing.value = false; }
}

async function openBinding(row) {
  currentOrder.value = row;
  selectedIds.value = [];
  bindVisible.value = true;
  try { candidates.value = await apiClient.get(`/api/procurement/platform-orders/${row.id}/candidates`) || []; }
  catch (error) { ElMessage.error(error.message || "候选采购记录加载失败"); }
}

async function saveBinding() {
  if (!selectedCandidates.value.length) return ElMessage.warning("请至少选择一条采购记录");
  const count = selectedCandidates.value.length;
  const amount = Number(currentOrder.value?.paid_amount || 0);
  const quantity = Number(currentOrder.value?.quantity || 0);
  await apiClient.post(`/api/procurement/platform-orders/${currentOrder.value.id}/link`, {
    links: selectedCandidates.value.map((item, index) => ({
      procurement_request_id: item.id,
      allocated_amount: index === count - 1 ? amount - Math.round((amount / count) * 100) / 100 * (count - 1) : Math.round((amount / count) * 100) / 100,
      allocated_quantity: index === count - 1 ? quantity - Math.floor(quantity / count) * (count - 1) : Math.floor(quantity / count)
    }))
  });
  ElMessage.success("平台订单已绑定采购记录");
  bindVisible.value = false;
  await load();
}

function timeText(value) { return shanghaiDateTimeText(value, { assumeUtcWhenNaive: false }); }
function money(value) { return `¥${Number(value || 0).toFixed(2)}`; }
function search() { state.filters.page = 1; load(); }
onMounted(load);
</script>

<template>
  <div class="page-shell">
    <ErpPageHeader title="平台订单" description="导入拼多多或 1688 平台订单，再与采购工作台记录绑定。">
      <template #actions>
        <input ref="fileInput" type="file" :accept="state.filters.platform === '1688' ? '.xlsx' : '.csv,.json'" hidden @change="importFile">
        <el-button type="primary" :loading="importing" @click="chooseFile">导入{{ state.filters.platform === '1688' ? '1688 Excel' : '拼多多 CSV / JSON' }}</el-button>
      </template>
    </ErpPageHeader>
    <ErpFilterBar>
      <el-select v-model="state.filters.platform" style="width: 130px" @change="search"><el-option label="拼多多" value="pdd" /><el-option label="1688" value="1688" /></el-select>
      <el-select v-model="state.filters.bindingStatus" style="width: 130px" @change="search"><el-option label="全部状态" value="all" /><el-option label="待绑定" value="unbound" /><el-option label="已绑定" value="bound" /></el-select>
      <el-input v-model="state.filters.query" clearable placeholder="订单号 / 店铺 / 商品" style="width: 260px" @keyup.enter="search" />
      <el-button @click="search">查询</el-button>
    </ErpFilterBar>
    <el-card shadow="never">
      <div class="platform-orders-table erp-responsive-table" role="region" aria-label="平台采购订单表格" tabindex="0">
      <el-table v-loading="loading" :data="state.rows" border>
        <el-table-column prop="platform_order_no" label="平台订单号" width="190" />
        <el-table-column label="下单时间" width="170"><template #default="{ row }">{{ timeText(row.order_time) }}</template></el-table-column>
        <el-table-column prop="product_name" label="商品" min-width="260" show-overflow-tooltip />
        <el-table-column prop="shop_name" label="店铺" width="150" show-overflow-tooltip />
        <el-table-column prop="quantity" label="数量" width="70" />
        <el-table-column label="实付" width="100"><template #default="{ row }">{{ money(row.paid_amount) }}</template></el-table-column>
        <el-table-column prop="platform_status" label="订单状态" width="110" />
        <el-table-column label="采购绑定" min-width="180"><template #default="{ row }"><el-tag :type="row.binding_status === 'bound' ? 'success' : 'warning'">{{ row.binding_status === 'bound' ? '已绑定' : '待绑定' }}</el-tag><span v-if="row.linked_request_names" class="linked">{{ row.linked_request_names }}</span></template></el-table-column>
        <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openBinding(row)">{{ row.binding_status === 'bound' ? '重新绑定' : '绑定采购' }}</el-button></template></el-table-column>
      </el-table>
      </div>
      <PageFooterPagination v-model:page="state.filters.page" v-model:page-size="state.filters.pageSize" :total="state.total" @change="load" />
    </el-card>

    <el-dialog v-model="bindVisible" title="绑定采购记录" width="900px">
      <el-alert type="info" :closable="false" :title="`平台实付 ${money(currentOrder?.paid_amount)}，可绑定一条或多条采购记录`" />
      <el-table :data="candidates" height="430" @selection-change="(rows) => selectedIds = rows.map((row) => Number(row.id))">
        <el-table-column type="selection" width="48" />
        <el-table-column prop="request_group_no" label="采购批次" width="155" />
        <el-table-column prop="raw_name" label="采购名称" min-width="220" />
        <el-table-column prop="person_name" label="负责人" width="90" />
        <el-table-column label="记录金额" width="100"><template #default="{ row }">{{ money(Number(row.amount) + Number(row.shipping_amount)) }}</template></el-table-column>
        <el-table-column label="匹配度" width="80"><template #default="{ row }">{{ row.confidence }}%</template></el-table-column>
        <el-table-column label="创建时间" width="165"><template #default="{ row }">{{ timeText(row.created_at) }}</template></el-table-column>
      </el-table>
      <template #footer><el-button @click="bindVisible = false">取消</el-button><el-button type="primary" @click="saveBinding">确认绑定</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-shell { display: flex; flex-direction: column; gap: 14px; }
.linked { margin-left: 8px; color: var(--el-text-color-secondary); }
@media (max-width: 767px) {
  .linked { display: block; margin: 5px 0 0; }
}
</style>
