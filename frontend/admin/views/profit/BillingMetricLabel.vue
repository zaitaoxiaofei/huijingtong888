<script setup>
import { computed } from "vue";
import { billingMetrics } from "./billing-metrics.js";
const props = defineProps({ metric: { type: String, default: "" }, label: { type: String, default: "" }, hint: { type: String, default: "" } });
const text = computed(() => props.label || billingMetrics[props.metric]?.label || props.metric);
const explanation = computed(() => props.hint || billingMetrics[props.metric]?.hint || "");
</script>

<template>
  <el-tooltip :content="explanation" :disabled="!explanation" :show-after="180" placement="top" :popper-style="{ maxWidth: '280px', lineHeight: '1.6' }">
    <span class="billing-metric-label" tabindex="0">{{ text }}<span v-if="explanation" class="billing-metric-label__help" aria-hidden="true">ⓘ</span></span>
  </el-tooltip>
</template>

<style scoped>
.billing-metric-label { cursor: help; outline-offset: 3px; }
.billing-metric-label__help { display: inline !important; margin-left: 4px; font-size: 11px; font-weight: 400; opacity: .65; }
</style>
