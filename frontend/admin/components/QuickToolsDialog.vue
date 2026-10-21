<script setup>
import { computed, defineAsyncComponent } from "vue";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  tool: { type: String, default: "profit", validator: (value) => ["calculator", "profit", "pricing"].includes(value) }
});
const emit = defineEmits(["update:modelValue"]);
const tools = {
  calculator: defineAsyncComponent(() => import("./QuickCalculator.vue")),
  profit: defineAsyncComponent(() => import("../views/tools/ProfitCalculatorView.vue")),
  pricing: defineAsyncComponent(() => import("../views/tools/PricingToolView.vue"))
};
const title = computed(() => ({ calculator: "简易计算器", profit: "利润计算器", pricing: "定价工具" }[props.tool]));
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    class="quick-tools-dialog"
    :class="{ 'quick-tools-dialog--calculator': tool === 'calculator' }"
    :width="tool === 'calculator' ? 'min(420px, 93vw)' : 'min(1320px, 93vw)'"
    top="4vh"
    append-to-body
    :close-on-click-modal="false"
    :close-on-press-escape="true"
    :show-close="true"
    :destroy-on-close="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="quick-tools-dialog__content">
      <KeepAlive :max="3">
        <component v-if="modelValue" :is="tools[tool]" :key="tool" embedded />
      </KeepAlive>
    </div>
  </el-dialog>
</template>

<style scoped>
:global(.el-overlay .quick-tools-dialog.el-dialog) {
  display: flex;
  flex-direction: column;
  width: var(--el-dialog-width, min(1320px, 93vw)) !important;
  max-width: 93vw !important;
  max-height: 92vh;
  margin: 4vh auto 0 !important;
  overflow: hidden;
}

:global(.quick-tools-dialog .el-dialog__header) {
  flex: none;
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--erp-border-light, #eef1f6);
}

:global(.quick-tools-dialog .el-dialog__body) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.quick-tools-dialog__content {
  min-width: 0;
  padding-right: 4px;
  color: var(--erp-text-main, #1f2937);
}

@media (max-width: 640px) {
  :global(.quick-tools-dialog.el-dialog) { padding: 14px; }
  .quick-tools-dialog__content { padding-right: 0; }
}
</style>
