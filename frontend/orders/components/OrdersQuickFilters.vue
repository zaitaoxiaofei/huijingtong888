<script setup>
import { ref } from "vue";

const props = defineProps({ filters: { type: Object, default: () => ({}) } });
const emit = defineEmits(["apply"]);
const opened = ref("");
const draftDays = ref(3);
const choices = [
  { key: "nearShipmentDeadline", daysKey: "nearShipmentDeadlineDays", label: "即将超时", comparison: "剩余 <", days: [0, 1, 2, 3, 4, 5] },
  { key: "procurementTransitOverdue", daysKey: "procurementTransitOverdueDays", label: "采购在途超时", comparison: "超过", days: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
];

function changeVisibility(choice, visible) {
  if (!visible) {
    if (opened.value === choice.key) opened.value = "";
    return;
  }
  const currentDays = props.filters[choice.key] ? Number(props.filters[choice.daysKey] ?? 3) : 3;
  draftDays.value = choice.days.includes(currentDays) ? currentDays : 3;
  opened.value = choice.key;
}

function apply(choice) {
  emit("apply", { [choice.key]: true, [choice.daysKey]: draftDays.value, page: 1 });
  opened.value = "";
}

function clear(choice) {
  emit("apply", { [choice.key]: false, page: 1 });
  opened.value = "";
}
</script>

<template>
  <div class="orders-quick-filter-tags" aria-label="订单快速筛选">
    <el-popover
      v-for="choice in choices"
      :key="choice.key"
      trigger="click"
      placement="bottom-start"
      :width="280"
      :title="choice.label"
      :visible="opened === choice.key"
      popper-class="orders-quick-filter-popover"
      @update:visible="changeVisibility(choice, $event)"
    >
      <template #reference>
        <button type="button" class="orders-chip-button orders-quick-filter-tag" :class="{ 'is-active': filters[choice.key] }" :aria-expanded="opened === choice.key">
          {{ choice.label }}<span v-if="filters[choice.key]"> · {{ choice.comparison }} {{ filters[choice.daysKey] ?? 3 }} 天</span>
        </button>
      </template>
      <div class="orders-quick-filter-editor" @keydown.esc.stop="changeVisibility(choice, false)">
        <span>{{ choice.comparison }}</span>
        <el-select v-model="draftDays" class="orders-quick-filter-days" :aria-label="`${choice.label}天数`" :teleported="false">
          <el-option v-for="day in choice.days" :key="day" :label="choice.key === 'procurementTransitOverdue' && day === 10 ? '10 天及以上' : `${day} 天`" :value="day" />
        </el-select>
      </div>
      <div class="orders-quick-filter-actions">
        <el-button v-if="filters[choice.key]" link type="primary" @click="clear(choice)">取消筛选</el-button>
        <el-button size="small" @click="changeVisibility(choice, false)">取消</el-button>
        <el-button size="small" type="primary" @click="apply(choice)">确认筛选</el-button>
      </div>
    </el-popover>
  </div>
</template>
