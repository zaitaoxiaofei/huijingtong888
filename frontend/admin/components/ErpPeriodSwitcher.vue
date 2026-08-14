<script setup>
defineProps({
  period: { type: String, required: true },
  caption: { type: String, default: "当前账期" },
  status: { type: String, default: "" },
  currentEnabled: { type: Boolean, default: false },
  nextDisabled: { type: Boolean, default: false }
});
defineEmits(["previous", "next", "current"]);
</script>

<template>
  <div class="erp-period-switcher">
    <el-button class="erp-period-switcher__arrow" text aria-label="上一个周期" @click="$emit('previous')">‹</el-button>
    <button type="button" class="erp-period-switcher__current" :disabled="!currentEnabled" @click="$emit('current')">
      <small>{{ caption }}</small>
      <strong>{{ period }}</strong>
      <span v-if="status">{{ status }}</span>
    </button>
    <el-button class="erp-period-switcher__arrow" text aria-label="下一个周期" :disabled="nextDisabled" @click="$emit('next')">›</el-button>
  </div>
</template>

<style scoped>
.erp-period-switcher {
  display: inline-flex;
  align-items: center;
  min-width: 180px;
  height: 38px;
  overflow: hidden;
  border: 1px solid #cbd5e1;
  border-radius: var(--erp-radius, 8px);
  background: #fff;
  white-space: nowrap;
}
.erp-period-switcher__arrow { width: 38px; height: 38px; margin: 0; border: 0; border-radius: 0; color: #475569; font-size: 22px; }
.erp-period-switcher__current {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 112px;
  height: 38px;
  padding: 0 10px;
  border: 0;
  border-right: 1px solid #e2e8f0;
  border-left: 1px solid #e2e8f0;
  color: #1f2937;
  background: #fff;
}
.erp-period-switcher__current:not(:disabled) { cursor: pointer; }
.erp-period-switcher__current small { color: #94a3b8; font-size: 10px; }
.erp-period-switcher__current strong { color: var(--erp-primary, #6258f6); font-size: 13px; }
.erp-period-switcher__current span { padding: 2px 6px; border-radius: 999px; color: #1d4ed8; background: #dbeafe; font-size: 10px; font-weight: 700; }
</style>
