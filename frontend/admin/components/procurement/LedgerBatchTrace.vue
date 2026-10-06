<script setup>
import { computed, ref, watch } from 'vue';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';
const props = defineProps({ orders: { type: Array, default: () => [] }, batches: { type: Array, default: () => [] }, batchId: Number });
const selected = ref(null), scope = ref('all'), page = ref(1);
watch(() => props.batchId, value => { selected.value = value || null; }, { immediate: true });
const batch = computed(() => props.batches.find(row => Number(row.id) === selected.value));
const rows = computed(() => props.orders.filter(order => scope.value === 'all' || (scope.value === 'current' ? order.needs_fulfillment : order.entered_transport))
  .flatMap(order => (order.coverage_trace || []).filter(source => source.batch_id === selected.value && selected.value != null)
    .map(source => ({ ...order, ...source, allocated_quantity: source.quantity, historical: order.entered_transport }))));
const total = computed(() => rows.value.reduce((sum, row) => sum + row.allocated_quantity, 0));
watch([selected, scope], () => { page.value = 1; });
const purpose = row => row.purpose === 'source' ? '采购来源核对（非当前现货）' : row.historical ? '历史收货待核（非现货覆盖）' : '当前采购在途覆盖';
</script>
<template>
  <p>按采购单／收货批次反查。同一采购单分批收货会分开显示；来源核对数量不等于当前仓库剩余数量。</p>
  <el-select v-model="selected" filterable clearable placeholder="选择采购单／批次" style="width: min(100%, 650px)">
    <el-option v-for="item in batches" :key="item.id" :value="Number(item.id)" :label="`${item.purchase_order_no || '未关联采购单'} · 批次 #${item.id} · ${item.status === 'approved' ? '已收货' : '待收货'} ${item.quantity} 件`" />
  </el-select>
  <template v-if="batch">
    <p>采购单 {{ batch.purchase_order_no || '未关联' }} · 采购时间 {{ shanghaiDateTimeText(batch.purchased_at) }} · 本批次 {{ batch.quantity }} 件 · {{ batch.status === 'approved' ? '已收货' : '待收货' }}</p>
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
  </template>
</template>
