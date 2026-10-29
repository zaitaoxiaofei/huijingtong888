<script setup>
import { ref } from 'vue';
import { shanghaiDateTimeText } from '../../admin/utils/shanghai-date.js';
defineProps({ parents: { type: Array, default: () => [] }, active: Boolean });
const expanded = ref(new Set());
function toggle(id) {
  const next = new Set(expanded.value);
  next.has(id) ? next.delete(id) : next.add(id);
  expanded.value = next;
}
</script>
<template>
  <div class="inventory-identities">
    <section v-for="parent in parents" :key="parent.id" class="inventory-identity">
      <div class="inventory-identity-header">
        <strong class="inventory-parent-number" :title="`${parent.virtual ? '虚拟库存' : '库存'} ID：${parent.inventoryNumber || '待核对'}`">{{ parent.virtual ? '虚拟库存' : '库存' }} ID：{{ parent.inventoryNumber || '待核对' }}</strong>
        <span class="inventory-parent-quantity">本单 {{ parent.quantity ?? '待核' }} {{ parent.virtual ? '套' : '件' }}</span>
      </div>
      <strong class="inventory-parent-name" :title="parent.name">{{ parent.name || '库存名称待核对' }}</strong>
      <div class="inventory-local-counts" :class="{ 'has-multiple-fbp': parent.fbpStocks.length > 1 }">
        <span title="扣除全部待发本地订单需求及 FBP 占用后的可用数量">可用：<b>{{ parent.localAvailable ?? '待核对' }}</b></span>
        <span title="包含已分拣、已打包但尚未发出的货；以仓库盘点为准">实物：<b>{{ parent.localPhysical ?? '待核对' }}</b></span>
        <span v-for="stock in parent.fbpStocks" :key="stock.ozon_sku" class="inventory-stock-comparison" :title="`SKU ${stock.ozon_sku}；${stock.synced_at ? `Ozon 同步：${shanghaiDateTimeText(stock.synced_at, { assumeUtcWhenNaive: true })}；不同 SKU 库存独立` : '尚无此店铺 SKU 的 FBP 同步记录，不等于零库存'}`">
          FBP<template v-if="parent.fbpStocks.length > 1">（{{ stock.ozon_sku }}）</template>：<b>{{ stock.present ?? '待同步' }}</b>
        </span>
        <span v-if="!parent.fbpStocks.length" title="尚无此店铺 SKU 的 FBP 同步记录，不等于零库存">FBP：<b>待同步</b></span>
      </div>
      <div v-if="parent.virtual" class="inventory-children">
        <div v-for="child in (expanded.has(parent.id) ? parent.children : parent.children.slice(0, 2))" :key="child.product_id" class="inventory-child" :title="`${child.inventory_number || 'ID 待核对'} ${child.product_name || '库存名称待核对'}；本单实际消耗 ${child.quantity ?? '待核'}；${parent.quantity > 0 ? `每套 ${child.quantity / parent.quantity} × 本单 ${parent.quantity} 套` : '套数待核对'}`">
          <span class="inventory-child-label" :title="`${child.inventory_number || 'ID 待核对'} ${child.product_name || '库存名称待核对'}`">{{ child.inventory_number || 'ID 待核对' }} {{ child.product_name || '库存名称待核对' }}</span>
          <b class="inventory-child-quantity">× {{ child.quantity ?? '待核' }} {{ child.stock_unit || '件' }}</b>
          <small v-if="active && child.review">本单数量待核</small>
          <small v-else-if="active && child.shortage > 0" class="inventory-child-shortage">本单该子库存共缺 {{ child.shortage }} {{ child.stock_unit || '件' }}</small>
        </div>
        <small v-if="!parent.children.length">子产品组成待核对，请查看库存明细</small>
        <el-button v-if="parent.children.length > 2" link type="primary" size="small" @click="toggle(parent.id)">{{ expanded.has(parent.id) ? '收起子产品' : `展开其余 ${parent.children.length - 2} 项` }}</el-button>
      </div>
      <slot name="actions" :parent="parent" />
    </section>
  </div>
</template>
<style scoped>
.inventory-identities,.inventory-identity { display:flex;flex-direction:column;gap:4px;width:100%;min-width:0;font-size:inherit; }
.inventory-identity + .inventory-identity { border-top:1px solid var(--erp-border-light, #ebeef5);padding-top:8px; }
.inventory-identity-header { display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0;line-height:1.5; }
.inventory-parent-number,.inventory-parent-name { font-size:inherit;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.5; }
.inventory-parent-number { min-width:0; }
.inventory-parent-quantity { flex-shrink:0;font-size:inherit;font-weight:600;white-space:nowrap; }
.inventory-identity small { color:var(--erp-text-secondary, #606266);line-height:1.5; }
.inventory-children { border-left:2px solid var(--erp-border, #dce6f4);padding-left:8px;display:grid;gap:5px;min-width:0; }
.inventory-child { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;font-size:12px;line-height:1.5;min-width:0; }
.inventory-child-label { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0; }
.inventory-child-quantity { white-space:nowrap;text-align:right; }
.inventory-child small { grid-column:1 / -1; }
.inventory-child .inventory-child-shortage { color:var(--erp-danger-text); }
.inventory-local-counts { display:flex;gap:4px 10px;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums; }
.inventory-local-counts > span { white-space:nowrap; }
.inventory-local-counts.has-multiple-fbp { flex-wrap:wrap; }
.inventory-local-counts span:first-child { color:var(--erp-success-text, #0b6b56); }
</style>
