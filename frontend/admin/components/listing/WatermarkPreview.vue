<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

const props = defineProps({
  imageUrl: {
    type: String,
    default: ""
  },
  watermarkUrl: {
    type: String,
    default: ""
  },
  position: {
    type: String,
    default: "bottom-right"
  },
  opacity: {
    type: Number,
    default: 0.82
  },
  sizePercent: {
    type: Number,
    default: 22
  },
  margin: {
    type: Number,
    default: 24
  },
  xPercent: {
    type: Number,
    default: 75
  },
  yPercent: {
    type: Number,
    default: 75
  },
  height: {
    type: Number,
    default: 220
  },
  fit: {
    type: String,
    default: "contain"
  }
});

const emit = defineEmits(["rendered", "error"]);

const canvasRef = ref(null);
const errorText = ref("");
const loading = ref(false);

const previewStyle = computed(() => ({
  minHeight: `${props.height}px`
}));

function loadImage(url) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error("图片地址为空"));
      return;
    }
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = url;
  });
}

function drawContain(ctx, image, canvasWidth, canvasHeight) {
  const ratio = Math.min(canvasWidth / image.width, canvasHeight / image.height);
  const width = image.width * ratio;
  const height = image.height * ratio;
  const left = (canvasWidth - width) / 2;
  const top = (canvasHeight - height) / 2;
  ctx.drawImage(image, left, top, width, height);
  return { left, top, width, height };
}

function drawCover(ctx, image, canvasWidth, canvasHeight) {
  const ratio = Math.max(canvasWidth / image.width, canvasHeight / image.height);
  const width = image.width * ratio;
  const height = image.height * ratio;
  const left = (canvasWidth - width) / 2;
  const top = (canvasHeight - height) / 2;
  ctx.drawImage(image, left, top, width, height);
  return { left, top, width, height };
}

function getWatermarkRect(baseRect, watermarkImage) {
  const safeSize = Math.min(Math.max(Number(props.sizePercent || 22), 5), 60);
  const targetWidth = baseRect.width * safeSize / 100;
  const ratio = targetWidth / watermarkImage.width;
  const targetHeight = watermarkImage.height * ratio;
  const margin = Math.max(0, Number(props.margin || 0));
  let left = baseRect.left + baseRect.width - targetWidth - margin;
  let top = baseRect.top + baseRect.height - targetHeight - margin;

  if (props.position === "custom") {
    left = baseRect.left + baseRect.width * Math.min(Math.max(Number(props.xPercent || 75), 0), 100) / 100;
    top = baseRect.top + baseRect.height * Math.min(Math.max(Number(props.yPercent || 75), 0), 100) / 100;
  } else if (props.position === "top-left") {
    left = baseRect.left + margin;
    top = baseRect.top + margin;
  } else if (props.position === "top-right") {
    left = baseRect.left + baseRect.width - targetWidth - margin;
    top = baseRect.top + margin;
  } else if (props.position === "bottom-left") {
    left = baseRect.left + margin;
    top = baseRect.top + baseRect.height - targetHeight - margin;
  } else if (props.position === "bottom-center") {
    left = baseRect.left + (baseRect.width - targetWidth) / 2;
    top = baseRect.top + baseRect.height - targetHeight - margin;
  }

  left = Math.max(baseRect.left, Math.min(left, baseRect.left + baseRect.width - targetWidth));
  top = Math.max(baseRect.top, Math.min(top, baseRect.top + baseRect.height - targetHeight));
  return { left, top, width: targetWidth, height: targetHeight };
}

async function renderPreview() {
  await nextTick();
  const canvas = canvasRef.value;
  if (!canvas) return;
  const parent = canvas.parentElement;
  const width = Math.max(260, parent?.clientWidth || 420);
  const height = Math.max(160, Number(props.height || 220));
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f5f7fa";
  ctx.fillRect(0, 0, width, height);

  if (!props.imageUrl) {
    drawEmpty(ctx, width, height, "暂无主图");
    return;
  }

  loading.value = true;
  errorText.value = "";
  try {
    const baseImage = await loadImage(props.imageUrl);
    const baseRect = props.fit === "cover"
      ? drawCover(ctx, baseImage, width, height)
      : drawContain(ctx, baseImage, width, height);

    if (props.watermarkUrl) {
      const watermarkImage = await loadImage(props.watermarkUrl);
      const rect = getWatermarkRect(baseRect, watermarkImage);
      ctx.save();
      ctx.globalAlpha = Math.min(Math.max(Number(props.opacity || 0.82), 0.05), 1);
      ctx.drawImage(watermarkImage, rect.left, rect.top, rect.width, rect.height);
      ctx.restore();
    }

    emit("rendered", canvas.toDataURL("image/png"));
  } catch (error) {
    errorText.value = error.message || "预览生成失败";
    drawEmpty(ctx, width, height, errorText.value);
    emit("error", error);
  } finally {
    loading.value = false;
  }
}

function drawEmpty(ctx, width, height, text) {
  ctx.fillStyle = "#f5f7fa";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#dcdfe6";
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.setLineDash([]);
  ctx.fillStyle = "#909399";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2);
}

watch(
  () => [props.imageUrl, props.watermarkUrl, props.position, props.opacity, props.sizePercent, props.margin, props.xPercent, props.yPercent, props.height, props.fit],
  renderPreview,
  { deep: true }
);

onMounted(() => {
  renderPreview();
  window.addEventListener("resize", renderPreview);
});

onUnmounted(() => {
  window.removeEventListener("resize", renderPreview);
});
</script>

<template>
  <div class="watermark-preview" :style="previewStyle" v-loading="loading">
    <canvas ref="canvasRef" />
    <div v-if="errorText" class="preview-error">{{ errorText }}</div>
  </div>
</template>

<style scoped>
.watermark-preview {
  position: relative;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.watermark-preview canvas {
  display: block;
  width: 100%;
}

.preview-error {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(245, 108, 108, 0.9);
  color: #fff;
  font-size: 12px;
  text-align: center;
}
</style>
