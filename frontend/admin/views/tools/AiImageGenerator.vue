<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Download, MagicStick, Picture, Refresh, Scissor } from "@element-plus/icons-vue";
import {
  downloadUrl,
  generateAiImages,
  getAiStatus,
  optimizeAiPrompt,
  withImageToken
} from "../../api/tools/aiImageGenerator";

const STYLE_OPTIONS = ["Ozon高点击主图", "高端质感主图", "白底产品图", "详情页场景图"];
const RATIO_OPTIONS = ["3:4", "1:1", "4:5"];

const form = reactive({
  productName: "",
  vehicleModel: "",
  sellingPoints: "",
  style: "Ozon高点击主图",
  ratio: "3:4",
  imageCount: 1,
  userPrompt: "",
  autoCrop: true
});

const status = ref({ configured: false, textModel: "", imageModel: "" });
const loadingStatus = ref(false);
const optimizing = ref(false);
const generating = ref(false);
const stepActive = ref(0);
const promptResult = ref(null);
const taskResult = ref(null);
const errorMessage = ref("");

const generatedImages = computed(() => taskResult.value?.generatedImages || []);
const croppedImages = computed(() => taskResult.value?.croppedImages || []);
const zipUrl = computed(() => taskResult.value?.zipUrl || "");
const canSubmit = computed(() => status.value.configured && !generating.value);
const finalPrompt = computed(() => promptResult.value?.finalPrompt || "");

onMounted(loadStatus);

async function loadStatus() {
  loadingStatus.value = true;
  try {
    status.value = await getAiStatus();
  } catch (error) {
    errorMessage.value = error.message || "AI服务状态检查失败";
  } finally {
    loadingStatus.value = false;
  }
}

async function runOptimizePrompt() {
  if (!status.value.configured) {
    errorMessage.value = "OpenAI API Key 未配置";
    return;
  }
  optimizing.value = true;
  errorMessage.value = "";
  stepActive.value = 0;
  try {
    promptResult.value = await optimizeAiPrompt({ ...form });
    stepActive.value = 1;
    ElMessage.success("提示词已优化");
  } catch (error) {
    errorMessage.value = error.message || "提示词优化失败";
  } finally {
    optimizing.value = false;
  }
}

async function runGenerate() {
  if (!status.value.configured) {
    errorMessage.value = "OpenAI API Key 未配置";
    return;
  }
  if (!finalPrompt.value.trim()) {
    await runOptimizePrompt();
    if (!finalPrompt.value.trim()) return;
  }

  generating.value = true;
  errorMessage.value = "";
  taskResult.value = null;
  stepActive.value = 1;
  try {
    const result = await generateAiImages({
      finalPrompt: finalPrompt.value,
      ratio: form.ratio,
      imageCount: form.imageCount,
      autoCrop: form.autoCrop,
      cropMode: "auto"
    });
    taskResult.value = result;
    stepActive.value = form.autoCrop ? 3 : 2;
    if (result.cropStatus === "failed") {
      ElMessage.warning(result.cropMessage || "自动裁切失败");
    } else {
      ElMessage.success("图片生成完成");
    }
  } catch (error) {
    errorMessage.value = error.message || "图片生成失败";
    stepActive.value = 1;
  } finally {
    generating.value = false;
  }
}

function resetResult() {
  promptResult.value = null;
  taskResult.value = null;
  errorMessage.value = "";
  stepActive.value = 0;
}
</script>

<template>
  <section class="ai-generator-page">
    <header class="page-header">
      <div>
        <h1>AI套图生成中心</h1>
        <p>输入产品信息，自动生成电商套图并裁切成独立图片</p>
      </div>
      <el-button :icon="Refresh" :loading="loadingStatus" @click="loadStatus">刷新状态</el-button>
    </header>

    <el-alert
      v-if="!status.configured"
      type="warning"
      show-icon
      :closable="false"
      title="OpenAI API Key 未配置"
      description="请在后端 .env 中配置 OPENAI_API_KEY，前端不会读取或保存 API Key。"
    />
    <el-alert
      v-if="errorMessage"
      type="error"
      show-icon
      :closable="true"
      :title="errorMessage"
      @close="errorMessage = ''"
    />

    <div class="workspace">
      <el-card class="panel" shadow="never">
        <template #header>
          <span>生成参数</span>
        </template>
        <el-form label-position="top">
          <el-form-item label="产品名称">
            <el-input v-model="form.productName" placeholder="例如：TANK 300 后备箱垫" maxlength="120" show-word-limit />
          </el-form-item>
          <el-form-item label="车型">
            <el-input v-model="form.vehicleModel" placeholder="例如：TANK 300 / Chery Tiggo 8" maxlength="120" show-word-limit />
          </el-form-item>
          <el-form-item label="产品卖点">
            <el-input v-model="form.sellingPoints" type="textarea" :rows="4" placeholder="材质、防滑、防水、安装方式、适配范围等" maxlength="800" show-word-limit />
          </el-form-item>
          <div class="form-grid">
            <el-form-item label="生成风格">
              <el-select v-model="form.style">
                <el-option v-for="item in STYLE_OPTIONS" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item label="图片比例">
              <el-segmented v-model="form.ratio" :options="RATIO_OPTIONS" />
            </el-form-item>
            <el-form-item label="生成数量">
              <el-input-number v-model="form.imageCount" :min="1" :max="3" controls-position="right" />
            </el-form-item>
          </div>
          <el-form-item label="用户补充提示词">
            <el-input v-model="form.userPrompt" type="textarea" :rows="4" placeholder="补充背景、构图、套图模块、禁忌内容等" maxlength="1000" show-word-limit />
          </el-form-item>
          <el-form-item label="是否自动裁切">
            <el-switch v-model="form.autoCrop" active-text="自动裁切" inactive-text="只生成原图" />
          </el-form-item>
          <div class="actions">
            <el-button :icon="MagicStick" :loading="optimizing" :disabled="generating || !status.configured" @click="runOptimizePrompt">
              一键优化提示词
            </el-button>
            <el-button type="primary" :icon="Picture" :loading="generating" :disabled="!canSubmit" @click="runGenerate">
              开始生成
            </el-button>
            <el-button :icon="Refresh" :disabled="generating || optimizing" @click="resetResult">清空结果</el-button>
          </div>
        </el-form>
      </el-card>

      <el-card class="panel status-panel" shadow="never">
        <template #header>
          <span>任务状态</span>
        </template>
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="配置状态">{{ status.configured ? "已配置" : "未配置" }}</el-descriptions-item>
          <el-descriptions-item label="文本模型">{{ status.textModel || "-" }}</el-descriptions-item>
          <el-descriptions-item label="图片模型">{{ status.imageModel || "-" }}</el-descriptions-item>
        </el-descriptions>
        <el-steps direction="vertical" :active="stepActive" finish-status="success">
          <el-step title="填写提示词" />
          <el-step title="生成图片" />
          <el-step title="自动裁切" :description="form.autoCrop ? '' : '已关闭'" />
          <el-step title="预览下载" />
        </el-steps>
        <el-button
          type="success"
          :icon="Download"
          :disabled="!zipUrl"
          tag="a"
          :href="zipUrl ? downloadUrl(zipUrl) : undefined"
        >
          ZIP 下载
        </el-button>
      </el-card>
    </div>

    <el-card class="panel" shadow="never">
      <template #header>
        <span>优化后的提示词</span>
      </template>
      <el-empty v-if="!promptResult" description="点击一键优化提示词后显示" />
      <div v-else class="prompt-output">
        <el-input :model-value="promptResult.finalPrompt" type="textarea" :rows="7" readonly />
        <p><strong>负面提示词：</strong>{{ promptResult.negativePrompt }}</p>
        <p><strong>标题建议：</strong>{{ promptResult.titleSuggestion }}</p>
        <el-tag v-for="item in promptResult.detailPagePlan" :key="item" type="info">{{ item }}</el-tag>
      </div>
    </el-card>

    <el-card class="panel" shadow="never">
      <template #header>
        <span>生成图片预览</span>
      </template>
      <el-empty v-if="!generatedImages.length" description="生成后显示原始套图" />
      <div v-else class="image-grid">
        <div v-for="image in generatedImages" :key="image.path" class="image-card">
          <el-image :src="withImageToken(image.url)" fit="contain" :preview-src-list="generatedImages.map(item => withImageToken(item.url))" />
          <div class="image-card-footer">
            <span>{{ image.filename }}</span>
            <el-button size="small" :icon="Download" tag="a" :href="downloadUrl(image.url)">下载</el-button>
          </div>
        </div>
      </div>
    </el-card>

    <el-card class="panel" shadow="never">
      <template #header>
        <span>裁切后图片预览</span>
      </template>
      <el-alert
        v-if="taskResult?.cropStatus === 'failed'"
        type="warning"
        show-icon
        :closable="false"
        :title="taskResult.cropMessage || '自动裁切失败，可手动进入拆分器处理'"
      />
      <el-empty v-if="!croppedImages.length" description="自动裁切后显示独立图片" />
      <div v-else class="image-grid">
        <div v-for="image in croppedImages" :key="image.path" class="image-card">
          <el-image :src="withImageToken(image.url)" fit="contain" :preview-src-list="croppedImages.map(item => withImageToken(item.url))" />
          <div class="image-card-footer">
            <span>{{ image.filename }}</span>
            <el-button size="small" type="primary" :icon="Download" tag="a" :href="downloadUrl(image.url)">下载</el-button>
          </div>
        </div>
      </div>
    </el-card>
  </section>
</template>

<style scoped>
.ai-generator-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.page-header h1 {
  margin: 0 0 6px;
  font-size: 24px;
  line-height: 1.25;
  color: var(--erp-text);
}

.page-header p {
  margin: 0;
  color: var(--erp-text-secondary);
}

.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
  gap: 16px;
  align-items: start;
}

.panel {
  border-radius: 8px;
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) minmax(140px, 0.7fr);
  gap: 12px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.actions .el-button {
  margin-left: 0;
}

.status-panel :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.prompt-output {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prompt-output p {
  margin: 0;
  color: var(--erp-text);
}

.prompt-output .el-tag {
  align-self: flex-start;
  margin-right: 8px;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.image-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  background: var(--erp-surface-alt);
}

.image-card .el-image {
  width: 100%;
  height: 240px;
  border-radius: 6px;
  background: #fff;
}

.image-card-footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.image-card-footer span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--erp-text);
  font-size: 13px;
  font-weight: 600;
}

@media (max-width: 1080px) {
  .page-header,
  .actions {
    align-items: flex-start;
  }

  .page-header {
    flex-direction: column;
  }

  .workspace,
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
