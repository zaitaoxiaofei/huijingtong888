<script setup>
import { computed } from "vue";

const props = defineProps({
  templates: { type: Array, default: () => [] },
  modelValue: { type: Object, required: true },
  variantType: { type: String, default: "multi_model" }
});

const emit = defineEmits(["update:modelValue", "preview", "open-library"]);

const model = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value)
});

const usableTemplates = computed(() => {
  const scene = props.variantType === "logo_text_replace" ? "logo_text_replace" : "main_image_variant";
  return props.templates.filter((item) => item.enabled && (item.scene === scene || item.scene === "global_negative"));
});

function updateField(key, value) {
  model.value = { ...model.value, [key]: value };
}
</script>

<template>
  <section class="prompt-template-panel">
    <div class="panel-head">
      <div>
        <h3>配置提示词</h3>
        <p>不配置会使用通用策略；配置后，本次裂变素材都会参考这里生成。</p>
      </div>
      <el-button class="erp-btn-link" link type="primary" @click="$emit('open-library')">管理模板</el-button>
    </div>

    <el-select
      :model-value="model.templateId"
      filterable
      clearable
      placeholder="选择提示词模板，不选则使用通用策略"
      @update:model-value="updateField('templateId', $event)"
    >
      <el-option
        v-for="item in usableTemplates"
        :key="item.id"
        :label="`${item.name}${item.is_default ? ' · 默认' : ''}`"
        :value="item.id"
      >
        <div class="template-option">
          <strong>{{ item.name }}</strong>
          <span>{{ item.mode }} · {{ item.default_ratio }}</span>
        </div>
      </el-option>
    </el-select>

    <div class="prompt-controls">
      <el-segmented
        :model-value="model.ratio"
        :options="['3:4', '1:1', '4:5']"
        @update:model-value="updateField('ratio', $event)"
      />
      <el-input-number
        :model-value="model.imageCount"
        :min="1"
        :max="4"
        controls-position="right"
        @update:model-value="updateField('imageCount', $event)"
      />
    </div>

    <el-input
      :model-value="model.userPrompt"
      type="textarea"
      :rows="3"
      placeholder="本次生成补充要求，例如：只替换 logo 和车型文字，材质、颜色、光泽、构图保持一致"
      @update:model-value="updateField('userPrompt', $event)"
    />

    <div class="prompt-actions">
      <el-button class="erp-btn erp-btn-secondary" @click="$emit('preview')">预览 / 编辑提示词</el-button>
    </div>
  </section>
</template>

<style scoped>
.prompt-template-panel {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.05);
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.panel-head h3 {
  margin: 0;
  color: #101828;
  font-size: 15px;
}

.panel-head p {
  margin: 4px 0 0;
  color: #667085;
  font-size: 12px;
  line-height: 1.5;
}

.prompt-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.prompt-actions {
  display: flex;
  justify-content: flex-end;
}

.template-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.template-option span {
  color: #98a2b3;
  font-size: 12px;
}
</style>
