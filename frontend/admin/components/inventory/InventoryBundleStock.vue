<script setup>
defineProps({value:Object});
</script>
<template>
 <div class="bundle-stock-summary" aria-label="套装成品与散件库存">
  <span class="bundle-stock-line"><span>已打包成品</span><strong>{{value?.finished_stock??'待核对'}} 套</strong></span>
  <span class="bundle-stock-line"><span>散件还能组成</span><strong>{{value?.assemblable_stock??'待核对'}} 套</strong></span>
  <div v-if="value?.loose_components?.length" class="bundle-loose-components"><span v-for="part in value.loose_components" :key="part.product_id" class="bundle-loose-row"><span :title="`${part.name} · ${part.inventory_number||part.product_id}`">{{part.name}}</span><b>{{part.physical_stock??'待核对'}} {{part.stock_unit||'件'}}</b></span></div>
  <span class="bundle-stock-line" title="未占用成品加上可用散件最多可组成的套数。散件可能被其他套装共用，不可跨套装相加。"><span>总可供</span><strong>{{value?.maximum_available??'待核对'}} 套</strong></span>
 </div>
</template>
<style scoped>
.bundle-stock-summary{display:grid;gap:6px;width:100%;font-size:12px;line-height:1.6;text-align:left}.bundle-stock-line,.bundle-loose-row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.bundle-stock-line strong,.bundle-loose-row b{flex-shrink:0;font-variant-numeric:tabular-nums}.bundle-loose-components{display:grid;gap:3px;color:var(--el-text-color-secondary)}.bundle-loose-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bundle-loose-row b{font-weight:400}
</style>
