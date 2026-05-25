<script setup>
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import AiWorkbenchHeader from "./image-cropper/components/AiWorkbenchHeader.vue";
import ResultWorkspace from "./image-cropper/components/ResultWorkspace.vue";
import WorkflowPanel from "./image-cropper/components/WorkflowPanel.vue";
import { detectCropperImage, downloadUrl, uploadCropperImage, withImageToken } from "../../api/tools/imageCropper";
import "./image-cropper/styles/image-cropper-workbench.css";

const MAX_SIZE_MB = 25;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const uploadLoading = ref(false);
const detecting = ref(false);
const enhancing = ref(false);
const uploaded = ref(null);
const selectedFile = ref(null);
const uploadPromise = ref(null);
const localPreviewUrl = ref("");
const selectedFilename = ref("");
const detection = ref(null);
const originalNaturalSize = ref({ width: 0, height: 0 });
const splitOptions = reactive({
  mode: "auto",
  rows: 3,
  cols: 2,
  trimBorder: 2
});

const imagePreviewUrl = computed(() => {
  if (localPreviewUrl.value) return localPreviewUrl.value;
  return uploaded.value?.previewUrl ? withImageToken(uploaded.value.previewUrl) : "";
});
const cropResults = computed(() => detection.value?.crops || []);
const boxes = computed(() => detection.value?.boxes || []);
const canSplit = computed(() => Boolean(selectedFile.value || uploaded.value?.taskId) && !uploadLoading.value && !detecting.value);
const canUseResults = computed(() => cropResults.value.length > 0 && !detecting.value);
const splitButtonText = computed(() => splitOptions.mode === "grid" ? "按网格拆分" : "一键自动裁切");
const statusText = computed(() => {
  if (detecting.value) return "正在拆分图片";
  if (uploadLoading.value) return "正在上传图片";
  if (cropResults.value.length) return `已生成 ${cropResults.value.length} 张`;
  if (uploaded.value || imagePreviewUrl.value) return "等待处理";
  return "准备就绪";
});
const previewScale = computed(() => ({
  width: originalNaturalSize.value.width || detection.value?.image?.width || 0,
  height: originalNaturalSize.value.height || detection.value?.image?.height || 0
}));
const zipDownloadUrl = computed(() => detection.value?.zipUrl ? downloadUrl(detection.value.zipUrl) : "");

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
      trimBorder: splitOptions.mode === "grid" ? Number(splitOptions.trimBorder) : 0
    });

    detection.value = result;
    const count = result.crops?.length || 0;
    if (!count) {
      ElMessage.warning("没有识别到可拆分模块，请尝试手动网格模式。");
    } else if (splitOptions.mode === "auto" && count <= 2) {
      ElMessage.warning("未准确识别全部模块，建议使用手动网格模式：2列 × 3行。");
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

function enhanceImages() {
  if (!canUseResults.value) return;
  enhancing.value = true;
  window.setTimeout(() => {
    enhancing.value = false;
    ElMessage.info("画质增强入口已预留，后续可接入 Real-ESRGAN。");
  }, 450);
}

function resetTool() {
  revokeLocalPreview();
  uploaded.value = null;
  selectedFile.value = null;
  uploadPromise.value = null;
  selectedFilename.value = "";
  detection.value = null;
  originalNaturalSize.value = { width: 0, height: 0 };
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

function removeCrop(id) {
  if (!detection.value?.crops) return;
  detection.value.crops = detection.value.crops.filter((crop) => crop.id !== id);
  detection.value.boxes = detection.value.boxes.filter((box) => box.id !== id);
}

function onOriginalLoad(event) {
  originalNaturalSize.value = {
    width: event.target.naturalWidth,
    height: event.target.naturalHeight
  };
}

function applyPreset(preset) {
  splitOptions.cols = preset.cols;
  splitOptions.rows = preset.rows;
  splitOptions.mode = "grid";
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

onBeforeUnmount(() => {
  revokeLocalPreview();
});
</script>

<template>
  <section class="ai-cropper-workbench">
    <div class="workbench-shell">
      <AiWorkbenchHeader
        :status-text="statusText"
        :task-count="cropResults.length"
        :can-download="canUseResults"
        :zip-url="zipDownloadUrl"
      />

      <div class="workbench-main">
        <WorkflowPanel
          :image-preview-url="imagePreviewUrl"
          :uploaded="uploaded"
          :selected-filename="selectedFilename"
          :upload-loading="uploadLoading"
          :detecting="detecting"
          :enhancing="enhancing"
          :can-split="canSplit"
          :can-use-results="canUseResults"
          :split-button-text="splitButtonText"
          :split-options="splitOptions"
          :boxes="boxes"
          :box-style="boxStyle"
          :before-upload="beforeUpload"
          :handle-upload="handleUpload"
          @detect="runDetect"
          @enhance="enhanceImages"
          @reset="resetTool"
          @preset="applyPreset"
          @original-load="onOriginalLoad"
        />

        <ResultWorkspace
          :crop-results="cropResults"
          :can-download="canUseResults"
          :zip-url="detection?.zipUrl || ''"
          @remove="removeCrop"
        />
      </div>
    </div>
  </section>
</template>
