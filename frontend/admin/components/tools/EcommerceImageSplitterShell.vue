<script setup>
import { ref } from "vue";
import { Crop, Delete, Download, MagicStick, Picture, Plus, Refresh, UploadFilled } from "@element-plus/icons-vue";

const props = defineProps({
  maxSizeMb: { type: Number, required: true },
  uploadLoading: { type: Boolean, default: false },
  detecting: { type: Boolean, default: false },
  enhancing: { type: Boolean, default: false },
  convertingRatio: { type: Boolean, default: false },
  processingAll: { type: Boolean, default: false },
  selectedFilename: { type: String, default: "" },
  originalFilename: { type: String, default: "" },
  currentTaskText: { type: String, default: "" },
  imagePreviewUrl: { type: String, default: "" },
  previewBoxes: { type: Array, default: () => [] },
  taskIdShort: { type: String, default: "" },
  canSplit: { type: Boolean, default: false },
  canProcessAll: { type: Boolean, default: false },
  canEnhance: { type: Boolean, default: false },
  canConvertRatio: { type: Boolean, default: false },
  canWatermark: { type: Boolean, default: false },
  canMergeSelected: { type: Boolean, default: false },
  watermarking: { type: Boolean, default: false },
  allCropsSelected: { type: Boolean, default: false },
  canDownloadZip: { type: Boolean, default: false },
  zipHref: { type: String, default: "" },
  cropResults: { type: Array, default: () => [] },
  resultPreviewList: { type: Array, default: () => [] },
  selectedCropIds: { type: Array, default: () => [] },
  beforeUpload: { type: Function, required: true },
  uploadRequest: { type: Function, required: true }
});

const previewVisible = ref(false);
const previewIndex = ref(0);

const emit = defineEmits([
  "history",
  "reset",
  "process-all",
  "split",
  "enhance",
  "convert-ratio",
  "watermark",
  "toggle-all-crops",
  "merge-selected",
  "toggle-crop-selection",
  "remove-crop"
]);

function openResultPreview(index) {
  if (!props.resultPreviewList.length) return;
  previewIndex.value = index;
  previewVisible.value = true;
}

function closeResultPreview() {
  previewVisible.value = false;
}
</script>

<template>
  <div class="splitter-v3-page">
    <div class="splitter-v3-container">
      <header class="hero-header">
        <div class="hero-copy">
          <div class="eyebrow">AI IMAGE WORKSPACE</div>
          <h1>电商套图拆分器</h1>
          <p>上传电商套图，自动识别白色间隔并拆分成独立图片。</p>
        </div>
        <div class="header-actions">
          <el-tag effect="dark" type="info">{{ currentTaskText }}</el-tag>
          <el-button :loading="watermarking" :disabled="!canWatermark" @click="emit('watermark')">添加水印</el-button>
          <el-upload
            action="#"
            :show-file-list="false"
            :http-request="uploadRequest"
            :before-upload="beforeUpload"
            accept=".jpg,.jpeg,.png,.webp"
          >
            <el-button size="large" :icon="Plus" :loading="uploadLoading">上传新图片</el-button>
          </el-upload>
          <el-button
            type="primary"
            size="large"
            :icon="Download"
            :disabled="!canDownloadZip"
            tag="a"
            :href="canDownloadZip ? zipHref : undefined"
          >
            下载 ZIP
          </el-button>
        </div>
      </header>

      <main class="workspace-grid">
        <aside class="control-panel">
          <el-card class="tool-card upload-card" shadow="never">
            <template #header>
              <div class="section-head">
                <div>
                  <strong>原图预览</strong>
                  <span>{{ selectedFilename || originalFilename || "未上传" }}</span>
                </div>
              </div>
            </template>

            <div
              v-if="imagePreviewUrl"
              class="preview-wrap"
              v-loading="uploadLoading"
              element-loading-text="正在上传"
            >
              <img :src="imagePreviewUrl" alt="原图预览" />
              <div class="preview-overlay">
                <div
                  v-for="box in previewBoxes"
                  :key="box.id"
                  class="preview-box"
                  :style="box.style"
                >
                  <span>{{ box.label }}</span>
                </div>
              </div>
            </div>

            <el-upload
              v-else
              drag
              action="#"
              :show-file-list="false"
              :http-request="uploadRequest"
              :before-upload="beforeUpload"
              accept=".jpg,.jpeg,.png,.webp"
              class="upload-dropzone"
            >
              <div class="dropzone-inner">
                <el-icon class="dropzone-icon"><UploadFilled /></el-icon>
                <strong>拖拽图片到这里</strong>
                <span>支持 JPG、JPEG、PNG、WEBP，单张不超过 {{ maxSizeMb }}MB</span>
              </div>
            </el-upload>

            <div class="upload-meta">
              <div class="meta-chip">
                <span>Task ID</span>
                <strong>{{ taskIdShort || "Local Preview" }}</strong>
              </div>
            </div>

            <div v-if="imagePreviewUrl" class="upload-actions">
              <el-button :icon="Refresh" @click="emit('reset')">重新上传</el-button>
            </div>
          </el-card>

          <el-card class="tool-card control-card" shadow="never">
            <template #header>
              <div class="section-head">
                <div>
                  <strong>拆分设置</strong>
                  <span>默认自动识别，保留最少操作</span>
                </div>
              </div>
            </template>

            <div class="mode-row">
              <span class="field-label">拆分模式</span>
              <el-select model-value="auto" disabled size="large" class="mode-select">
                <el-option label="自动识别" value="auto" />
              </el-select>
            </div>

            <div class="inline-stat hero-stat">
              系统会自动检测白色或浅色间隔，优先输出完整卡片区域。拆分后可继续增强画质，右侧结果会替换为增强后的图片。
            </div>

            <div class="action-strip">
              <el-button
                type="primary"
                size="large"
                :icon="MagicStick"
                :loading="processingAll"
                :disabled="!canProcessAll"
                @click="emit('process-all')"
              >
                一键拆分增强 3:4
              </el-button>
              <el-button
                size="large"
                :icon="Crop"
                :loading="detecting"
                :disabled="!canSplit"
                @click="emit('split')"
              >
                开始拆分
              </el-button>
              <el-button
                size="large"
                :loading="enhancing"
                :disabled="!canEnhance"
                @click="emit('enhance')"
              >
                增强画质
              </el-button>
              <el-button
                size="large"
                :loading="convertingRatio"
                :disabled="!canConvertRatio"
                @click="emit('convert-ratio')"
              >
                一键 3:4
              </el-button>
            </div>
          </el-card>
        </aside>

        <section class="result-panel">
          <div class="result-header">
            <div class="result-header-copy">
              <h2>拆分结果</h2>
              <p>结果按从上到下、从左到右排序</p>
            </div>
            <div class="result-actions-bar">
              <el-button :disabled="!cropResults.length" @click="emit('toggle-all-crops')">{{ allCropsSelected ? "取消全选" : "全选" }}</el-button>
              <el-button :disabled="!canMergeSelected" @click="emit('merge-selected')">合并为一张</el-button>
              <el-button
                type="primary"
                :icon="Download"
                :disabled="!canDownloadZip"
                tag="a"
                :href="canDownloadZip ? zipHref : undefined"
              >
                全部下载
              </el-button>
            </div>
          </div>

          <div v-if="!cropResults.length" class="empty-result">
            <div class="empty-result-inner">
              <el-icon><Picture /></el-icon>
              <strong>上传一张电商套图开始拆分</strong>
              <span>系统会自动按白色间隔识别卡片边界</span>
            </div>
          </div>

          <div v-else class="result-grid">
            <div
              v-for="(crop, index) in cropResults"
              :key="crop.id"
              class="result-card"
              :class="{ 'result-card-selected': selectedCropIds.includes(crop.id) }"
            >
              <div class="result-image-shell">
                <el-image
                  :src="crop.imageUrl"
                  fit="contain"
                  @click="openResultPreview(index)"
                />
                <button class="result-preview-hitbox" type="button" aria-label="预览大图" @click="openResultPreview(index)" />
                <div class="result-select-chip">
                  <el-checkbox
                    :model-value="selectedCropIds.includes(crop.id)"
                    @change="emit('toggle-crop-selection', crop.id)"
                  />
                </div>
                <div class="result-card-toolbar">
                  <el-button v-if="crop.downloadHref" circle :icon="Download" tag="a" :href="crop.downloadHref" />
                  <el-button circle type="danger" :icon="Delete" @click="emit('remove-crop', crop.id)" />
                </div>
              </div>
              <div class="result-card-footer">
                <div class="result-copy">
                  <strong>图片 {{ index + 1 }}</strong>
                  <span>{{ crop.filename }}</span>
                </div>
                <el-tag effect="plain">{{ crop.width }}x{{ crop.height }}</el-tag>
              </div>
            </div>
          </div>

          <el-image-viewer
            v-if="previewVisible"
            :url-list="resultPreviewList"
            :initial-index="previewIndex"
            :hide-on-click-modal="true"
            :teleported="true"
            @close="closeResultPreview"
          />
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.splitter-v3-page {
  min-height: calc(100vh - 56px);
  background: linear-gradient(180deg, #eef4fb 0%, #f7f9fc 100%);
  box-sizing: border-box;
  padding: 28px;
}

.splitter-v3-container {
  width: 100%;
  max-width: 1680px;
  margin: 0 auto;
}

.hero-header {
  min-height: 96px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 24px;
  padding: 0 4px;
}

.hero-copy {
  min-width: 0;
}

.hero-header h1 {
  margin: 6px 0 8px;
  color: #0f172a;
  font-size: 32px;
  font-weight: 800;
  line-height: 1.2;
}

.hero-header p {
  margin: 0;
  color: #64748b;
  font-size: 14px;
}

.eyebrow {
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(360px, 380px) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

.control-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.result-panel {
  min-width: 0;
  min-height: 720px;
  box-sizing: border-box;
  padding: 22px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
}

.tool-card {
  border: 1px solid rgba(148, 163, 184, 0.18) !important;
  border-radius: 22px !important;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 14px 40px rgba(15, 23, 42, 0.08) !important;
}

.tool-card :deep(.el-card__header) {
  padding: 18px 20px 0;
  border-bottom: 0;
}

.tool-card :deep(.el-card__body) {
  padding: 20px;
}

.section-head strong {
  display: block;
  color: #0f172a;
  font-size: 16px;
}

.section-head span {
  display: block;
  max-width: 310px;
  margin-top: 4px;
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-dropzone,
.preview-wrap {
  height: 340px;
  overflow: hidden;
  border-radius: 18px;
  background:
    radial-gradient(circle at top, rgba(96, 165, 250, 0.18), transparent 38%),
    linear-gradient(180deg, #0f172a 0%, #111827 100%);
}

.upload-dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed rgba(147, 197, 253, 0.55);
}

.upload-dropzone :deep(.el-upload),
.upload-dropzone :deep(.el-upload-dragger) {
  width: 100%;
  height: 100%;
}

.upload-dropzone :deep(.el-upload-dragger) {
  border: 0;
  background: transparent;
}

.dropzone-inner {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  gap: 8px;
  color: #bfdbfe;
  text-align: center;
}

.dropzone-icon {
  color: #93c5fd;
  font-size: 52px;
}

.dropzone-inner strong {
  font-size: 20px;
}

.dropzone-inner span {
  color: #94a3b8;
  font-size: 13px;
}

.preview-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-wrap img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.preview-box {
  position: absolute;
  border: 2px solid #22c55e;
  border-radius: 10px;
  background: rgba(34, 197, 94, 0.12);
}

.preview-box span {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  background: #dcfce7;
  color: #166534;
  font-size: 12px;
  font-weight: 700;
}

.upload-meta {
  margin-top: 16px;
}

.meta-chip {
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: #f8fafc;
}

.meta-chip span {
  display: block;
  color: #64748b;
  font-size: 12px;
}

.meta-chip strong {
  display: block;
  margin-top: 6px;
  color: #0f172a;
  font-size: 13px;
  line-height: 1.4;
  word-break: break-all;
}

.upload-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

.mode-row {
  display: grid;
  gap: 10px;
}

.field-label {
  color: #475569;
  font-size: 13px;
  font-weight: 600;
}

.mode-select {
  width: 100%;
}

.inline-stat {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #f8fafc;
  color: #475569;
  font-size: 13px;
}

.hero-stat {
  min-height: 88px;
  margin-top: 16px;
  border-color: #dbeafe;
  background: linear-gradient(180deg, rgba(239, 246, 255, 0.96), rgba(248, 250, 252, 0.98));
  color: #334155;
  line-height: 1.7;
}

.action-strip {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 18px;
}

.result-header {
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
}

.result-header h2 {
  margin: 0;
  color: #0f172a;
  font-size: 22px;
}

.result-header p {
  margin: 4px 0 0;
  color: #64748b;
  font-size: 13px;
}

.result-actions-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.empty-result {
  height: 600px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed #cbd5e1;
  border-radius: 18px;
  background:
    radial-gradient(circle at top, rgba(59, 130, 246, 0.08), transparent 36%),
    linear-gradient(180deg, #f8fafc 0%, #f3f7fc 100%);
  color: #94a3b8;
}

.empty-result-inner {
  display: grid;
  place-items: center;
  gap: 14px;
  text-align: center;
}

.empty-result-inner .el-icon {
  color: #94a3b8;
  font-size: 48px;
}

.empty-result-inner strong {
  color: #64748b;
  font-size: 18px;
  font-weight: 700;
}

.empty-result-inner span {
  color: #94a3b8;
  font-size: 13px;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 18px;
}

.result-card {
  overflow: hidden;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  background: #f8fafc;
  transition: all 0.2s ease;
}

.result-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 14px 35px rgba(15, 23, 42, 0.12);
}

.result-card-selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.result-image-shell {
  position: relative;
}

.result-image-shell :deep(.el-image) {
  width: 100%;
  display: block;
  cursor: zoom-in;
}

.result-image-shell :deep(.el-image__inner) {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: contain;
  background: #0f172a;
}

.result-preview-hitbox {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}

.result-card-toolbar {
  position: absolute;
  z-index: 3;
  top: 10px;
  right: 10px;
  display: flex;
  gap: 8px;
  opacity: 0;
  transform: translateY(-4px);
  transition: all 0.2s ease;
}

.result-card:hover .result-card-toolbar {
  opacity: 1;
  transform: translateY(0);
}

.result-select-chip {
  position: absolute;
  z-index: 2;
  top: 10px;
  left: 10px;
  padding: 4px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
}

.result-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
}

.result-copy {
  min-width: 0;
}

.result-copy strong {
  display: block;
  color: #0f172a;
  font-size: 14px;
}

.result-copy span {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1200px) {
  .workspace-grid {
    grid-template-columns: minmax(340px, 340px) minmax(0, 1fr);
    gap: 20px;
  }
}

@media (max-width: 760px) {
  .workspace-grid {
    grid-template-columns: 1fr;
  }

  .hero-header,
  .result-header {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .splitter-v3-page {
    padding: 16px;
  }

  .header-actions,
  .upload-actions,
  .action-strip,
  .result-actions-bar {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr;
  }
}
</style>
