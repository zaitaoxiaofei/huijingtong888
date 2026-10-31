<script setup>
defineProps({bundles:{type:Array,default:()=>[]}});
defineEmits(['open']);
</script>
<template>
 <div class="affected-bundles">
  <template v-for="bundle in bundles.slice(0,2)" :key="bundle.id"><el-button link type="primary" :title="bundle.name" @click="$emit('open',bundle.id)"><span>{{bundle.inventory_number||bundle.id}} · {{bundle.name}}</span></el-button><small>{{bundle.has_open_demand?'含待发需求':'关联套装'}} · 每套用 {{bundle.per_set_quantity}} 件</small></template>
  <el-popover v-if="bundles.length>2" trigger="click" :width="360"><template #reference><el-button link type="primary">另 {{bundles.length-2}} 个套装</el-button></template><div class="affected-all"><el-button v-for="bundle in bundles" :key="bundle.id" link type="primary" @click="$emit('open',bundle.id)">{{bundle.inventory_number||bundle.id}} · {{bundle.name}}（每套 {{bundle.per_set_quantity}} 件）</el-button></div></el-popover>
  <small v-if="!bundles.length">独立库存 / 暂无关联套装</small>
 </div>
</template>
<style scoped>
.affected-bundles{display:grid;gap:3px;justify-items:start;min-width:0}.affected-bundles>.el-button{max-width:100%;margin:0;padding:1px 0;justify-content:flex-start;font-size:12px}.affected-bundles>.el-button :deep(span){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.affected-bundles small{font-size:11px;color:var(--el-text-color-secondary)}.affected-all{display:grid;gap:8px;max-height:350px;overflow:auto}.affected-all .el-button{margin:0;justify-content:flex-start;white-space:normal;text-align:left;height:auto}
</style>
