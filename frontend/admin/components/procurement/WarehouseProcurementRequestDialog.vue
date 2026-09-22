<script setup>
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import ProductImagePreview from "../ProductImagePreview.vue";

const props = defineProps({ modelValue: Boolean, products: { type: Array, default: () => [] } });
const emit = defineEmits(["update:modelValue", "submitted"]);
const submitting = ref(false);
const reasonOptions = [
  { value: "accessory_shortage", label: "配件不足" },
  { value: "hot_product_replenishment", label: "热门产品备货不足" },
  { value: "shipping_shortage", label: "订单发货缺货" },
  { value: "safety_stock_shortage", label: "安全库存不足" },
  { value: "seasonal_replenishment", label: "季节性备货" },
  { value: "other", label: "其他" }
];
const items = ref([]);
const validItems = computed(() => items.value.filter((item) => Number(item.quantity) > 0));

function reset() {
  items.value = props.products.map((product) => ({
    product_id: Number(product.id), product_name: product.name || product.product_name || "-",
    product_code: product.inventory_number || product.inventory_id || product.code || "-",
    image_url: product.image_url || product.product_image_url || "",
    quantity: 1, reason_code: "", reason_note: ""
  }));
}

async function submit() {
  if (!validItems.value.length) return ElMessage.warning("请至少填写一项建议采购数量");
  if (validItems.value.some((item) => !item.reason_code)) return ElMessage.warning("请为每个商品选择申请原因");
  if (validItems.value.some((item) => item.reason_code === "other" && !String(item.reason_note || "").trim())) return ElMessage.warning("选择其他原因时，请填写具体原因");
  submitting.value = true;
  try {
    await apiClient.post("/api/procurement/warehouse-requests", {
      items: validItems.value.map(({ product_id, quantity, reason_code, reason_note }) => ({ product_id, quantity: Number(quantity), reason_code, reason_note: String(reason_note || "").trim() }))
    });
    ElMessage.success(`已提交 ${validItems.value.length} 条库存采购申请`);
    emit("submitted");
    emit("update:modelValue", false);
  } catch (error) {
    ElMessage.error(error.message || "提交采购需求失败");
  } finally {
    submitting.value = false;
  }
}

watch(() => props.modelValue, (visible) => { if (visible) reset(); });
</script>

<template>
  <el-dialog :model-value="modelValue" title="提交采购需求" width="1080px" align-center destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="提交后会进入采购工作台的“库存采购申请”。这里仅为采购建议，不会生成采购在途或采购金额。" type="info" :closable="false" show-icon />
    <el-table :data="items" border class="warehouse-request-table">
      <el-table-column label="库存商品" min-width="360">
        <template #default="{ row }"><div class="warehouse-product"><ProductImagePreview :src="row.image_url" size="portrait" fit="cover" /><div><strong>{{ row.product_name }}</strong><span>{{ row.product_code }}</span></div></div></template>
      </el-table-column>
      <el-table-column label="建议采购数量" width="170">
        <template #default="{ row }"><el-input-number v-model="row.quantity" :min="1" :precision="0" controls-position="right" /></template>
      </el-table-column>
      <el-table-column label="申请原因" width="210">
        <template #default="{ row }"><el-select v-model="row.reason_code" placeholder="请选择"><el-option v-for="option in reasonOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></template>
      </el-table-column>
      <el-table-column label="补充说明" min-width="240">
        <template #default="{ row }"><el-input v-model="row.reason_note" :placeholder="row.reason_code === 'other' ? '请填写具体原因' : '可选'" /></template>
      </el-table-column>
    </el-table>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">提交采购需求（{{ validItems.length }}）</el-button></template>
  </el-dialog>
</template>

<style scoped>
.warehouse-request-table { margin-top: 16px; }
.warehouse-product { display: flex; align-items: center; gap: 12px; }
.warehouse-product div { display: grid; gap: 5px; }
.warehouse-product span { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
