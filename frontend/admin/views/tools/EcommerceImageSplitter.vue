<script setup>
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  Crop,
  Delete,
  Download,
  EditPen,
  Grid,
  MagicStick,
  Picture,
  Refresh,
  UploadFilled
} from "@element-plus/icons-vue";
import { detectCropperImage, downloadUrl, uploadCropperImage, withImageToken } from "../../api/tools/imageCropper";

const MAX_SIZE_MB = 25;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const uploadLoading = ref(false);
const detecting = ref(false);
const uploaded = ref(null);
const selectedFile = ref(null);
const uploadPromise = ref(null);
const localPreviewUrl = ref("");
const selectedFilename = ref("");
const detection = ref(null);
const originalNaturalSize = ref({ width: 0, height: 0 });
const drawingBox = ref(null);
const manualDraftStart = ref(null);

const splitOptions = reactive({
  mode: "auto",
  rows: 3,
  cols: 2,
  trimBorder: 2,
  backgroundColor: "auto",
  threshold: 245,
  minAreaRatio: 0.03,
  mergeDistance: 20,
  padding: 4,
  roundCornerTolerance: true,
  manualBoxes: []
});

const modes = [
  { value: "auto", title: "自动识别", desc: "优先识别分割线，再回退到不规则卡片识别", icon: MagicStick },
  { value: "grid", title: "网格拆分", desc: "适合 2×3、3×3 等标准网格套图", icon: Grid },
  { value: "horizontal", title: "横向拆分", desc: "适合上下拼接或单列详情图", icon: Crop },
  { value: "vertical", title: "纵向拆分", desc: "适合左右拼接或横向套图", icon: Picture },
  { value: "masonry", title: "不规则卡片识别", desc: "识别白底瀑布流、圆角卡片、上2下3布局", icon: Picture },
  { value: "manual", title: "手动框选", desc: "在原图上直接框出区域，作为最终兜底方案", icon: EditPen }
];

const presets = [
  { label: "2×3", rows: 3, cols: 2 },
  { label: "3×3", rows: 3, cols: 3 },
  { label: "4×2", rows: 2, cols: 4 }
];

const imagePreviewUrl = computed(() => {
  if (localPreviewUrl.value) return localPreviewUrl.value;
  return uploaded.value?.previewUrl ? withImageToken(uploaded.value.previewUrl) : "";
});
const cropResults = computed(() => detection.value?.crops || []);
const boxes = computed(() => detection.value?.boxes || []);
const canSplit = computed(() => {
  if (!(selectedFile.value || uploaded.value?.taskId) || uploadLoading.value || detecting.value) return false;
  if (splitOptions.mode === "manual") return splitOptions.manualBoxes.length > 0;
  return true;
});
const canDownload = computed(() => cropResults.value.length > 0 && !detecting.value);
const splitButtonText = computed(() => {
  if (splitOptions.mode === "grid") return "按网格拆分";
  if (splitOptions.mode === "masonry") return "识别不规则卡片";
  if (splitOptions.mode === "manual") return "按手动框选拆分";
  return "开始拆分";
});
const zipUrl = computed(() => detection.value?.zipUrl ? downloadUrl(detection.value.zipUrl) : "");
const statusType = computed(() => {
  if (detecting.value || uploadLoading.value) return "warning";
  if (cropResults.value.length) return "success";
  if (imagePreviewUrl.value) return "primary";
  return "info";
});
const statusText = computed(() => {
  if (detecting.value) return "拆分中";
  if (uploadLoading.value) return "上传中";
  if (cropResults.value.length) return `已生成 ${cropResults.value.length} 张`;
  if (splitOptions.mode === "manual" && splitOptions.manualBoxes.length) return `已框选 ${splitOptions.manualBoxes.length} 个区域`;
  if (imagePreviewUrl.value) return "待拆分";
  return "等待上传";
});
const previewScale = computed(() => ({
  width: originalNaturalSize.value.width || detection.value?.image?.width || 0,
  height: originalNaturalSize.value.height || detection.value?.image?.height || 0
}));
const previewOverlayBoxes = computed(() => {
  const manual = splitOptions.mode === "manual"
    ? splitOptions.manualBoxes.map((box, index) => ({
      id: `manual-${index + 1}`,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height
    }))
    : [];
  const draft = drawingBox.value ? [{ id: "draft-box", ...drawingBox.value }] : [];
  return splitOptions.mode === "manual" ? manual.concat(draft) : boxes.value;
});

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

async function handleUpload(options) {
  if (!beforeUpload(options.file)) return;
  uploadLoading.value = true;
  selectedFile.value = options.file;
  selectedFilename.value = options.file?.name || "本地图片";
  setLocalPreview(options.file);
  uploaded.value = null;
  detection.value = null;
  originalNaturalSize.value = { width: 0, height: 0 };
  splitOptions.manualBoxes = [];
  drawingBox.value = null;

  try {
    uploadPromise.value = uploadCropperImage(options.file);
    uploaded.value = await uploadPromise.value;
    ElMessage.success("上传成功，可以开始拆分");
    options.onSuccess?.(uploaded.value);
  } catch (error) {
    ElMessage.error(error.message || "图片上传失败");
    options.onError?.(error);
  } finally {
    uploadLoading.value = false;
    uploadPromise.value = null;
  }
}

async function runDetect() {
  if (!canSplit.value) return;
  detecting.value = true;

  try {
    const upload = await ensureUploaded();
    const result = await detectCropperImage({
      taskId: upload.taskId,
      imagePath: upload.imagePath,
      mode: splitOptions.mode,
      rows: splitOptions.mode === "grid" ? Number(splitOptions.rows) : 0,
      cols: splitOptions.mode === "grid" ? Number(splitOptions.cols) : 0,
      trimBorder: splitOptions.mode === "grid" ? Number(splitOptions.trimBorder) : 0,
      backgroundColor: splitOptions.mode === "masonry" || splitOptions.mode === "auto" ? splitOptions.backgroundColor : "auto",
      threshold: splitOptions.mode === "masonry" || splitOptions.mode === "auto" ? Number(splitOptions.threshold) : 245,
      minAreaRatio: splitOptions.mode === "masonry" || splitOptions.mode === "auto" ? Number(splitOptions.minAreaRatio) : 0.03,
      mergeDistance: splitOptions.mode === "masonry" || splitOptions.mode === "auto" ? Number(splitOptions.mergeDistance) : 20,
      padding: splitOptions.mode === "masonry" || splitOptions.mode === "manual" || splitOptions.mode === "auto" ? Number(splitOptions.padding) : 4,
      roundCornerTolerance: splitOptions.mode === "masonry" || splitOptions.mode === "auto" ? Boolean(splitOptions.roundCornerTolerance) : true,
      manualBoxes: splitOptions.mode === "manual" ? splitOptions.manualBoxes : []
    });

    detection.value = result;
    const count = result.crops?.length || 0;
    if (!count) {
      if (splitOptions.mode === "masonry") {
        ElMessage.warning("未识别到多个卡片，请尝试提高 threshold 或使用手动框选模式。");
      } else {
        ElMessage.warning("没有识别到可拆分模块，请切换到网格拆分或手动框选。");
      }
    } else if ((splitOptions.mode === "auto" || splitOptions.mode === "masonry") && count < 2) {
      ElMessage.warning("识别结果过少，建议提高阈值或使用手动框选模式。");
    } else {
      ElMessage.success(`已拆分 ${count} 张图片`);
    }
  } catch (error) {
    ElMessage.error(error.message || "图片拆分失败");
  } finally {
    detecting.value = false;
  }
}

async function ensureUploaded() {
  if (uploaded.value?.taskId && uploaded.value?.imagePath) return uploaded.value;
  if (uploadPromise.value) {
    uploaded.value = await uploadPromise.value;
    return uploaded.value;
  }
  if (!selectedFile.value) throw new Error("请先上传图片");

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

function setMode(mode) {
  splitOptions.mode = mode;
  drawingBox.value = null;
}

function applyPreset(preset) {
  splitOptions.mode = "grid";
  splitOptions.rows = preset.rows;
  splitOptions.cols = preset.cols;
}

function resetTool() {
  revokeLocalPreview();
  uploaded.value = null;
  selectedFile.value = null;
  uploadPromise.value = null;
  selectedFilename.value = "";
  detection.value = null;
  originalNaturalSize.value = { width: 0, height: 0 };
  splitOptions.manualBoxes = [];
  drawingBox.value = null;
}

function removeCrop(id) {
  if (!detection.value?.crops) return;
  detection.value.crops = detection.value.crops.filter((crop) => crop.id !== id);
  detection.value.boxes = detection.value.boxes.filter((box) => box.id !== id);
}

function removeManualBox(index) {
  splitOptions.manualBoxes.splice(index, 1);
}

function clearManualBoxes() {
  splitOptions.manualBoxes = [];
  drawingBox.value = null;
}

function setLocalPreview(file) {
  revokeLocalPreview();
  localPreviewUrl.value = URL.createObjectURL(file);
}

function revokeLocalPreview() {
  if (!localPreviewUrl.value) return;
  URL.revokeObjectURL(localPreviewUrl.value);
  localPreviewUrl.value = "";
}

function onOriginalLoad(event) {
  originalNaturalSize.value = {
    width: event.target.naturalWidth,
    height: event.target.naturalHeight
  };
}

function boxStyle(box) {
  const width = previewScale.value.width || 1;
  const height = previewScale.value.height || 1;
  return {
    left: `${(box.x / width) * 100}%`,
    top: `${(box.y / height) * 100}%`,
    width: `${(box.width / width) * 100}%`,
    height: `${(box.height / height) * 100}%`
  };
}

function handlePreviewPointerDown(event) {
  if (splitOptions.mode !== "manual" || !imagePreviewUrl.value) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const point = previewPointerToImage(event.clientX, event.clientY, rect);
  if (!point) return;
  manualDraftStart.value = point;
  drawingBox.value = { x: point.x, y: point.y, width: 0, height: 0 };
}

function handlePreviewPointerMove(event) {
  if (splitOptions.mode !== "manual" || !manualDraftStart.value) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const point = previewPointerToImage(event.clientX, event.clientY, rect);
  if (!point) return;

  const start = manualDraftStart.value;
  const left = Math.min(start.x, point.x);
  const top = Math.min(start.y, point.y);
  const right = Math.max(start.x, point.x);
  const bottom = Math.max(start.y, point.y);
  drawingBox.value = { x: left, y: top, width: right - left, height: bottom - top };
}

function handlePreviewPointerUp() {
  if (splitOptions.mode !== "manual" || !manualDraftStart.value || !drawingBox.value) {
    manualDraftStart.value = null;
    return;
  }
  const draft = drawingBox.value;
  if (draft.width >= 24 && draft.height >= 24) {
    splitOptions.manualBoxes.push({ x: draft.x, y: draft.y, width: draft.width, height: draft.height });
  }
  manualDraftStart.value = null;
  drawingBox.value = null;
}

function previewPointerToImage(clientX, clientY, rect) {
  const imageWidth = previewScale.value.width;
  const imageHeight = previewScale.value.height;
  if (!imageWidth || !imageHeight || !rect.width || !rect.height) return null;

  const scale = Math.min(rect.width / imageWidth, rect.height / imageHeight);
  const displayWidth = imageWidth * scale;
  const displayHeight = imageHeight * scale;
  const offsetX = (rect.width - displayWidth) / 2;
  const offsetY = (rect.height - displayHeight) / 2;
  const relativeX = clientX - rect.left - offsetX;
  const relativeY = clientY - rect.top - offsetY;
  if (relativeX < 0 || relativeY < 0 || relativeX > displayWidth || relativeY > displayHeight) return null;

  return {
    x: Math.max(0, Math.min(imageWidth, Math.round(relativeX / scale))),
    y: Math.max(0, Math.min(imageHeight, Math.round(relativeY / scale)))
  };
}

onBeforeUnmount(() => {
  revokeLocalPreview();
});
</script>

<template>
  <div class="splitter-page">
    <div class="splitter-container">
      <div class="splitter-header">
        <div class="title-block">
          <div class="eyebrow">AI Image Workspace</div>
          <h1>电商套图拆分器</h1>
          <p>支持标准网格、不规则白底卡片拼图，以及手动框选拆分。</p>
        </div>

        <div class="header-actions">
          <el-tag :type="statusType" effect="dark" size="large">{{ statusText }}</el-tag>
          <el-upload
            action="#"
            :show-file-list="false"
            :http-request="handleUpload"
            :before-upload="beforeUpload"
            accept=".jpg,.jpeg,.png,.webp"
          >
            <el-button :icon="Refresh" size="large">上传新图片</el-button>
          </el-upload>
          <el-button
            type="primary"
            size="large"
            :icon="Download"
            :disabled="!canDownload"
            tag="a"
            :href="canDownload ? zipUrl : undefined"
          >
            下载 ZIP
          </el-button>
        </div>
      </div>

      <div class="splitter-workspace">
        <section class="left-panel">
          <el-card class="card preview-card" shadow="never">
            <template #header>
              <div class="card-header">
                <div>
                  <strong>原图预览</strong>
                  <span>{{ selectedFilename || uploaded?.originalFilename || "未上传" }}</span>
                </div>
                <el-button v-if="imagePreviewUrl" :icon="Refresh" circle @click="resetTool" />
              </div>
            </template>

            <div
              class="preview-image-wrap"
              v-loading="uploadLoading"
              element-loading-text="正在上传"
              @pointerdown="handlePreviewPointerDown"
              @pointermove="handlePreviewPointerMove"
              @pointerup="handlePreviewPointerUp"
              @pointerleave="handlePreviewPointerUp"
            >
              <template v-if="imagePreviewUrl">
                <img class="preview-image" :src="imagePreviewUrl" alt="原图预览" @load="onOriginalLoad" />
                <div
                  v-for="(box, index) in previewOverlayBoxes"
                  :key="box.id"
                  class="crop-box"
                  :class="{ manual: splitOptions.mode === 'manual' }"
                  :style="boxStyle(box)"
                >
                  <span>{{ splitOptions.mode === "manual" ? `#${index + 1}` : box.id.replace("crop-", "#") }}</span>
                </div>
              </template>

              <el-upload
                v-else
                drag
                action="#"
                :show-file-list="false"
                :http-request="handleUpload"
                :before-upload="beforeUpload"
                accept=".jpg,.jpeg,.png,.webp"
                class="upload-zone"
              >
                <el-icon class="upload-icon"><UploadFilled /></el-icon>
                <div class="upload-title">拖拽图片到这里</div>
                <div class="upload-desc">支持 JPG、JPEG、PNG、WEBP，单张不超过 {{ MAX_SIZE_MB }}MB</div>
              </el-upload>
            </div>

            <div class="task-row">
              <span>Task ID</span>
              <strong>{{ uploaded?.taskId ? uploaded.taskId.slice(0, 12) : "Local Preview" }}</strong>
            </div>

            <div v-if="splitOptions.mode === 'manual'" class="manual-toolbar">
              <el-tag effect="plain">拖动鼠标框选区域</el-tag>
              <div class="manual-actions">
                <el-button text @click="clearManualBoxes" :disabled="!splitOptions.manualBoxes.length">清空框选</el-button>
              </div>
            </div>
          </el-card>

          <el-card class="card mode-panel" shadow="never">
            <template #header>
              <div class="card-header compact">
                <strong>拆分模式</strong>
                <el-tag effect="plain">V2</el-tag>
              </div>
            </template>

            <div class="mode-grid">
              <el-card
                v-for="mode in modes"
                :key="mode.value"
                class="mode-card"
                :class="{ active: splitOptions.mode === mode.value }"
                shadow="never"
                @click="setMode(mode.value)"
              >
                <el-icon><component :is="mode.icon" /></el-icon>
                <strong>{{ mode.title }}</strong>
                <span>{{ mode.desc }}</span>
              </el-card>
            </div>
          </el-card>

          <el-card class="card params-panel" shadow="never">
            <template #header>
              <div class="card-header compact">
                <strong>参数设置</strong>
                <span>
                  {{
                    splitOptions.mode === "masonry"
                      ? "不规则卡片识别参数"
                      : splitOptions.mode === "manual"
                        ? "手动画框后直接拆分"
                        : "网格模式默认 3×2"
                  }}
                </span>
              </div>
            </template>

            <div v-if="splitOptions.mode === 'grid'" class="number-grid">
              <label>
                <span>Rows 行数</span>
                <el-input-number v-model="splitOptions.rows" :min="1" :max="20" controls-position="right" />
              </label>
              <label>
                <span>Cols 列数</span>
                <el-input-number v-model="splitOptions.cols" :min="1" :max="12" controls-position="right" />
              </label>
              <label class="wide">
                <span>Trim Border 边缘裁切</span>
                <el-input-number v-model="splitOptions.trimBorder" :min="0" :max="12" controls-position="right" />
              </label>
            </div>

            <div v-else-if="splitOptions.mode === 'masonry' || splitOptions.mode === 'auto'" class="number-grid">
              <label>
                <span>背景类型</span>
                <el-select v-model="splitOptions.backgroundColor">
                  <el-option label="自动识别" value="auto" />
                  <el-option label="纯白背景" value="white" />
                  <el-option label="浅色背景" value="light" />
                </el-select>
              </label>
              <label>
                <span>Threshold 背景阈值</span>
                <el-input-number v-model="splitOptions.threshold" :min="200" :max="254" controls-position="right" />
              </label>
              <label>
                <span>Min Area Ratio 最小面积比</span>
                <el-input-number v-model="splitOptions.minAreaRatio" :min="0.01" :max="0.2" :step="0.01" :precision="2" controls-position="right" />
              </label>
              <label>
                <span>Merge Distance 合并距离</span>
                <el-input-number v-model="splitOptions.mergeDistance" :min="0" :max="120" controls-position="right" />
              </label>
              <label>
                <span>Padding 留边</span>
                <el-input-number v-model="splitOptions.padding" :min="0" :max="20" controls-position="right" />
              </label>
              <label class="wide switch-label">
                <span>圆角容错</span>
                <el-switch v-model="splitOptions.roundCornerTolerance" />
              </label>
            </div>

            <div v-else-if="splitOptions.mode === 'manual'" class="manual-config">
              <el-alert type="info" :closable="false" show-icon title="在左侧原图上按住鼠标拖动，即可新增一个裁切框。" />
              <div class="manual-boxes">
                <el-tag v-for="(box, index) in splitOptions.manualBoxes" :key="`${box.x}-${box.y}-${index}`" closable @close="removeManualBox(index)">
                  区域 {{ index + 1 }} · {{ box.width }}×{{ box.height }}
                </el-tag>
              </div>
              <label class="wide">
                <span>Padding 留边</span>
                <el-input-number v-model="splitOptions.padding" :min="0" :max="20" controls-position="right" />
              </label>
            </div>

            <div v-if="splitOptions.mode === 'grid'" class="preset-row">
              <el-button v-for="preset in presets" :key="preset.label" @click="applyPreset(preset)">
                {{ preset.label }}
              </el-button>
            </div>

            <el-button
              class="split-button"
              type="primary"
              size="large"
              :icon="Crop"
              :loading="detecting"
              :disabled="!canSplit"
              @click="runDetect"
            >
              {{ splitButtonText }}
            </el-button>
          </el-card>
        </section>

        <section class="right-panel">
          <el-card class="card result-panel" shadow="never">
            <template #header>
              <div class="result-header">
                <div>
                  <strong>拆分结果</strong>
                  <span>{{ cropResults.length ? `${cropResults.length} 张图片` : "等待生成" }}</span>
                </div>
                <el-button type="primary" :icon="Download" :disabled="!canDownload" tag="a" :href="canDownload ? zipUrl : undefined">
                  全部下载
                </el-button>
              </div>
            </template>

            <el-empty v-if="!cropResults.length" class="empty-state" description="上传一张电商套图开始拆分">
              <template #image>
                <div class="empty-visual">
                  <el-icon><Picture /></el-icon>
                </div>
              </template>
            </el-empty>

            <div v-else class="result-grid">
              <el-card v-for="(crop, index) in cropResults" :key="crop.id" class="result-card" shadow="hover">
                <div class="result-thumb">
                  <el-image
                    :src="withImageToken(crop.url)"
                    fit="contain"
                    :preview-src-list="cropResults.map(item => withImageToken(item.url))"
                  />
                  <div class="result-actions">
                    <el-button circle :icon="Download" tag="a" :href="downloadUrl(crop.downloadUrl)" />
                    <el-button circle type="danger" :icon="Delete" @click="removeCrop(crop.id)" />
                  </div>
                </div>
                <div class="result-footer">
                  <div>
                    <strong>图片 {{ index + 1 }}</strong>
                    <span>{{ crop.filename }}</span>
                  </div>
                  <el-tag effect="plain">{{ crop.width }}×{{ crop.height }}</el-tag>
                </div>
              </el-card>
            </div>
          </el-card>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.splitter-page {
  width: 100%;
  min-height: calc(100vh - 56px);
  background: #eef3f8;
  padding: 24px;
  box-sizing: border-box;
}

.splitter-container {
  max-width: 1680px;
  margin: 0 auto;
  width: 100%;
}

.splitter-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  gap: 20px;
}

.title-block {
  min-width: 0;
}

.eyebrow {
  margin-bottom: 4px;
  color: #2563eb;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.title-block h1 {
  margin: 0;
  color: #0f172a;
  font-size: 28px;
  line-height: 1.15;
}

.title-block p {
  margin: 6px 0 0;
  color: #64748b;
}

.header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex: 0 1 auto;
}

.splitter-workspace {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
  width: 100%;
}

.left-panel,
.right-panel {
  min-width: 0;
}

.left-panel {
  width: 360px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.right-panel {
  min-width: 0;
  width: 100%;
}

.card {
  background: #ffffff;
  border-radius: 18px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
  border: 1px solid rgba(148, 163, 184, 0.18);
}

.card :deep(.el-card__header) {
  padding: 18px 20px 0;
  border-bottom: 0;
}

.card :deep(.el-card__body) {
  padding: 20px;
}

.card-header,
.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-header div,
.result-header div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.card-header strong,
.result-header strong {
  color: #0f172a;
  font-size: 16px;
}

.card-header span,
.result-header span {
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-header.compact {
  min-height: 28px;
}

.preview-card {
  min-height: 520px;
}

.preview-image-wrap {
  position: relative;
  width: 100%;
  height: 420px;
  background: #0f172a;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
}

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.upload-zone,
.upload-zone :deep(.el-upload),
.upload-zone :deep(.el-upload-dragger) {
  width: 100%;
  height: 100%;
}

.upload-zone :deep(.el-upload-dragger) {
  height: 100%;
  border: 0;
  background: transparent;
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.upload-icon {
  margin-bottom: 14px;
  color: #93c5fd;
  font-size: 54px;
}

.upload-title {
  color: #f8fafc;
  font-size: 18px;
  font-weight: 800;
}

.upload-desc {
  margin-top: 8px;
  color: #94a3b8;
  font-size: 13px;
}

.crop-box {
  position: absolute;
  border: 2px solid #22c55e;
  border-radius: 8px;
  background: rgba(34, 197, 94, 0.1);
  pointer-events: none;
}

.crop-box.manual {
  border-color: #2563eb;
  background: rgba(37, 99, 235, 0.12);
}

.crop-box span {
  position: absolute;
  left: 6px;
  top: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  color: #052e16;
  font-size: 12px;
  font-weight: 800;
  background: #86efac;
}

.crop-box.manual span {
  color: #172554;
  background: #bfdbfe;
}

.task-row,
.manual-toolbar {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 14px;
  background: #f8fafc;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.task-row span {
  color: #64748b;
  font-size: 12px;
}

.task-row strong {
  color: #0f172a;
  font-size: 13px;
}

.manual-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mode-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.mode-card {
  border: 1px solid #dbe4f0;
  border-radius: 14px;
  cursor: pointer;
  background: #f8fafc;
  transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.mode-card :deep(.el-card__body) {
  padding: 14px;
}

.mode-card:hover {
  transform: translateY(-2px);
}

.mode-card.active {
  border-color: #2563eb;
  background: #eff6ff;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.mode-card .el-icon {
  color: #2563eb;
  font-size: 22px;
}

.mode-card strong {
  display: block;
  margin-top: 10px;
  color: #0f172a;
  font-size: 14px;
}

.mode-card span {
  display: block;
  margin-top: 5px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
}

.number-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.number-grid label,
.manual-config label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.number-grid label > span,
.manual-config label > span {
  color: #475569;
  font-size: 13px;
  font-weight: 700;
}

.number-grid .wide,
.manual-config .wide {
  grid-column: 1 / -1;
}

.number-grid :deep(.el-input-number),
.number-grid :deep(.el-select),
.manual-config :deep(.el-input-number) {
  width: 100%;
}

.switch-label {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.preset-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.manual-config {
  display: grid;
  gap: 14px;
}

.manual-boxes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.split-button {
  width: 100%;
  margin-top: 16px;
  border: 0;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
}

.result-panel {
  min-height: 720px;
  width: 100%;
  box-sizing: border-box;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 18px;
}

.result-card {
  min-width: 0;
  background: #ffffff;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
}

.result-card :deep(.el-card__body) {
  padding: 0;
}

.result-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: contain;
  background: #111827;
  overflow: hidden;
}

.result-thumb .el-image {
  width: 100%;
  height: 100%;
}

.result-actions {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  gap: 8px;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 160ms ease, transform 160ms ease;
}

.result-card:hover .result-actions {
  opacity: 1;
  transform: translateY(0);
}

.result-footer {
  padding: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.result-footer div {
  min-width: 0;
}

.result-footer strong {
  display: block;
  color: #0f172a;
  font-size: 14px;
}

.result-footer span {
  display: block;
  overflow: hidden;
  margin-top: 4px;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-state {
  min-height: 560px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-visual {
  width: 112px;
  height: 112px;
  border-radius: 32px;
  background: linear-gradient(135deg, #dbeafe, #ede9fe);
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-visual .el-icon {
  color: #2563eb;
  font-size: 48px;
}

@media (min-width: 1600px) {
  .splitter-workspace {
    grid-template-columns: 380px minmax(0, 1fr);
    gap: 24px;
  }

  .left-panel {
    width: 380px;
  }
}

@media (max-width: 1200px) {
  .splitter-workspace {
    grid-template-columns: 320px minmax(0, 1fr);
  }

  .left-panel {
    width: 320px;
  }
}

@media (max-width: 900px) {
  .splitter-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .header-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .splitter-workspace {
    grid-template-columns: 1fr;
  }

  .left-panel {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .splitter-page {
    padding: 16px;
  }

  .mode-grid,
  .number-grid,
  .preset-row {
    grid-template-columns: 1fr;
  }
}
</style>
