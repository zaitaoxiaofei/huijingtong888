<script setup>
import { computed } from "vue";

const props = defineProps({
  src: { type: String, default: "" },
  previewList: { type: Array, default: null },
  alt: { type: String, default: "商品图" },
  fit: { type: String, default: "contain" },
  size: { type: String, default: "default" },
  preview: { type: Boolean, default: true },
  lazy: { type: Boolean, default: false }
});

function normalizeImageSrc(src) {
  const value = String(src || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return `/api/image-proxy?url=${encodeURIComponent(value)}`;
  if (/^(data:image\/|\/api\/|\/uploads\/)/i.test(value)) return value;
  return "";
}

const displaySrc = computed(() => normalizeImageSrc(props.src));
const previewSrcList = computed(() => {
  const list = Array.isArray(props.previewList) && props.previewList.length ? props.previewList : [props.src];
  return list.map(normalizeImageSrc).filter(Boolean);
});
</script>

<template>
  <div class="erp-image-preview" :class="`erp-image-preview--${props.size}`">
    <el-image
      v-if="displaySrc"
      :src="displaySrc"
      :alt="props.alt"
      :fit="props.fit"
      :lazy="props.lazy"
      :preview-src-list="props.preview ? previewSrcList : undefined"
      preview-teleported
      class="erp-image-preview__image"
    />
    <div v-else class="erp-image-preview__empty">无图</div>
  </div>
</template>
