<script setup>
import { computed, watch, onBeforeUnmount } from 'vue';
import { productAliases, productAliasKey, loadProductAlias } from '../../admin/utils/product-alias.js';
import { orderAliasProducts } from '../utils/order-product-aliases.js';
const props = defineProps({ overview: { type: Object, default: () => ({}) }, includeParents: Boolean, showIdentity: Boolean });
const products = computed(() => orderAliasProducts(props.overview, { includeParents: props.includeParents }));
const entry = id => productAliases.get(productAliasKey(id));
function load() { for (const product of products.value) loadProductAlias(product.product_id); }
watch(() => products.value.map(product => product.product_id).join(','), load, { immediate: true });
window.addEventListener('erp:auth-scope-changed', load);
onBeforeUnmount(() => window.removeEventListener('erp:auth-scope-changed', load));
</script>
<template>
  <div v-if="products.length" class="order-product-aliases" aria-label="商品别名">
    <div v-for="product in products" :key="product.product_id" class="order-product-alias">
      <span v-if="showIdentity || products.length > 1" class="order-alias-identity">{{ product.inventory_number ? `${product.inventory_number} · ` : '' }}{{ product.product_name }}</span>
      <span>商品别名：{{ entry(product.product_id)?.error ? '读取失败' : entry(product.product_id) ? entry(product.product_id).value || '无' : '加载中…' }}</span>
      <el-button v-if="entry(product.product_id)?.error" link size="small" @click.stop="loadProductAlias(product.product_id)">重试</el-button>
    </div>
  </div>
</template>
<style scoped>
.order-product-aliases{display:grid;gap:6px;font-size:12px;color:var(--el-text-color-secondary);line-height:1.5;min-width:0}.order-product-alias{white-space:pre-wrap;overflow-wrap:anywhere}.order-alias-identity{display:block;color:var(--el-text-color-primary);font-weight:500}.order-product-alias :deep(.el-button){font-size:12px;margin-left:4px}
</style>
