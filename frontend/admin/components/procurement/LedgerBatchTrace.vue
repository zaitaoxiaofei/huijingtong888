<script setup>
import { computed, ref, watch } from 'vue';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';
const props = defineProps({ orders: { type: Array, default: () => [] }, batches: { type: Array, default: () => [] }, batchId: Number, inference: Object, saving: Boolean });
const emit = defineEmits(['reconcile', 'purchases']);
const checked = ref([]);
const checkedTotal = computed(() => checked.value.reduce((sum, row) => sum + Number(row.quantity), 0));
const candidateTotal = computed(() => suggestions.value.filter(row => row.purpose === 'history_candidate').reduce((sum, row) => sum + row.quantity, 0));
const currentReserved = computed(() => reserved.value + suggestions.value.filter(row => row.purpose === 'stock_suggestion' && !row.already_allocated).reduce((sum, row) => sum + row.quantity, 0));
const unexplained = computed(() => Math.max(0, Number(batch.value?.unallocated_quantity || 0) - currentReserved.value - candidateTotal.value));
function reconcile() { emit('reconcile', { inbound_id: selected.value, allocations: checked.value.map(row => ({ order_item_id: row.order_item_id, quantity: row.quantity })) }); }
const suggestions = computed(() => (props.inference?.suggestions || []).filter(row => row.batch_id === selected.value));
const reserved = computed(() => (props.inference?.reserves || []).filter(row => row.batch_id === selected.value).reduce((sum, row) => sum + row.quantity, 0));
const suggestionPage = ref(1);
const pagedSuggestions = computed(() => suggestions.value.slice((suggestionPage.value - 1) * 30, suggestionPage.value * 30));
const selected = ref(null), scope = ref('all'), page = ref(1);
watch(() => props.batchId, value => { selected.value = value || null; }, { immediate: true });
const batch = computed(() => props.batches.find(row => Number(row.id) === selected.value));
const rows = computed(() => props.orders.filter(order => scope.value === 'all' || (scope.value === 'current' ? order.needs_fulfillment : order.entered_transport))
  .flatMap(order => (order.coverage_trace || []).filter(source => source.batch_id === selected.value && selected.value != null)
    .map(source => ({ ...order, ...source, allocated_quantity: source.quantity, historical: order.entered_transport }))));
const total = computed(() => rows.value.reduce((sum, row) => sum + row.allocated_quantity, 0));
watch([selected, scope, () => props.inference], () => { page.value = 1; suggestionPage.value = 1; checked.value = []; });
const purpose = row => row.purpose === 'source' ? '采购来源核对（非当前现货）' : row.historical ? '历史收货待核（非现货覆盖）' : '当前采购在途覆盖';
</script>
<template>
  <p>按采购单／收货批次反查。同一采购单分批收货会分开显示；来源核对数量不等于当前仓库剩余数量。</p>
  <el-select v-model="selected" filterable clearable placeholder="选择采购单／批次" style="width: min(100%, 650px)">
    <el-option v-for="item in batches" :key="item.id" :value="Number(item.id)" :label="`${item.purchase_order_no || '未关联采购单'} · 批次 #${item.id} · ${item.status === 'approved' ? '已收货' : '待收货'} ${item.quantity} 件`" />
  </el-select>
  <template v-if="batch">
    <p>采购单 {{ batch.purchase_order_no || '未关联' }} · 采购时间 {{ shanghaiDateTimeText(batch.purchased_at) }} · 本批次 {{ batch.quantity }} 件 · {{ batch.status === 'approved' ? '已收货' : '待收货' }}</p>
    <el-alert v-if="!batch.purchase_order_no" type="warning" :closable="false" title="这笔收货没有采购单号，不能把批次编号当成采购单号。可暂留待核，不影响现货分配。" />
    <el-button v-if="!batch.purchase_order_no" size="small" plain @click="emit('purchases')">查看已有采购与成本</el-button>
    <p v-if="batch.status === 'pending_arrival'">本批次待收 {{ batch.quantity }} = 已分配／待核 {{ Number(batch.quantity) - Number(batch.unallocated_quantity || 0) }} + 尚未分配 {{ batch.unallocated_quantity || 0 }} 件。历史待核部分不能视为已到货。</p>
    <p v-else>本批次 {{ batch.quantity }} = 已关联／推算核对 {{ Number(batch.quantity) - Number(batch.unallocated_quantity || 0) }} + 尚未匹配来源 {{ batch.unallocated_quantity || 0 }} 件；尚未匹配不代表现货。</p>
    <el-radio-group v-model="scope"><el-radio-button value="all">全部关联</el-radio-button><el-radio-button value="current">待履约订单</el-radio-button><el-radio-button value="history">历史已发订单</el-radio-button></el-radio-group>
    <p>当前筛选关联数量：{{ total }} 件（{{ rows.length }} 条）。不在当前范围的关联不计入此小计。</p>
    <el-table :data="rows.slice((page - 1) * 30, page * 30)" max-height="380" empty-text="没有匹配的订单关联">
      <el-table-column prop="posting_number" label="订单号" min-width="180" />
      <el-table-column label="订单范围" width="120"><template #default="{ row }">{{ row.historical ? '历史已发' : '待履约' }}</template></el-table-column>
      <el-table-column label="下单时间（北京）" min-width="170"><template #default="{ row }">{{ shanghaiDateTimeText(row.ordered_at) }}</template></el-table-column>
      <el-table-column prop="allocated_quantity" label="本批次关联数量" width="140" />
      <el-table-column label="用途" min-width="220"><template #default="{ row }">{{ purpose(row) }}</template></el-table-column>
      <el-table-column label="依据" min-width="170"><template #default="{ row }">{{ row.basis === 'recorded' ? '已记录关联' : '按顺序推算，非出库凭证' }}</template></el-table-column>
    </el-table>
    <el-pagination v-if="rows.length > 30" v-model:current-page="page" :page-size="30" :total="rows.length" layout="prev, pager, next, total" />
    <template v-if="suggestions.length || reserved">
      <h4>待人工核对</h4>
      <p>尚未匹配 {{ batch.unallocated_quantity || 0 }} 件 = 当前现货保留 {{ currentReserved }} 件 + 历史订单候选 {{ candidateTotal }} 件 + 去向待核 {{ unexplained }} 件。</p>
      <p>现货保留是来源推算，不是确认的拣货批次。勾选已核实的历史订单后一次关联；未勾选的保持待核，不改变本地库存。</p>
      <el-table :key="`${selected}-${suggestionPage}`" :data="pagedSuggestions" max-height="300" @selection-change="checked = $event">
        <el-table-column type="selection" width="45" :selectable="row => row.purpose === 'history_candidate' && !saving" />
        <el-table-column prop="posting_number" label="订单" min-width="180" />
        <el-table-column prop="quantity" label="建议数量" width="110" />
        <el-table-column label="说明" min-width="260"><template #default="{ row }">{{ row.purpose === 'stock_suggestion' ? '当前现货来源推算，非实际拣货批次' : row.late_registration ? '晚登记到货候选，需确认当时已到货' : '历史来源候选，待核实' }}</template></el-table-column>
      </el-table>
      <el-pagination v-if="suggestions.length > 30" v-model:current-page="suggestionPage" :page-size="30" :total="suggestions.length" layout="prev, pager, next, total" />
      <p>本页已选 {{ checked.length }} 条，共 {{ checkedTotal }} 件。<el-button type="primary" :disabled="!checked.length" :loading="saving" @click="reconcile">确认所选来源</el-button></p>
    </template>
  </template>
</template>
