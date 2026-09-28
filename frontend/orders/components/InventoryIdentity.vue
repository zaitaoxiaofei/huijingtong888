<script setup>
import { ref } from 'vue';
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
      <strong class="inventory-parent-name" :title="parent.name">{{ parent.name || '库存名称待核对' }}</strong>
      <small>{{ parent.virtual ? '虚拟库存' : '库存' }} ID：{{ parent.inventoryNumber || '待核对' }} · 本单 {{ parent.quantity ?? '待核' }} {{ parent.virtual ? '套' : '件' }}</small>
      <div v-if="parent.virtual" class="inventory-children">
        <div v-for="child in (expanded.has(parent.id) ? parent.children : parent.children.slice(0, 2))" :key="child.product_id" class="inventory-child" :title="`本单实际消耗 ${child.quantity ?? '待核'}；${parent.quantity > 0 ? `每套 ${child.quantity / parent.quantity} × 本单 ${parent.quantity} 套` : '套数待核对'}`">
          <span>子库存 {{ child.inventory_number || 'ID 待核对' }} · {{ child.product_name }}</span>
          <b>× {{ child.quantity ?? '待核' }} {{ child.stock_unit || '件' }}</b>
          <small v-if="active && child.review">本单数量待核</small>
          <small v-else-if="active && child.shortage > 0" class="inventory-child-shortage">本单该子库存共缺 {{ child.shortage }} {{ child.stock_unit || '件' }}</small>
        </div>
        <small v-if="!parent.children.length">子产品组成待核对，请查看库存明细</small>
        <el-button v-if="parent.children.length > 2" link type="primary" size="small" @click="toggle(parent.id)">{{ expanded.has(parent.id) ? '收起子产品' : `展开其余 ${parent.children.length - 2} 项` }}</el-button>
      </div>
    </section>
  </div>
</template>
<style scoped>
.inventory-identities,.inventory-identity { display:flex;flex-direction:column;gap:6px;width:100%; }
.inventory-identity + .inventory-identity { border-top:1px solid #ebeef5;padding-top:8px; }
.inventory-parent-name { display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5; }
.inventory-identity small { color:#606266;line-height:1.5; }
.inventory-children { border-left:2px solid #dce6f4;padding-left:8px;display:grid;gap:5px; }
.inventory-child { display:flex;flex-wrap:wrap;gap:3px 6px;font-size:12px;line-height:1.5; }
.inventory-child > span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%; }
.inventory-child small { width:100%; }
.inventory-child .inventory-child-shortage { color:var(--el-color-danger); }
</style>
