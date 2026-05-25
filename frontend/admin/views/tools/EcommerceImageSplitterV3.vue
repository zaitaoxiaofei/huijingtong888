<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import EcommerceImageSplitterShell from "../../components/tools/EcommerceImageSplitterShell.vue";
import {
  convertCropperImagesToRatio,
  detectCropperImage,
  downloadUrl,
  enhanceCropperImages,
  uploadCropperImage,
  watermarkCropperImages,
  withImageToken
} from "../../api/tools/imageCropper";
import { apiClient } from "../../utils/api";

const MAX_SIZE_MB = 25;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const uploadLoading = ref(false);
const detecting = ref(false);
const enhancing = ref(false);
const convertingRatio = ref(false);
const processingAll = ref(false);
const watermarking = ref(false);
const watermarkDialogVisible = ref(false);
const watermarkShopsLoading = ref(false);
const watermarkShops = ref([]);
const watermarkShopId = ref("");
const watermarkOptions = ref(createDefaultWatermarkOptions());
const watermarkDrag = ref(null);
const uploaded = ref(null);
const selectedFile = ref(null);
const uploadPromise = ref(null);
const localPreviewUrl = ref("");
const selectedFilename = ref("");
const detection = ref(null);
const originalNaturalSize = ref({ width: 0, height: 0 });
const selectedCropIds = ref([]);

const imagePreviewUrl = computed(() => {
  if (localPreviewUrl.value) return localPreviewUrl.value;
  return uploaded.value?.previewUrl ? withImageToken(uploaded.value.previewUrl) : "";
});

const cropResults = computed(() => detection.value?.crops || []);
const resultPreviewList = computed(() => cropResults.value.map((item) => withImageToken(item.url)));

const currentTaskText = computed(() => {
  if (processingAll.value) return "一键处理中";
  if (watermarking.value) return "添加水印中";
  if (enhancing.value) return "增强中";
  if (convertingRatio.value) return "转 3:4 中";
  if (detecting.value) return "拆分中";
  if (uploadLoading.value) return "上传中";
  if (cropResults.value.length) return `已生成 ${cropResults.value.length} 张`;
  if (imagePreviewUrl.value) return "待拆分";
  return "等待上传";
});

const previewBoxes = computed(() => {
  const imageWidth = originalNaturalSize.value.width || detection.value?.image?.width || 0;
  const imageHeight = originalNaturalSize.value.height || detection.value?.image?.height || 0;
  if (!imageWidth || !imageHeight) return [];
  return cropResults.value
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .map((item, index) => ({
      id: item.id,
      label: `#${index + 1}`,
      style: {
        left: `${(item.x / imageWidth) * 100}%`,
        top: `${(item.y / imageHeight) * 100}%`,
        width: `${(item.width / imageWidth) * 100}%`,
        height: `${(item.height / imageHeight) * 100}%`
      }
    }));
});

const shellCropResults = computed(() => cropResults.value.map((item) => ({
  id: item.id,
  filename: item.filename,
  width: item.width,
  height: item.height,
  imageUrl: withImageToken(item.url),
  downloadHref: item.downloadUrl ? downloadUrl(item.downloadUrl) : ""
})));

const taskIdShort = computed(() => uploaded.value?.taskId?.slice(0, 12) || detection.value?.taskId?.slice?.(0, 12) || "");
const canSplit = computed(() => Boolean((selectedFile.value || uploaded.value?.taskId) && !uploadLoading.value && !detecting.value && !enhancing.value && !convertingRatio.value && !watermarking.value && !processingAll.value));
const canProcessAll = computed(() => canSplit.value);
const canEnhance = computed(() => Boolean(cropResults.value.length && detection.value?.taskId && !detecting.value && !enhancing.value && !convertingRatio.value && !watermarking.value && !processingAll.value));
const canConvertRatio = computed(() => Boolean(cropResults.value.length && detection.value?.taskId && !detecting.value && !enhancing.value && !convertingRatio.value && !watermarking.value && !processingAll.value));
const canWatermark = computed(() => Boolean(cropResults.value.length && detection.value?.taskId && !detecting.value && !enhancing.value && !convertingRatio.value && !watermarking.value && !processingAll.value));
const canMergeSelected = computed(() => selectedCropIds.value.length >= 2 && !enhancing.value && !convertingRatio.value && !watermarking.value);
const allCropsSelected = computed(() => Boolean(cropResults.value.length && selectedCropIds.value.length === cropResults.value.length));
const canDownloadZip = computed(() => Boolean(cropResults.value.length && detection.value?.zipUrl));
const zipHref = computed(() => detection.value?.zipUrl ? downloadUrl(detection.value.zipUrl) : "");
const selectedWatermarkShop = computed(() => watermarkShops.value.find((shop) => String(shop.id) === String(watermarkShopId.value)) || null);
const watermarkPreviewUrl = computed(() => {
  if (!selectedWatermarkShop.value?.watermark_path) return "";
  return withImageToken(`/api/tools/image-cropper/shop-watermark/${encodeURIComponent(selectedWatermarkShop.value.id)}/file`);
});
const watermarkBasePreviewUrl = computed(() => cropResults.value[0]?.url ? withImageToken(cropResults.value[0].url) : "");
const watermarkOverlayStyle = computed(() => {
  const edge = "3.5%";
  const settings = watermarkOptions.value;
  const style = {
    width: `${settings.scalePercent}%`,
    opacity: Number(settings.opacityPercent || 0) / 100,
    cursor: "grab"
  };
  if (settings.position === "custom") {
    return {
      ...style,
      left: `${settings.xPercent}%`,
      top: `${settings.yPercent}%`
    };
  }
  if (settings.position === "top-left") return { ...style, top: edge, left: edge };
  if (settings.position === "top-right") return { ...style, top: edge, right: edge };
  if (settings.position === "bottom-left") return { ...style, bottom: edge, left: edge };
  if (settings.position === "center") return { ...style, top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  return { ...style, right: edge, bottom: edge };
});

const watermarkPositionOptions = [
  { label: "左上", value: "top-left" },
  { label: "右上", value: "top-right" },
  { label: "居中", value: "center" },
  { label: "左下", value: "bottom-left" },
  { label: "右下", value: "bottom-right" },
  { label: "自定义", value: "custom" }
];

function beforeUpload(file) {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    ElMessage.error("仅支持 jpg、jpeg、png、webp 图片");
    return false;
  }
  if (file.size > MAX_SIZE_MB * 1024 * 1024) {
    ElMessage.error(`图片不能超过 ${MAX_SIZE_MB}MB`);
    return false;
  }
  return true;
}

function createDefaultWatermarkOptions(shop = null) {
  return {
    position: shop?.watermark_position || "bottom-right",
    xPercent: clampPercent(Number(shop?.watermark_x_percent ?? 75), 0, 100),
    yPercent: clampPercent(Number(shop?.watermark_y_percent ?? 75), 0, 100),
    scalePercent: clampPercent(Number(shop?.watermark_scale_percent ?? 22), 8, 45),
    opacityPercent: clampPercent(Number(shop?.watermark_opacity_percent ?? 82), 10, 100)
  };
}

async function uploadRequest(options) {
  if (!beforeUpload(options.file)) return;

  uploadLoading.value = true;
  selectedFile.value = options.file;
  selectedFilename.value = options.file?.name || "";
  setLocalPreview(options.file);
  uploaded.value = null;
  detection.value = null;
  selectedCropIds.value = [];
  originalNaturalSize.value = { width: 0, height: 0 };

  try {
    uploadPromise.value = uploadCropperImage(options.file);
    uploaded.value = await uploadPromise.value;
    options.onSuccess?.(uploaded.value);
    ElMessage.success("上传成功，可以开始拆分");
  } catch (error) {
    options.onError?.(error);
    ElMessage.error(error.message || "图片上传失败");
  } finally {
    uploadLoading.value = false;
    uploadPromise.value = null;
  }
}

async function ensureUploaded() {
  if (uploaded.value?.taskId && uploaded.value?.imagePath) return uploaded.value;
  if (uploadPromise.value) {
    uploaded.value = await uploadPromise.value;
    return uploaded.value;
  }
  if (!selectedFile.value) {
    throw new Error("请先上传图片");
  }

  uploadLoading.value = true;
  try {
    uploadPromise.value = uploadCropperImage(selectedFile.value);
    uploaded.value = await uploadPromise.value;
    return uploaded.value;
  } finally {
    uploadLoading.value = false;
    uploadPromise.value = null;
  }
}

async function handleSplit() {
  if (!canSplit.value) return;

  try {
    const result = await splitImage();
    if (warnForSparseSplit(result)) return;
    ElMessage.success(`已拆分 ${result.crops.length} 张图片`);
  } catch (error) {
    ElMessage.error(error.message || "图片拆分失败");
  }
}

async function splitImage() {
  detecting.value = true;
  selectedCropIds.value = [];

  try {
    const upload = await ensureUploaded();
    const result = await detectCropperImage({
      taskId: upload.taskId,
      imagePath: upload.imagePath,
      mode: "auto"
    });

    detection.value = result;

    if (!result.crops?.length) {
      throw new Error("未识别到可拆分模块，建议换一张边界更清晰的套图");
    }

    return result;
  } finally {
    detecting.value = false;
  }
}

async function enhanceImages() {
  if (!canEnhance.value) return;

  try {
    const enhancedCrops = await enhanceCurrentCrops();
    ElMessage.success(`已增强 ${enhancedCrops.length} 张图片`);
  } catch (error) {
    ElMessage.error(error.message || "画质增强失败");
  }
}

async function enhanceCurrentCrops() {
  enhancing.value = true;
  selectedCropIds.value = [];

  try {
    const result = await enhanceCropperImages({
      taskId: detection.value.taskId,
      filenames: cropResults.value.map((item) => item.filename)
    });
    const enhancedCrops = normalizeEnhancedCrops(result);
    if (!enhancedCrops.length) {
      throw new Error("后端没有返回增强后的图片");
    }

    detection.value = {
      ...detection.value,
      crops: enhancedCrops,
      boxes: [],
      zipUrl: result.zipUrl
    };
    return enhancedCrops;
  } finally {
    enhancing.value = false;
  }
}

async function convertToRatio() {
  if (!canConvertRatio.value) return;

  try {
    const ratioCrops = await convertCurrentCropsToRatio();
    ElMessage.success(`已生成 ${ratioCrops.length} 张 3:4 图片`);
  } catch (error) {
    ElMessage.error(error.message || "一键 3:4 失败");
  }
}

async function convertCurrentCropsToRatio() {
  convertingRatio.value = true;
  selectedCropIds.value = [];

  try {
    const result = await convertCropperImagesToRatio({
      taskId: detection.value.taskId,
      filenames: cropResults.value.map((item) => item.filename)
    });
    const ratioCrops = normalizeProcessedCrops(result);
    if (!ratioCrops.length) {
      throw new Error("后端没有返回 3:4 图片");
    }
    detection.value = {
      ...detection.value,
      crops: ratioCrops,
      boxes: [],
      zipUrl: result.zipUrl
    };
    return ratioCrops;
  } finally {
    convertingRatio.value = false;
  }
}

async function openWatermarkDialog() {
  if (!canWatermark.value) return;
  watermarkDialogVisible.value = true;
  watermarkShopsLoading.value = true;
  try {
    const shops = await apiClient.get("/api/shops", { noCache: true });
    watermarkShops.value = (Array.isArray(shops) ? shops : []).filter((shop) => shop.status !== "deleted" && shop.watermark_path);
    if (!watermarkShops.value.some((shop) => String(shop.id) === String(watermarkShopId.value))) {
      watermarkShopId.value = watermarkShops.value[0]?.id || "";
    }
    watermarkOptions.value = createDefaultWatermarkOptions(selectedWatermarkShop.value);
  } catch (error) {
    ElMessage.error(error.message || "店铺水印加载失败");
  } finally {
    watermarkShopsLoading.value = false;
  }
}

async function addWatermark() {
  if (!canWatermark.value || !watermarkShopId.value) return;

  watermarking.value = true;
  selectedCropIds.value = [];
  try {
    const options = buildWatermarkOptionsPayload();
    const result = await watermarkCropperImages({
      taskId: detection.value.taskId,
      shopId: watermarkShopId.value,
      filenames: cropResults.value.map((item) => item.filename),
      options
    });
    const watermarkedCrops = normalizeProcessedCrops(result);
    if (!watermarkedCrops.length) {
      throw new Error("后端没有返回水印图片");
    }

    detection.value = {
      ...detection.value,
      crops: watermarkedCrops,
      boxes: [],
      zipUrl: result.zipUrl
    };
    watermarkDialogVisible.value = false;
    ElMessage.success(`已添加 ${result.shop?.name || "店铺"} 水印`);
  } catch (error) {
    ElMessage.error(error.message || "添加水印失败");
  } finally {
    watermarking.value = false;
  }
}

function resetWatermarkOptions() {
  watermarkOptions.value = createDefaultWatermarkOptions(selectedWatermarkShop.value);
}

function buildWatermarkOptionsPayload() {
  const settings = watermarkOptions.value || {};
  const position = String(settings.position || "bottom-right");
  const scalePercent = clampPercent(Number(settings.scalePercent ?? 22), 8, 45);
  const opacityPercent = clampPercent(Number(settings.opacityPercent ?? 82), 10, 100);
  const xPercent = clampPercent(Number(settings.xPercent ?? 75), 0, 100);
  const yPercent = clampPercent(Number(settings.yPercent ?? 75), 0, 100);
  return {
    position,
    scalePercent,
    scale_percent: scalePercent,
    opacityPercent,
    opacity_percent: opacityPercent,
    xPercent,
    x_percent: xPercent,
    yPercent,
    y_percent: yPercent
  };
}

function startWatermarkDrag(event) {
  if (!watermarkPreviewUrl.value) return;
  const overlay = event.currentTarget;
  const stage = overlay.closest(".watermark-crop-stage");
  if (!stage) return;
  event.preventDefault();
  overlay.setPointerCapture?.(event.pointerId);
  const overlayRect = overlay.getBoundingClientRect();
  watermarkDrag.value = {
    pointerId: event.pointerId,
    stage,
    overlay,
    offsetX: event.clientX - overlayRect.left,
    offsetY: event.clientY - overlayRect.top
  };
  moveWatermarkDrag(event);
  window.addEventListener("pointermove", moveWatermarkDrag);
  window.addEventListener("pointerup", stopWatermarkDrag);
  window.addEventListener("pointercancel", stopWatermarkDrag);
}

function moveWatermarkDrag(event) {
  const drag = watermarkDrag.value;
  if (!drag) return;
  const stageRect = drag.stage.getBoundingClientRect();
  const overlayRect = drag.overlay.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  const maxX = Math.max(0, ((stageRect.width - overlayRect.width) / stageRect.width) * 100);
  const maxY = Math.max(0, ((stageRect.height - overlayRect.height) / stageRect.height) * 100);
  watermarkOptions.value = {
    ...watermarkOptions.value,
    position: "custom",
    xPercent: clampPercent(((event.clientX - stageRect.left - drag.offsetX) / stageRect.width) * 100, 0, maxX),
    yPercent: clampPercent(((event.clientY - stageRect.top - drag.offsetY) / stageRect.height) * 100, 0, maxY)
  };
}

function stopWatermarkDrag(event) {
  const drag = watermarkDrag.value;
  if (drag?.overlay && event?.pointerId === drag.pointerId) {
    drag.overlay.releasePointerCapture?.(event.pointerId);
  }
  watermarkDrag.value = null;
  window.removeEventListener("pointermove", moveWatermarkDrag);
  window.removeEventListener("pointerup", stopWatermarkDrag);
  window.removeEventListener("pointercancel", stopWatermarkDrag);
}

function clampPercent(value, minimum = 0, maximum = 100) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

async function processAll() {
  if (!canProcessAll.value) return;

  processingAll.value = true;
  try {
    const splitResult = await splitImage();
    if (warnForSparseSplit(splitResult)) return;
    await enhanceCurrentCrops();
    const ratioCrops = await convertCurrentCropsToRatio();
    ElMessage.success(`已拆分、增强并生成 ${ratioCrops.length} 张 3:4 图片`);
  } catch (error) {
    ElMessage.error(error.message || "一键处理失败");
  } finally {
    processingAll.value = false;
  }
}

function warnForSparseSplit(result) {
  if ((result?.crops?.length || 0) >= 2) return false;
  ElMessage.warning("识别结果偏少，请检查图片白色间隔是否清晰");
  return true;
}

function normalizeEnhancedCrops(result) {
  return normalizeProcessedCrops(result);
}

function normalizeProcessedCrops(result) {
  if (Array.isArray(result?.crops) && result.crops.length) return result.crops;
  if (!Array.isArray(result?.images)) return [];
  return result.images.map((image, index) => ({
    id: image.id || `enhanced-${String(index + 1).padStart(3, "0")}`,
    filename: image.filename,
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
    url: image.url,
    downloadUrl: image.downloadUrl
  })).filter((image) => image.filename && image.url);
}

function resetPage() {
  revokeLocalPreview();
  uploadLoading.value = false;
  detecting.value = false;
  enhancing.value = false;
  convertingRatio.value = false;
  watermarking.value = false;
  watermarkDialogVisible.value = false;
  processingAll.value = false;
  uploaded.value = null;
  selectedFile.value = null;
  uploadPromise.value = null;
  selectedFilename.value = "";
  detection.value = null;
  selectedCropIds.value = [];
  originalNaturalSize.value = { width: 0, height: 0 };
}

function removeCrop(id) {
  if (!detection.value?.crops?.length) return;
  detection.value.crops = detection.value.crops.filter((item) => item.id !== id);
  selectedCropIds.value = selectedCropIds.value.filter((item) => item !== id);
}

function toggleCropSelection(id) {
  if (selectedCropIds.value.includes(id)) {
    selectedCropIds.value = selectedCropIds.value.filter((item) => item !== id);
    return;
  }
  selectedCropIds.value = selectedCropIds.value.concat(id);
}

function toggleAllCrops() {
  if (allCropsSelected.value) {
    selectedCropIds.value = [];
    return;
  }
  selectedCropIds.value = cropResults.value.map((item) => item.id);
}

function mergeSelected() {
  if (!detection.value?.crops?.length || selectedCropIds.value.length < 2) return;

  const selected = detection.value.crops.filter((item) => selectedCropIds.value.includes(item.id));
  if (selected.length < 2) return;

  const minX = Math.min(...selected.map((item) => item.x || 0));
  const minY = Math.min(...selected.map((item) => item.y || 0));
  const maxX = Math.max(...selected.map((item) => (item.x || 0) + item.width));
  const maxY = Math.max(...selected.map((item) => (item.y || 0) + item.height));
  const mergedId = `crop-merged-${Date.now()}`;

  const remaining = detection.value.crops.filter((item) => !selectedCropIds.value.includes(item.id));
  remaining.push({
    id: mergedId,
    filename: `merged_${String(remaining.length + 1).padStart(3, "0")}.png`,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    url: selected[0].url,
    downloadUrl: selected[0].downloadUrl
  });

  detection.value.crops = sortCrops(remaining);
  selectedCropIds.value = [];
  ElMessage.success("已合并选中的裁切区域");
}

function sortCrops(items) {
  return [...items].sort((a, b) => {
    const rowGap = Math.abs((a.y || 0) - (b.y || 0));
    if (rowGap > 40) return (a.y || 0) - (b.y || 0);
    return (a.x || 0) - (b.x || 0);
  });
}

function setLocalPreview(file) {
  revokeLocalPreview();
  localPreviewUrl.value = URL.createObjectURL(file);

  const image = new Image();
  image.onload = () => {
    originalNaturalSize.value = {
      width: image.naturalWidth,
      height: image.naturalHeight
    };
  };
  image.src = localPreviewUrl.value;
}

function revokeLocalPreview() {
  if (!localPreviewUrl.value) return;
  URL.revokeObjectURL(localPreviewUrl.value);
  localPreviewUrl.value = "";
}

function openHistory() {
  ElMessage.info("历史记录入口预留中");
}

onBeforeUnmount(() => {
  stopWatermarkDrag();
  revokeLocalPreview();
});

watch(watermarkShopId, () => {
  if (watermarkDialogVisible.value) {
    watermarkOptions.value = createDefaultWatermarkOptions(selectedWatermarkShop.value);
  }
});
</script>

<template>
  <EcommerceImageSplitterShell
    :max-size-mb="MAX_SIZE_MB"
    :upload-loading="uploadLoading"
    :detecting="detecting"
    :enhancing="enhancing"
    :converting-ratio="convertingRatio"
    :processing-all="processingAll"
    :selected-filename="selectedFilename"
    :original-filename="uploaded?.originalFilename || ''"
    :current-task-text="currentTaskText"
    :image-preview-url="imagePreviewUrl"
    :preview-boxes="previewBoxes"
    :task-id-short="taskIdShort"
    :can-split="canSplit"
    :can-process-all="canProcessAll"
    :can-enhance="canEnhance"
    :can-convert-ratio="canConvertRatio"
    :can-watermark="canWatermark"
    :watermarking="watermarking"
    :can-merge-selected="canMergeSelected"
    :all-crops-selected="allCropsSelected"
    :can-download-zip="canDownloadZip"
    :zip-href="zipHref"
    :crop-results="shellCropResults"
    :result-preview-list="resultPreviewList"
    :selected-crop-ids="selectedCropIds"
    :before-upload="beforeUpload"
    :upload-request="uploadRequest"
    @history="openHistory"
    @reset="resetPage"
    @process-all="processAll"
    @split="handleSplit"
    @enhance="enhanceImages"
    @convert-ratio="convertToRatio"
    @watermark="openWatermarkDialog"
    @toggle-all-crops="toggleAllCrops"
    @merge-selected="mergeSelected"
    @toggle-crop-selection="toggleCropSelection"
    @remove-crop="removeCrop"
  />
  <el-dialog v-model="watermarkDialogVisible" title="添加店铺水印" width="880px" align-center>
    <div class="watermark-dialog-grid" v-loading="watermarkShopsLoading">
      <section class="watermark-preview-panel">
        <strong>效果预览</strong>
        <div v-if="watermarkBasePreviewUrl" class="watermark-crop-preview">
          <div class="watermark-crop-stage">
            <img :src="watermarkBasePreviewUrl" alt="当前结果预览" class="watermark-base-image" />
            <img
              v-if="watermarkPreviewUrl"
              :src="watermarkPreviewUrl"
              alt="店铺水印预览"
              class="watermark-overlay-image"
              :style="watermarkOverlayStyle"
              @pointerdown="startWatermarkDrag"
            />
          </div>
        </div>
        <div class="watermark-asset-preview">
          <span>水印素材</span>
          <img v-if="watermarkPreviewUrl" :src="watermarkPreviewUrl" alt="店铺水印素材" />
          <em v-else>请选择已配置水印的店铺</em>
        </div>
      </section>

      <el-form label-position="top" class="watermark-control-form">
        <el-form-item label="店铺">
          <el-select v-model="watermarkShopId" class="watermark-shop-select" placeholder="请选择已配置水印的店铺">
            <el-option
              v-for="shop in watermarkShops"
              :key="shop.id"
              :label="`${shop.name || `店铺 ${shop.id}`} · ${shop.watermark_name || '店铺水印'}`"
              :value="shop.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="位置">
          <el-radio-group v-model="watermarkOptions.position" class="watermark-position-group">
            <el-radio-button v-for="item in watermarkPositionOptions" :key="item.value" :label="item.value">{{ item.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <p class="watermark-drag-tip">可直接拖动预览图中的水印，拖动后会按当前位置批量应用。</p>
        <el-form-item :label="`大小 ${watermarkOptions.scalePercent}%`">
          <el-slider v-model="watermarkOptions.scalePercent" :min="8" :max="45" :step="1" show-stops />
        </el-form-item>
        <el-form-item :label="`透明度 ${watermarkOptions.opacityPercent}%`">
          <el-slider v-model="watermarkOptions.opacityPercent" :min="10" :max="100" :step="1" />
        </el-form-item>
        <el-button @click="resetWatermarkOptions">恢复默认</el-button>
        <el-alert
          v-if="!watermarkShopsLoading && !watermarkShops.length"
          title="还没有可用水印，请先在店铺编辑弹窗中上传"
          type="info"
          :closable="false"
        />
      </el-form>
    </div>
    <template #footer>
      <el-button @click="watermarkDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="watermarking" :disabled="!watermarkPreviewUrl" @click="addWatermark">应用到全部图片</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.watermark-dialog-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
  gap: 20px;
  min-height: 450px;
}

.watermark-preview-panel,
.watermark-control-form {
  min-width: 0;
}

.watermark-preview-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.watermark-preview-panel strong {
  color: #0f172a;
  font-size: 15px;
}

.watermark-crop-preview {
  height: 330px;
  overflow: hidden;
  display: grid;
  place-items: center;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 8px;
  background: #eef3fa;
}

.watermark-crop-stage {
  position: relative;
  max-width: 100%;
  max-height: 100%;
}

.watermark-base-image,
.watermark-overlay-image {
  display: block;
  max-width: 100%;
}

.watermark-base-image {
  width: auto;
  height: auto;
  max-height: 330px;
  object-fit: contain;
}

.watermark-overlay-image {
  position: absolute;
  height: auto;
  max-height: 36%;
  object-fit: contain;
  touch-action: none;
  user-select: none;
}

.watermark-overlay-image:active {
  cursor: grabbing !important;
}

.watermark-asset-preview {
  min-height: 78px;
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 8px;
  color: #64748b;
  background:
    linear-gradient(45deg, rgba(148, 163, 184, 0.14) 25%, transparent 25%, transparent 75%, rgba(148, 163, 184, 0.14) 75%),
    linear-gradient(45deg, rgba(148, 163, 184, 0.14) 25%, transparent 25%, transparent 75%, rgba(148, 163, 184, 0.14) 75%),
    #fff;
  background-position: 0 0, 10px 10px;
  background-size: 20px 20px;
}

.watermark-asset-preview img {
  max-width: 100%;
  max-height: 72px;
  object-fit: contain;
}

.watermark-asset-preview em {
  font-style: normal;
}

.watermark-control-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.watermark-shop-select {
  width: 100%;
}

.watermark-position-group {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
}

.watermark-drag-tip {
  margin: -8px 0 16px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.6;
}

.watermark-position-group :deep(.el-radio-button),
.watermark-position-group :deep(.el-radio-button__inner) {
  width: 100%;
}

@media (max-width: 760px) {
  .watermark-dialog-grid {
    grid-template-columns: 1fr;
  }

  .watermark-crop-preview {
    height: 280px;
  }
}
</style>
