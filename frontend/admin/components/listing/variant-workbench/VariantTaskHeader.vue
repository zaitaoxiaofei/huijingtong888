<script setup>
import { computed } from "vue";
import { ArrowLeft, CircleCheck, MagicStick, VideoPause, Upload, DocumentChecked } from "@element-plus/icons-vue";
import ProductImagePreview from "../../ProductImagePreview.vue";

const props = defineProps({
  baseProduct: { type: Object, default: null },
  variantTypeLabel: { type: String, default: "" },
  taskStatus: { type: String, default: "draft" },
  generatedCount: { type: Number, default: 0 },
  writtenBackCount: { type: Number, default: 0 },
  generating: { type: Boolean, default: false },
  writingBack: { type: Boolean, default: false }
});

defineEmits(["save-draft", "start-generate", "pause-task", "write-back-all", "back"]);

const statusMeta = computed(() => ({
  draft: ["草稿", "info"],
  generating: ["批量生成中", "warning"],
  paused: ["已暂停", "warning"],
  success: ["生成完成", "success"],
  partial_success: ["部分完成", "warning"],
  failed: ["生成失败", "danger"]
}[props.taskStatus] || [props.taskStatus || "草稿", "info"]));

const baseImage = computed(() => props.baseProduct?.image_url || "");
const baseName = computed(() => props.baseProduct?.name || "请选择母商品");
const baseBrand = computed(() => props.baseProduct?.brand || inferBrand(props.baseProduct?.vehicle_model));
const baseModel = computed(() => props.baseProduct?.vehicle_model || "-");
const baseMaterial = computed(() => props.baseProduct?.material || "-");

function inferBrand(text) {
  const match = String(text || "").match(/\b(TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN)\b/i);
  return match ? match[1].toUpperCase() : "-";
}
</script>

<template>
  <header class="variant-task-header">
    <div class="base-strip">
      <ProductImagePreview
        :src="baseImage"
        :preview-list="baseImage ? [baseImage] : null"
        size="square"
        fit="cover"
        class="base-image"
      />
      <div class="base-copy">
        <span>AI 商品裂变工作台</span>
        <strong>{{ baseName }}</strong>
        <div class="base-facts">
          <em>品牌 {{ baseBrand }}</em>
          <em>车型 {{ baseModel }}</em>
          <em>材质 {{ baseMaterial }}</em>
        </div>
      </div>
    </div>

    <div class="task-metrics">
      <div>
        <span>裂变类型</span>
        <strong>{{ variantTypeLabel || "-" }}</strong>
      </div>
      <div>
        <span>任务状态</span>
        <el-tag :type="statusMeta[1]" effect="dark">{{ statusMeta[0] }}</el-tag>
      </div>
      <div>
        <span>已生成</span>
        <strong>{{ generatedCount }}</strong>
      </div>
      <div>
        <span>已回写</span>
        <strong>{{ writtenBackCount }}</strong>
      </div>
    </div>

    <div class="task-actions">
      <el-button :icon="DocumentChecked" @click="$emit('save-draft')">保存草稿</el-button>
      <el-button type="primary" :icon="MagicStick" :loading="generating" @click="$emit('start-generate')">开始生成</el-button>
      <el-button :icon="VideoPause" :disabled="!generating" @click="$emit('pause-task')">暂停任务</el-button>
      <el-button type="success" :icon="Upload" :loading="writingBack" @click="$emit('write-back-all')">批量回写</el-button>
      <el-button :icon="ArrowLeft" @click="$emit('back')">返回选品表</el-button>
    </div>
  </header>
</template>

<style scoped>
.variant-task-header {
  position: sticky;
  top: 0;
  z-index: 30;
  display: grid;
  grid-template-columns: minmax(340px, 1fr) auto auto;
  gap: 16px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(247, 250, 253, 0.94);
  backdrop-filter: blur(14px);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
}

.base-strip {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  min-width: 0;
}

.base-image {
  width: 64px;
  height: 64px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #dbe5ef;
}

.base-copy {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.base-copy > span {
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
}

.base-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #0f172a;
  font-size: 18px;
}

.base-facts,
.task-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.base-facts em {
  padding: 3px 7px;
  border-radius: 5px;
  background: #eaf2ff;
  color: #334155;
  font-size: 12px;
  font-style: normal;
}

.task-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(86px, 1fr));
  gap: 8px;
}

.task-metrics div {
  min-height: 58px;
  display: grid;
  gap: 4px;
  align-content: center;
  padding: 8px 10px;
  border-radius: 8px;
  background: #ffffff;
  border: 1px solid #dbe5ef;
}

.task-metrics span {
  color: #64748b;
  font-size: 12px;
}

.task-metrics strong {
  color: #0f172a;
  font-size: 16px;
}

.task-actions {
  justify-content: flex-end;
}

@media (max-width: 1500px) {
  .variant-task-header {
    grid-template-columns: 1fr;
  }

  .task-actions {
    justify-content: flex-start;
  }
}
</style>
