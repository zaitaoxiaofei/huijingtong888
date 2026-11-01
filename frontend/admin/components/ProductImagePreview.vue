<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getAuthToken, currentApiCacheScope } from "../utils/api";
import {loadProductThumbnail,productThumbnailUrl} from "../utils/product-thumbnail-cache.js";

const props = defineProps({
  src: { type: String, default: "" },
  previewList: { type: Array, default: null },
  alt: { type: String, default: "商品图片" },
  fit: { type: String, default: "cover" },
  size: { type: String, default: "default" },
  preview: { type: Boolean, default: true },
  lazy: { type: Boolean, default: true },
  proxyRemote: { type: Boolean, default: false },
  loadDelay: { type: Number, default: 0 },
  maxInlineImageLength: { type: Number, default: 262144 },
  initialIndex: { type: Number, default: 0 }
});

const host=ref(null),visible=ref(false),scope=ref(currentApiCacheScope()),retry=ref(0);
const thumbnailSrc=ref(''),thumbnailError=ref('');let thumbnailVersion=0,observer;
function revokeThumbnail(){if(thumbnailSrc.value)URL.revokeObjectURL(thumbnailSrc.value);thumbnailSrc.value='';}
function scopeChanged(){scope.value=currentApiCacheScope();revokeThumbnail();thumbnailError.value='';}
function imageChanged(event){if(productThumbnailUrl(primarySrc.value)?.split('?')[0]===`/api/products/${Number(event.detail?.productId)}/image`)retry.value++;}
const useProxyFallback = ref(false);
const fallbackIndex = ref(0);
const imageReady = ref(true);
let imageDelayTimer = null;

function scheduleImageLoad() {
  if (imageDelayTimer) clearTimeout(imageDelayTimer);
  const delay = Math.max(Number(props.loadDelay || 0), 0);
  if (!delay || !props.src) {
    imageReady.value = true;
    return;
  }
  imageReady.value = false;
  imageDelayTimer = setTimeout(() => {
    imageDelayTimer = null;
    imageReady.value = true;
  }, delay);
}

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
  if (/^data:image\//i.test(value)) {
    const maxLength = Math.max(Number(props.maxInlineImageLength || 0), 0);
    return maxLength > 0 && value.length <= maxLength ? value : "";
  }
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
  () => JSON.stringify([firstImageValue(props.src),(Array.isArray(props.previewList)?props.previewList:[]).map(firstImageValue),props.loadDelay,props.proxyRemote,scope.value]),
  () => {
    retry.value=0;
    useProxyFallback.value = false;
    fallbackIndex.value = 0;
    scheduleImageLoad();
  },
  { immediate: true }
);

onMounted(()=>{
 window.addEventListener('erp:auth-scope-changed',scopeChanged);window.addEventListener('erp:product-image-changed',imageChanged);
 if(!props.lazy||typeof IntersectionObserver==='undefined')visible.value=true;
 else{observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){visible.value=true;observer.disconnect();}},{rootMargin:'160px'});if(host.value)observer.observe(host.value);}
});
onBeforeUnmount(() => {
  ++thumbnailVersion;observer?.disconnect();revokeThumbnail();window.removeEventListener('erp:auth-scope-changed',scopeChanged);window.removeEventListener('erp:product-image-changed',imageChanged);
  if (imageDelayTimer) clearTimeout(imageDelayTimer);
});

const previewSrcList = computed(() => {
  scope.value;
  const list = Array.isArray(props.previewList) && props.previewList.length ? props.previewList : [props.src];
  return list.map((item) => normalizeImageSrc(item, { forceProxy: props.proxyRemote || useProxyFallback.value })).filter(Boolean);
});
const primarySrc = computed(() => {scope.value;return normalizeImageSrc(props.src, { forceProxy: props.proxyRemote || useProxyFallback.value });});
const managedUrl=computed(()=>productThumbnailUrl(primarySrc.value));
watch(()=>[managedUrl.value,visible.value,imageReady.value,scope.value,retry.value],async([url,shown,ready,current,attempt])=>{
 const version=++thumbnailVersion;if(!url||!shown||!ready){revokeThumbnail();thumbnailError.value="";return;}
 // Preview-array identity changes never reset this request or the decoded image.
 revokeThumbnail();thumbnailError.value="";
 try{const blob=await loadProductThumbnail(url,{force:attempt>0});if(version!==thumbnailVersion||current!==currentApiCacheScope())return;thumbnailSrc.value=URL.createObjectURL(blob);}
 catch(error){if(version===thumbnailVersion&&error.name!=="AbortError")thumbnailError.value=error.message||"图片加载失败";}
},{immediate:true});
function retryThumbnail(){retry.value++;}
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
  if(managedUrl.value){revokeThumbnail();thumbnailError.value="图片解码失败，可单独重试";return;}
  const value = firstImageValue(props.src);
  if (/^(https?:)?\/\//i.test(value) && !props.proxyRemote && !useProxyFallback.value) {
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
  <div ref="host" class="erp-image-preview" :class="`erp-image-preview--${props.size}`">
    <el-image
      v-if="imageReady && (managedUrl ? thumbnailSrc : displaySrc)"
      :src="managedUrl ? thumbnailSrc : displaySrc"
      :alt="props.alt"
      :fit="props.fit"
      :lazy="props.lazy"
      :preview-src-list="props.preview ? previewSrcList : undefined"
      :initial-index="previewInitialIndex"
      preview-teleported
      class="erp-image-preview__image"
      @error="handleImageError"
    />
    <div v-else class="erp-image-preview__empty"><button v-if="thumbnailError" type="button" :title="thumbnailError" class="erp-image-preview__retry" @click.stop="retryThumbnail">重试图片</button><span v-else>{{ props.src ? "加载图片" : "无图" }}</span></div>
  </div>
</template>

<style scoped>
.erp-image-preview__retry{border:0;background:transparent;color:var(--el-color-primary);font:inherit;cursor:pointer;padding:4px}
</style>
