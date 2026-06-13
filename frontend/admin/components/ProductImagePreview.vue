<script setup>
import { computed, ref, watch } from "vue";
import { getAuthToken } from "../utils/api";

const props = defineProps({
  src: { type: String, default: "" },
  previewList: { type: Array, default: null },
  alt: { type: String, default: "商品图片" },
  fit: { type: String, default: "cover" },
  size: { type: String, default: "default" },
  preview: { type: Boolean, default: true },
  lazy: { type: Boolean, default: true },
  proxyRemote: { type: Boolean, default: false },
  initialIndex: { type: Number, default: 0 }
});

const useProxyFallback = ref(false);
const fallbackIndex = ref(0);

function firstImageValue(src) {
  if (src && typeof src === "object") {
    if (Array.isArray(src)) return firstImageValue(src[0]);
    return firstImageValue(src.url || src.image_url || src.imageUrl || src.src || src.link || src.href || src.file_name || "");
  }
  const value = String(src || "").trim();
  if (!value) return "";
  if (/^data:image\//i.test(value)) return value;
  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return firstImageValue(parsed[0]);
      if (parsed && typeof parsed === "object") {
        return firstImageValue(parsed.url || parsed.image_url || parsed.imageUrl || parsed.src || parsed.link || "");
      }
    } catch {
      return value;
    }
  }
  if (value.includes("||")) {
    return value
      .split(/\s*\|\|\s*/)
      .map((item) => item.trim())
      .find(Boolean) || "";
  }
  return value
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .find(Boolean) || "";
}

function proxiedRemoteImageSrc(value) {
  return `/api/image-proxy?url=${encodeURIComponent(value)}`;
}

function isLocalProtectedUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return false;
  if (value.startsWith("/")) return true;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

function normalizeImageSrc(src, options = {}) {
  const value = firstImageValue(src);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    if (isLocalProtectedUrl(value)) return withImageToken(value);
    return options.forceProxy ? proxiedRemoteImageSrc(value) : value;
  }
  if (/^\/\//.test(value)) {
    const absoluteUrl = `${window.location.protocol}${value}`;
    if (isLocalProtectedUrl(absoluteUrl)) return withImageToken(absoluteUrl);
    return options.forceProxy ? proxiedRemoteImageSrc(absoluteUrl) : absoluteUrl;
  }
  if (/^data:image\//i.test(value)) return value;
  if (/^(\/api\/|\/uploads\/)/i.test(value)) return withImageToken(value);
  return "";
}

function withImageToken(url) {
  const token = getAuthToken();
  if (!token || !url || url.includes("token=")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

watch(
  () => [props.src, props.previewList],
  () => {
    useProxyFallback.value = false;
    fallbackIndex.value = 0;
  }
);

const previewSrcList = computed(() => {
  const list = Array.isArray(props.previewList) && props.previewList.length ? props.previewList : [props.src];
  return list.map((item) => normalizeImageSrc(item, { forceProxy: props.proxyRemote || useProxyFallback.value })).filter(Boolean);
});
const primarySrc = computed(() => normalizeImageSrc(props.src, { forceProxy: props.proxyRemote || useProxyFallback.value }));
const displaySrc = computed(() => {
  const list = previewSrcList.value;
  const primary = primarySrc.value;
  if (!list.length) return primary;
  if (fallbackIndex.value <= 0) return primary || list[0] || "";
  const fallbackList = primary ? list.filter((item) => item !== primary) : list;
  return fallbackList[Math.min(fallbackIndex.value - 1, fallbackList.length - 1)] || primary || list[0] || "";
});
const previewInitialIndex = computed(() => {
  if (!previewSrcList.value.length) return 0;
  const index = Number(props.initialIndex || 0);
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index, previewSrcList.value.length - 1);
});

function handleImageError() {
  const value = firstImageValue(props.src);
  if (/^(https?:)?\/\//i.test(value) && !useProxyFallback.value) {
    useProxyFallback.value = true;
    return;
  }
  const fallbackListLength = primarySrc.value
    ? previewSrcList.value.filter((item) => item !== primarySrc.value).length
    : previewSrcList.value.length;
  if (fallbackIndex.value < fallbackListLength) {
    fallbackIndex.value += 1;
  }
}
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
      :initial-index="previewInitialIndex"
      preview-teleported
      class="erp-image-preview__image"
      @error="handleImageError"
    />
    <div v-else class="erp-image-preview__empty">无图</div>
  </div>
</template>
