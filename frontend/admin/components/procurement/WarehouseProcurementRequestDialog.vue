<script setup>
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { INVENTORY_DEMAND_TYPES } from "../../../../src/shared/inventory-workflow.js";
import { apiClient } from "../../utils/api.js";
import ProductImagePreview from "../ProductImagePreview.vue";

const props = defineProps({ modelValue: Boolean, products: { type: Array, default: () => [] } });
const emit = defineEmits(["update:modelValue", "submitted"]);
const submitting = ref(false);
const reasonOptions = INVENTORY_DEMAND_TYPES.map(t=>({value:t.key,label:t.label}));
const items = ref([]);
const validItems = computed(() => items.value.filter((item) => Number(item.quantity) > 0));

function reset() {
  items.value = props.products.map((product) => ({
    product_id: Number(product.id), product_name: product.name || product.product_name || "-",
    product_code: product.inventory_number || product.inventory_id || product.code || "-",
    image_url: product.image_url || product.product_image_url || "",
    quantity: Math.max(1, Math.floor(Number(product.suggested_purchase_qty || 1))), reason_code: "", reason_note: "", request_key:crypto.randomUUID(), done:false
  }));
}

async function submit() {
  if (!validItems.value.length) return ElMessage.warning("请至少填写一项建议采购数量");
  if (validItems.value.some((item) => !item.reason_code)) return ElMessage.warning("请为每个商品选择申请原因");
  submitting.value = true;
  const pending=validItems.value.filter(item=>!item.done);
  try {
    for(const item of pending){
      await apiClient.post("/api/inventory-workflow/requests", {product_id:item.product_id,quantity:Number(item.quantity),demand_type:item.reason_code,note:String(item.reason_note||"").trim(),request_key:item.request_key});
      item.done=true;
    }
    ElMessage.success(`已提交 ${validItems.value.length} 条采购申请，并通知本企业管理员和采购`);
    emit("submitted");emit("update:modelValue", false);
  } catch(error){
    const done=validItems.value.filter(item=>item.done).length;
    ElMessage.error(`${done?`已有 ${done} 条提交成功；`:""}${error.message||"提交失败"}。可重试剩余项目，已提交项目不会重复。`);
    if(done)emit("submitted");
  }finally{submitting.value=false;}
}

watch(() => props.modelValue, (visible) => { if (visible) reset(); });
</script>

<template>
  <el-dialog :model-value="modelValue" title="提交采购需求" width="1080px" align-center destroy-on-close :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="用途按真实FBS订单、本地安全保障、FBP备货区分。FBP须先提交备货申请；采购申请不增加在途和实物。" type="info" :closable="false" show-icon />
    <el-table :data="items" border class="warehouse-request-table">
      <el-table-column label="库存商品" min-width="360">
        <template #default="{ row }"><div class="warehouse-product"><ProductImagePreview :src="row.image_url" size="portrait" fit="cover" /><div><strong>{{ row.product_name }}</strong><span>{{ row.product_code }}</span></div></div></template>
      </el-table-column>
      <el-table-column label="建议采购数量" width="170">
        <template #default="{ row }"><el-input-number v-model="row.quantity" :min="1" :max="1000000" :precision="0" :disabled="submitting||row.done" controls-position="right" /></template>
      </el-table-column>
      <el-table-column label="需求类型" width="210">
        <template #default="{ row }"><el-select v-model="row.reason_code" :disabled="submitting||row.done" placeholder="请选择"><el-option v-for="option in reasonOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></template>
      </el-table-column>
      <el-table-column label="补充说明" min-width="240">
        <template #default="{ row }"><el-input v-model="row.reason_note" maxlength="500" :disabled="submitting||row.done" :placeholder="row.done?'已提交':'可选'" /></template>
      </el-table-column>
    </el-table>
    <template #footer><el-button :disabled="submitting" @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">提交采购需求（{{ validItems.length }}）</el-button></template>
  </el-dialog>
</template>

<style scoped>
.warehouse-request-table { margin-top: 16px; }
.warehouse-product { display: flex; align-items: center; gap: 12px; }
.warehouse-product div { display: grid; gap: 5px; }
.warehouse-product span { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
