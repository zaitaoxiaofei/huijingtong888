<script setup>
import {reactive,ref} from 'vue';
import {inventorySearchDefaults} from '../../../../src/shared/inventory-search-fields.js';
import InventoryStructuredSearch from '../inventory/InventoryStructuredSearch.vue';
import MobileDialog from './MobileDialog.vue';
const props=defineProps({filters:{type:Object,required:true},loading:Boolean});
const emit=defineEmits(['search','reset']);
const expanded=ref(false),draft=reactive({});
function openFields(){Object.assign(draft,JSON.parse(JSON.stringify(props.filters)));expanded.value=true;}
function clearFields(){Object.assign(draft,inventorySearchDefaults(),{query:'',searchMode:'inventory_id',inventoryType:'all'});}
function applyFields(){Object.assign(props.filters,JSON.parse(JSON.stringify(draft)),{query:''});expanded.value=false;emit('search');}
</script>
<template>
 <section class="mobile-inventory-filter" aria-label="库存搜索">
  <div class="mobile-inventory-filter-main">
   <select v-model="filters.searchMode" aria-label="搜索方式"><option value="inventory_id">库存ID</option><option value="inventory_prefix">编号前缀</option><option value="auto">模糊搜索</option><option value="sku">SKU / 货号</option><option value="name">产品名称</option></select>
   <el-input v-model="filters.query" clearable aria-label="搜索内容" :placeholder="filters.searchMode==='inventory_id'?'输入完整新号 1-3-1 或旧编号':filters.searchMode==='inventory_prefix'?'品名与品牌 1-3，或编号前缀 1-3-1':filters.searchMode==='sku'?'输入完整SKU或货号':'输入库存ID或商品名'" @keyup.enter="emit('search')"/>
  </div>
  <slot name="filters"/>
  <div class="mobile-inventory-filter-actions">
   <el-button type="primary" :loading="loading" @click="emit('search')">查询</el-button>
   <el-button @click="openFields">精确搜索</el-button>
   <el-button :disabled="loading" @click="emit('reset')">重置</el-button>
   <slot name="actions"/>
  </div>
 </section>
 <MobileDialog v-model="expanded" title="精确搜索" class="mobile-inventory-search-dialog">
  <el-form label-position="top" class="mobile-structured-filter">
   <el-form-item label="库存类型"><el-select v-model="draft.inventoryType" aria-label="库存类型"><el-option label="全部" value="all"/><el-option label="单品" value="single"/><el-option label="配件" value="accessory"/><el-option label="套装" value="combo"/></el-select></el-form-item>
   <InventoryStructuredSearch :model-value="draft" @update:model-value="Object.assign(draft,$event)" compact simple/>
  </el-form>
  <template #footer><el-button @click="clearFields">清空条件</el-button><el-button @click="expanded=false">取消</el-button><el-button type="primary" @click="applyFields">应用搜索</el-button></template>
 </MobileDialog>
</template>
<style scoped>
.mobile-inventory-filter{min-width:0;display:grid;gap:8px}
.mobile-inventory-filter-main{display:grid;grid-template-columns:108px minmax(0,1fr);gap:8px;min-width:0}
.mobile-inventory-filter-main>select{width:100%;min-width:0;min-height:40px;padding:5px 6px;background:var(--el-bg-color);color:var(--el-text-color-primary);border:1px solid var(--el-border-color);border-radius:7px}
.mobile-inventory-filter-main :deep(.el-input){min-width:0;width:100%}.mobile-inventory-filter-main :deep(.el-input__wrapper){min-height:40px;box-sizing:border-box}
.mobile-inventory-filter-actions{display:flex;align-items:center;gap:5px;min-width:0}
.mobile-inventory-filter-actions :deep(.el-button){margin:0;min-width:0;flex:1;min-height:40px!important;padding:8px 5px!important;font-size:13px;white-space:nowrap!important}
.mobile-structured-filter{display:grid;gap:12px;min-width:0}
.mobile-structured-filter :deep(.inventory-structured-search),.mobile-structured-filter :deep(.search-group){display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:12px!important;min-width:0!important}
.mobile-structured-filter :deep(.search-group){grid-column:1/-1}.mobile-structured-filter :deep(.el-form-item){min-width:0;margin:0}.mobile-structured-filter :deep(.el-form-item__content){min-width:0}.mobile-structured-filter :deep(.el-select){width:100%}
</style>
