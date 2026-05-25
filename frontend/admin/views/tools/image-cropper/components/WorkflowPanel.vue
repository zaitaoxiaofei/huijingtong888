<script setup>
import {
  ArrowDownToLine,
  Columns3,
  Grid3X3,
  ImagePlus,
  Maximize2,
  RefreshCw,
  Rows3,
  Scissors,
  Sparkles,
  Wand2,
  Zap
} from "lucide-vue-next";

defineProps({
  imagePreviewUrl: { type: String, default: "" },
  uploaded: { type: Object, default: null },
  selectedFilename: { type: String, default: "" },
  uploadLoading: { type: Boolean, default: false },
  detecting: { type: Boolean, default: false },
  enhancing: { type: Boolean, default: false },
  canSplit: { type: Boolean, default: false },
  canUseResults: { type: Boolean, default: false },
  splitButtonText: { type: String, required: true },
  splitOptions: { type: Object, required: true },
  boxes: { type: Array, default: () => [] },
  boxStyle: { type: Function, required: true },
  beforeUpload: { type: Function, required: true },
  handleUpload: { type: Function, required: true }
});

const emit = defineEmits(["detect", "enhance", "reset", "original-load", "preset"]);

const modes = [
  { value: "auto", title: "自动识别", desc: "识别横线、竖线和模块边界", icon: Wand2 },
  { value: "grid", title: "网格拆分", desc: "按行列稳定等分标准套图", icon: Grid3X3 },
  { value: "horizontal", title: "横向拆分", desc: "适合单列长详情图", icon: Rows3 },
  { value: "vertical", title: "纵向拆分", desc: "适合左右拼接图", icon: Columns3 }
];

const presets = [
  { label: "2×3", cols: 2, rows: 3 },
  { label: "3×3", cols: 3, rows: 3 },
  { label: "4×2", cols: 4, rows: 2 }
];
</script>

<template>
  <aside class="workflow-panel" v-loading="uploadLoading" element-loading-text="正在上传">
    <div class="tool-header">
      <div>
        <span>Tool Panel</span>
        <h2>图片处理工具栏</h2>
      </div>
      <button v-if="imagePreviewUrl" class="icon-button" type="button" title="重新上传" @click="emit('reset')">
        <RefreshCw :size="18" />
      </button>
    </div>

    <section class="tool-section">
      <div class="section-title">
        <span>01</span>
        <h3>图片输入</h3>
      </div>

      <div class="source-canvas">
        <template v-if="imagePreviewUrl">
          <img :src="imagePreviewUrl" alt="原图预览" @load="emit('original-load', $event)" />
          <div v-for="box in boxes" :key="box.id" class="crop-box" :style="boxStyle(box)">
            <span>{{ box.id.replace("crop-", "#") }}</span>
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
          class="neo-upload"
        >
          <div class="upload-icon-cloud">
            <ImagePlus :size="36" />
          </div>
          <strong>拖拽图片到这里</strong>
          <span>支持 JPG / PNG / WEBP，单张 25MB 内</span>
        </el-upload>
      </div>

      <div class="task-meta">
        <div>
          <span>当前任务</span>
          <strong>{{ uploaded?.originalFilename || selectedFilename || "等待上传" }}</strong>
        </div>
        <small>{{ uploaded?.taskId ? uploaded.taskId.slice(0, 8) : "local" }}</small>
      </div>
    </section>

    <section class="tool-section">
      <div class="section-title">
        <span>02</span>
        <h3>拆分模式</h3>
      </div>

      <div class="mode-cards">
        <button
          v-for="mode in modes"
          :key="mode.value"
          class="mode-card"
          :class="{ active: splitOptions.mode === mode.value }"
          type="button"
          @click="splitOptions.mode = mode.value"
        >
          <component :is="mode.icon" :size="22" />
          <strong>{{ mode.title }}</strong>
          <span>{{ mode.desc }}</span>
        </button>
      </div>

      <div v-if="splitOptions.mode === 'grid'" class="grid-control">
        <div class="control-row">
          <label>
            <span>Rows</span>
            <el-input-number v-model="splitOptions.rows" :min="1" :max="20" controls-position="right" />
          </label>
          <label>
            <span>Cols</span>
            <el-input-number v-model="splitOptions.cols" :min="1" :max="12" controls-position="right" />
          </label>
        </div>
        <label class="trim-control">
          <span>Trim Border</span>
          <el-input-number v-model="splitOptions.trimBorder" :min="0" :max="12" controls-position="right" />
        </label>
        <div class="preset-row">
          <button v-for="preset in presets" :key="preset.label" type="button" @click="emit('preset', preset)">
            {{ preset.label }}
          </button>
        </div>
      </div>
    </section>

    <section class="tool-section compact-section">
      <div class="section-title">
        <span>03</span>
        <h3>AI 工作流</h3>
      </div>
      <div class="tool-roadmap">
        <div><Sparkles :size="16" /> 画质增强</div>
        <div><Maximize2 :size="16" /> AI放大</div>
        <div><Wand2 :size="16" /> 一键白底</div>
        <div><ArrowDownToLine :size="16" /> Ozon模板</div>
      </div>
    </section>

    <div class="action-stack">
      <button class="primary-action" type="button" :disabled="!canSplit" @click="emit('detect')">
        <Scissors :size="20" />
        <span>{{ detecting ? "正在处理..." : splitButtonText }}</span>
        <Zap :size="17" />
      </button>
      <button class="secondary-action" type="button" :disabled="!canUseResults" @click="emit('enhance')">
        <Sparkles :size="18" />
        <span>{{ enhancing ? "增强准备中..." : "增强画质" }}</span>
      </button>
    </div>
  </aside>
</template>
