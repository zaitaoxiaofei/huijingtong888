<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { inventoryLabelItems, validateInventoryLabels, renderInventoryLabel, generateInventoryLabels, printInventoryLabels, MAX_INVENTORY_LABELS } from '../../utils/inventory-labels.js';

const props = defineProps({ modelValue: Boolean, products: { type: Array, default: () => [] } });
const emit = defineEmits(['update:modelValue']);
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) });
const items = ref([]), busy = ref(false), result = ref(null), previewIndex = ref(0);
let generation = 0;
const total = computed(() => items.value.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0));
const validation = computed(() => { try { validateInventoryLabels(items.value); return ''; } catch (error) { return error.message; } });
const preview = computed(() => {
  const item = items.value[previewIndex.value];
  if (!item) return '';
  try { return renderInventoryLabel(item); } catch { return ''; }
});
function clearResult() {
  ++generation;
  if (result.value) URL.revokeObjectURL(result.value.url);
  result.value = null;
  busy.value = false;
}
watch(() => props.modelValue, value => {
  clearResult();
  if (value) { items.value = inventoryLabelItems(props.products); previewIndex.value = 0; }
});
watch(items, clearResult, { deep: true, flush: 'sync' });
async function generate() {
  if (validation.value) return;
  if (result.value) return result.value;
  clearResult();
  const token = generation;
  const snapshot = items.value.map(item => ({ ...item }));
  busy.value = true;
  try {
    const generated = await generateInventoryLabels(snapshot);
    if (token !== generation || !visible.value) return;
    result.value = { ...generated, url: URL.createObjectURL(new Blob([generated.bytes], { type: 'application/pdf' })) };
    return result.value;
  } catch (error) { if (token === generation) ElMessage.error(error.message || '标签生成失败，请重试'); }
  finally { if (token === generation) busy.value = false; }
}
async function download() {
  const pdf = await generate();
  if (!pdf) return;
  const link = document.createElement('a');
  link.href = pdf.url;
  link.download = '库存标签-70x30.pdf';
  link.click();
}
async function print() {
  if (validation.value) return;
  try {
    validateInventoryLabels(items.value);
    const previews = items.value.map(item => ({ src: renderInventoryLabel(item), quantity: item.quantity }));
    await printInventoryLabels(previews);
  }
  catch (error) { ElMessage.error(error.message || '打印失败，请下载 PDF 打印'); }
}
function closeForScopeChange() { visible.value = false; clearResult(); items.value = []; }
window.addEventListener('erp:auth-scope-changed', closeForScopeChange);
onBeforeUnmount(() => { clearResult(); window.removeEventListener('erp:auth-scope-changed', closeForScopeChange); });
// Also initialize when this lazy dialog is first mounted open.
if (props.modelValue) items.value = inventoryLabelItems(props.products);
</script>

<template>
  <el-dialog v-model="visible" title="打印库存标签" width="880px" class="inventory-label-dialog" destroy-on-close :close-on-click-modal="false">
    <div class="label-print-summary">70 × 30 mm <span>已选 {{ items.length }} 项库存 · 共 {{ total }} 张标签</span></div>
    <el-table :data="items" max-height="320" @row-click="row => previewIndex = items.indexOf(row)">
      <el-table-column prop="number" label="库存编号" width="140" />
      <el-table-column prop="name" label="商品名称" min-width="200" />
      <el-table-column prop="type" label="类型" width="72" />
      <el-table-column label="标签数量" width="164"><template #default="{ row }"><el-input-number v-model="row.quantity" :min="1" :max="MAX_INVENTORY_LABELS" :precision="0" :aria-label="`${row.number} 标签数量`" size="small" @click.stop /></template></el-table-column>
    </el-table>
    <el-alert v-if="validation" :title="validation" type="warning" :closable="false" />
    <div class="label-preview-area">
      <div class="label-preview-head"><span>标签预览</span><el-select v-if="items.length > 1" v-model="previewIndex" aria-label="预览库存" size="small"><el-option v-for="(item, index) in items" :key="item.id" :label="item.number" :value="index" /></el-select></div>
      <img v-if="preview" :src="preview" class="inventory-label-preview" :alt="`${items[previewIndex]?.number} 标签预览`" />
      <el-alert v-else title="标签内容不完整或过长，请先编辑库存编号和名称" type="warning" :closable="false" />
    </div>
    <p class="label-print-hint">数量默认取本地实物库存；零库存或数量未知时默认 1 张，可手动调整。在库存商品页面选择“库存编号精确”，点击搜索框后扫码并回车，即可查看对应库存和图片。每张标签独占一页，打印时选择 70 × 30 mm 标签纸、100% 实际大小，关闭页眉页脚。</p>
    <div v-if="result" class="label-print-ready" role="status">已生成 {{ result.total }} 张标签的 PDF。</div>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button :loading="busy" :disabled="!!validation" @click="download">下载 PDF</el-button>
      <el-button type="primary" :disabled="!!validation || busy" @click="print">打印</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.label-print-summary{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px;font-weight:600}.label-print-summary span{font-weight:400;color:var(--el-text-color-secondary)}
.label-preview-area{padding:16px 0}.label-preview-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.label-preview-head .el-select{width:160px}
.inventory-label-preview{display:block;width:min(100%,560px);aspect-ratio:7/3;margin:auto;border:1px solid var(--el-border-color);background:#fff}
.label-print-hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.6}.label-print-ready{color:var(--el-color-success);margin-top:12px}
</style>
