<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../../stores/auth.js';
import { apiClient, currentApiCacheScope } from '../../utils/api.js';
import { productAliases, productAliasKey, loadProductAlias, storeProductAlias } from '../../utils/product-alias.js';
import { hasPermission } from '../../../../src/shared/permissions.js';
const props = defineProps({ productId: { type: Number, required: true }, column: Boolean });
const auth = useAuthStore(), visible = ref(false), saving = ref(false), draft = ref(''), expected = ref('');
const entry = computed(() => productAliases.get(productAliasKey(props.productId)));
const canEdit = computed(() => ['inventory.write', 'procurement', 'packing'].some(p => hasPermission(auth.user, p)));
const valid = computed(() => Number.isSafeInteger(props.productId) && props.productId > 0);
let generation = 0;
function reset() { generation++; visible.value = false; saving.value = false; }
function load() { reset(); if (valid.value) loadProductAlias(props.productId); }
watch(() => props.productId, load, { immediate: true });
window.addEventListener('erp:auth-scope-changed', load);
onBeforeUnmount(() => { reset(); window.removeEventListener('erp:auth-scope-changed', load); });
function edit() { expected.value = entry.value.value; draft.value = expected.value; visible.value = true; }
async function save() {
  if (saving.value) return;
  const scope = currentApiCacheScope(), id = props.productId, token = generation;
  saving.value = true;
  try {
    const result = await apiClient.post('/api/inventory-workflow/product-aliases', { product_id: id, product_alias: draft.value, expected_alias: expected.value });
    if (scope !== currentApiCacheScope() || token !== generation) return;
    storeProductAlias(id, result.product_alias); visible.value = false; ElMessage.success('商品别名已保存');
  } catch (error) {
    if (scope !== currentApiCacheScope() || token !== generation) return;
    ElMessage.error(error.message || '保存失败'); loadProductAlias(id);
  } finally { if (token === generation) saving.value = false; }
}
</script>
<template>
  <div v-if="valid" class="product-alias" @click.stop>
    <span v-if="!column">商品别名：</span><span class="product-alias-text">{{ entry?.error ? '读取失败' : entry ? entry.value || '无' : '加载中…' }}</span>
    <el-button v-if="entry?.error" link size="small" @click="loadProductAlias(productId)">重试</el-button>
    <el-button v-else-if="canEdit && entry" link size="small" @click="edit">编辑</el-button>
    <el-dialog v-if="visible" v-model="visible" title="编辑商品别名" width="min(480px,94vw)" append-to-body :close-on-click-modal="false" :before-close="done=>{if(!saving)done()}">
      <el-input v-model="draft" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="例如：国内星途揽月；留空表示无别名" :disabled="saving" />
      <template #footer><el-button :disabled="saving" @click="draft=''">清空</el-button><el-button :disabled="saving" @click="visible=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<style scoped>
.product-alias{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px;font-size:12px;color:var(--el-text-color-secondary);line-height:1.5;max-width:100%}.product-alias-text{white-space:pre-wrap;overflow-wrap:anywhere}.product-alias :deep(.el-button){font-size:12px;margin-left:0}
</style>
