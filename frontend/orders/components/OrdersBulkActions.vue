<script setup>
const TEXT = {
  title: "\u6279\u91cf\u64cd\u4f5c",
  subtitle: "\u8fd9\u91cc\u4f1a\u6c89\u6dc0\u6210\u7edf\u4e00\u64cd\u4f5c\u533a\uff0c\u540e\u7eed\u5176\u4ed6\u9875\u9762\u53ef\u76f4\u63a5\u590d\u7528\u540c\u4e00\u5957\u5165\u53e3\u7ed3\u6784\u3002",
  bulkPrint: "\u6279\u91cf\u6253\u5370",
  bulkPrepare: "\u6279\u91cf\u5907\u8d27",
  more: "\u66f4\u591a\u64cd\u4f5c"
};

defineProps({
  moreActions: { type: Array, default: () => [] }
});

const emit = defineEmits(["bulk-print", "bulk-prepare", "more-action"]);

function onMoreChange(event) {
  const value = event.target.value;
  if (!value) return;
  emit("more-action", value);
  event.target.value = "";
}
</script>

<template>
  <section class="vue-orders-bulkbar">
    <div class="vue-orders-bulkbar-copy">
      <span>{{ TEXT.title }}</span>
      <small>{{ TEXT.subtitle }}</small>
    </div>
    <div class="vue-orders-bulkbar-actions">
      <button type="button" class="ds-btn ds-btn-secondary" @click="emit('bulk-print')">{{ TEXT.bulkPrint }}</button>
      <button type="button" class="ds-btn ds-btn-primary" @click="emit('bulk-prepare')">{{ TEXT.bulkPrepare }}</button>
      <select v-if="moreActions.length" class="ds-select vue-orders-more-select" @change="onMoreChange">
        <option value="">{{ TEXT.more }}</option>
        <option v-for="item in moreActions" :key="item.value" :value="item.value">{{ item.label }}</option>
      </select>
    </div>
  </section>
</template>
