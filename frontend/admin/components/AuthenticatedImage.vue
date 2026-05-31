<script setup>
import { onBeforeUnmount, ref, watch } from "vue";
import { apiClient } from "../utils/api";

defineOptions({
  inheritAttrs: false
});

const props = defineProps({
  src: { type: String, default: "" },
  alt: { type: String, default: "" }
});

const resolvedSrc = ref("");
let objectUrl = "";

function revokeObjectUrl() {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrl = "";
}

async function loadImage() {
  revokeObjectUrl();
  const source = String(props.src || "").trim();
  if (!source) {
    resolvedSrc.value = "";
    return;
  }
  if (/^(https?:|blob:|data:)/i.test(source)) {
    resolvedSrc.value = source;
    return;
  }
  try {
    const blob = await apiClient.blob(source, { routeScoped: false });
    objectUrl = URL.createObjectURL(blob);
    resolvedSrc.value = objectUrl;
  } catch {
    resolvedSrc.value = source;
  }
}

watch(
  () => props.src,
  () => {
    void loadImage();
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  revokeObjectUrl();
});
</script>

<template>
  <img v-if="resolvedSrc" v-bind="$attrs" :src="resolvedSrc" :alt="alt" />
</template>
