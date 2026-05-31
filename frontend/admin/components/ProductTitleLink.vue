<script setup>
import { computed } from "vue";
import { openExternalProductLink } from "../utils/product-links";

const props = defineProps({
  title: {
    type: [String, Number],
    default: ""
  },
  href: {
    type: String,
    default: ""
  },
  lines: {
    type: [String, Number],
    default: 2
  },
  fallback: {
    type: String,
    default: "-"
  },
  tooltipPlacement: {
    type: String,
    default: "top"
  }
});

const displayTitle = computed(() => {
  const value = String(props.title || "").trim();
  return value || props.fallback;
});

const linkHref = computed(() => String(props.href || "").trim());
const lineClamp = computed(() => Math.max(1, Math.min(4, Number(props.lines || 2))));
const titleStyle = computed(() => ({ "--erp-product-title-lines": lineClamp.value }));

function handleClick(event) {
  if (!linkHref.value) return;
  event.preventDefault();
  event.stopPropagation();
  openExternalProductLink(linkHref.value);
}
</script>

<template>
  <el-tooltip
    :content="displayTitle"
    :placement="tooltipPlacement"
    effect="dark"
    :show-after="260"
    :hide-after="0"
    :popper-style="{ maxWidth: '520px', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: '1.45' }"
  >
    <a
      v-if="linkHref"
      class="erp-product-title-link is-clickable"
      :href="linkHref"
      target="_blank"
      rel="noopener noreferrer"
      :style="titleStyle"
      @click="handleClick"
    >
      {{ displayTitle }}
    </a>
    <span v-else class="erp-product-title-link" :style="titleStyle">
      {{ displayTitle }}
    </span>
  </el-tooltip>
</template>
