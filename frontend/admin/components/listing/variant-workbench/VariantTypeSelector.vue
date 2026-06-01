<script setup>
import { Check } from "@element-plus/icons-vue";

defineProps({
  modelValue: { type: String, default: "" },
  types: { type: Array, default: () => [] }
});

defineEmits(["update:model-value"]);
</script>

<template>
  <section class="work-card">
    <div class="section-head">
      <span>01</span>
      <strong>裂变类型</strong>
    </div>
    <div class="type-grid">
      <button
        v-for="item in types"
        :key="item.value"
        type="button"
        class="type-card"
        :class="{ active: modelValue === item.value }"
        @click="$emit('update:model-value', item.value)"
      >
        <span>
          <strong>{{ item.shortTitle || item.title }}</strong>
          <el-icon v-if="modelValue === item.value"><Check /></el-icon>
        </span>
        <em>{{ item.title }}</em>
        <p>{{ item.description }}</p>
      </button>
    </div>
  </section>
</template>

<style scoped>
.work-card {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.06);
  padding: 14px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.section-head span {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: #0f172a;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}

.section-head strong {
  color: #0f172a;
}

.type-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.type-card {
  min-height: 142px;
  display: grid;
  gap: 8px;
  align-content: start;
  padding: 12px;
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  background: #f8fbff;
  text-align: left;
  cursor: pointer;
}

.type-card.active {
  border-color: #2563eb;
  background: #eef6ff;
  box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.18);
}

.type-card > span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.type-card strong {
  color: #0f172a;
  font-size: 15px;
}

.type-card em {
  color: #2563eb;
  font-size: 12px;
  font-style: normal;
}

.type-card p {
  margin: 0;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .type-grid {
    grid-template-columns: 1fr;
  }
}
</style>
