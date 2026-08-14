<script setup>
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ArrowDown, ArrowUp, Delete, Picture, Plus, Upload } from "@element-plus/icons-vue";
import ProductImagePreview from "../ProductImagePreview.vue";
import { uploadListingMedia, withImageToken } from "../../api/tools/imageCropper";

const props = defineProps({
  modelValue: {
    type: String,
    default: ""
  },
  title: {
    type: String,
    default: ""
  },
  visible: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(["update:modelValue", "update:visible", "save"]);

const fileInput = ref(null);
const uploading = ref(false);
const editor = reactive({
  blocks: []
});

const visibleProxy = computed({
  get: () => props.visible,
  set: (value) => emit("update:visible", value)
});

const previewImages = computed(() => editor.blocks.map((block) => displayBlockImage(block)).filter(Boolean));
const canSave = computed(() => editor.blocks.some((block) => block.image || block.title.trim() || block.text.trim()));

watch(
  () => props.visible,
  (visible) => {
    if (visible) loadFromJson(props.modelValue);
  },
  { immediate: true }
);

watch(
  () => props.modelValue,
  (value) => {
    if (props.visible) loadFromJson(value);
  }
);

function loadFromJson(value) {
  const parsedBlocks = parseOzonRichBlocks(value);
  editor.blocks.splice(0, editor.blocks.length, ...(parsedBlocks.length ? parsedBlocks : [emptyTextBlock()]));
}

function emptyTextBlock() {
  return { id: blockId(), type: "text", title: "", text: "", image: "", previewImage: "" };
}

function emptyImageBlock(url = "", previewImage = "") {
  return { id: blockId(), type: "image", title: "", text: "", image: url, previewImage };
}

function blockId() {
  return `rich-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function addTextBlock(index = editor.blocks.length - 1) {
  editor.blocks.splice(index + 1, 0, emptyTextBlock());
}

function addImageUrlBlock() {
  editor.blocks.push(emptyImageBlock());
}

function removeBlock(index) {
  if (editor.blocks.length <= 1) {
    editor.blocks.splice(0, 1, emptyTextBlock());
    return;
  }
  editor.blocks.splice(index, 1);
}

function moveBlock(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= editor.blocks.length) return;
  const [block] = editor.blocks.splice(index, 1);
  editor.blocks.splice(target, 0, block);
}

function triggerUpload() {
  fileInput.value?.click();
}

async function uploadFiles(event) {
  const files = Array.from(event.target?.files || []).filter((file) => file.type.startsWith("image/"));
  event.target.value = "";
  if (!files.length) {
    ElMessage.warning("请选择图片文件");
    return;
  }
  uploading.value = true;
  try {
    const uploaded = [];
    for (const file of files) {
      const result = await uploadListingMedia(file, { source_module: "listing_rich_content", role: "rich_content" });
      if (result.mediaType !== "image") throw new Error("请上传图片文件");
      const publishUrl = result.publishUrl || result.url || result.previewUrl || "";
      const previewUrl = result.previewUrl || result.localUrl || result.url || publishUrl;
      uploaded.push({ publishUrl, previewUrl });
    }
    uploaded
      .filter((item) => item.publishUrl || item.previewUrl)
      .forEach((item) => editor.blocks.push(emptyImageBlock(item.publishUrl || item.previewUrl, item.previewUrl)));
    ElMessage.success(`已插入 ${uploaded.length} 张图片`);
  } catch (error) {
    ElMessage.error(error.message || "图片上传失败");
  } finally {
    uploading.value = false;
  }
}

function saveRichContent() {
  if (!canSave.value) {
    ElMessage.warning("请先填写文字或插入图片");
    return;
  }
  const json = buildOzonRichContentJson(editor.blocks, props.title);
  emit("update:modelValue", json);
  emit("save", json);
  visibleProxy.value = false;
}

function parseOzonRichBlocks(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const blocks = [];
    const widgets = Array.isArray(parsed?.content) ? parsed.content : [];
    widgets.forEach((widget) => {
      (Array.isArray(widget?.blocks) ? widget.blocks : []).forEach((block) => {
        blocks.push({
          id: blockId(),
          type: block?.img?.src ? "image" : "text",
          title: richItemsText(block?.title?.items),
          text: richItemsText(block?.text?.items),
          image: String(block?.img?.src || block?.img?.srcMobile || "").trim(),
          previewImage: ""
        });
      });
    });
    return blocks.filter((block) => block.image || block.title || block.text);
  } catch {
    return [{ ...emptyTextBlock(), text }];
  }
}

function displayBlockImage(block = {}) {
  return withImageToken(String(block.previewImage || block.image || "").trim());
}

function richItemsText(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item?.content || "").trim())
    .filter(Boolean)
    .join("\n");
}

function buildOzonRichContentJson(blocks = [], title = "") {
  const ozonBlocks = blocks
    .map((block, index) => normalizeBlockForOzon(block, title, index))
    .filter(Boolean);
  return JSON.stringify({
    content: [
      {
        widgetName: "raShowcase",
        type: "billboard",
        blocks: ozonBlocks
      }
    ],
    version: 0.3
  }, null, 2);
}

function normalizeBlockForOzon(block, title, index) {
  const image = String(block.image || "").trim();
  const blockTitle = String(block.title || "").trim();
  const blockText = String(block.text || "").trim();
  if (!image && !blockTitle && !blockText) return null;
  const result = {
    imgLink: "",
    title: {
      items: blockTitle ? [{ type: "text", content: blockTitle }] : [],
      size: "size4",
      align: "left",
      color: "color1"
    },
    text: {
      size: "size2",
      align: "left",
      color: "color1",
      items: blockText ? splitParagraphs(blockText).map((content) => ({ type: "text", content })) : []
    }
  };
  if (image) {
    result.img = {
      src: image,
      srcMobile: image,
      alt: blockTitle || title || `Ozon rich content ${index + 1}`,
      position: "width_full",
      positionMobile: "width_full",
      widthMobile: 1024,
      heightMobile: 1536
    };
  }
  return result;
}

function splitParagraphs(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}
</script>

<template>
  <el-dialog
    v-model="visibleProxy"
    width="min(1280px, 96vw)"
    top="4vh"
    class="ozon-rich-dialog"
    destroy-on-close
  >
    <template #header>
      <div class="rich-dialog-header">
        <div>
          <strong>Ozon 图文富内容</strong>
          <span>按图片和文案顺序生成 Ozon 可识别的 raShowcase JSON</span>
        </div>
        <div class="rich-stats">
          <span>{{ editor.blocks.length }} 个内容块</span>
          <span>{{ previewImages.length }} 张图片</span>
        </div>
      </div>
    </template>

    <div class="rich-editor-shell">
      <div class="rich-editor-toolbar">
        <div class="toolbar-left">
          <el-button :icon="Plus" @click="addTextBlock()">文字块</el-button>
          <el-button :icon="Picture" @click="addImageUrlBlock">图片链接</el-button>
          <el-button type="primary" :icon="Upload" :loading="uploading" @click="triggerUpload">批量上传图片</el-button>
        </div>
        <span class="toolbar-hint">图片和文字会按左侧顺序展示，保存后自动写回 JSON 富内容。</span>
        <input ref="fileInput" class="hidden-file" type="file" accept="image/*" multiple @change="uploadFiles" />
      </div>

      <div class="rich-editor-layout">
        <div class="rich-block-list">
          <div v-for="(block, index) in editor.blocks" :key="block.id" class="rich-edit-block">
            <div class="block-tools">
              <strong>{{ index + 1 }}</strong>
              <div>
                <el-button :icon="ArrowUp" text circle :disabled="index === 0" @click="moveBlock(index, -1)" />
                <el-button :icon="ArrowDown" text circle :disabled="index === editor.blocks.length - 1" @click="moveBlock(index, 1)" />
                <el-button :icon="Delete" text circle type="danger" @click="removeBlock(index)" />
              </div>
            </div>

            <div class="block-image">
              <img v-if="displayBlockImage(block)" :src="displayBlockImage(block)" :alt="block.title || `block ${index + 1}`" />
              <div v-else class="block-image-empty">
                <Picture />
                <span>无图片</span>
              </div>
            </div>

            <div class="block-fields">
              <el-input v-model="block.title" placeholder="标题，可留空" />
              <el-input v-model="block.text" type="textarea" :rows="5" placeholder="正文，可分段填写" />
              <el-input v-model="block.image" placeholder="图片 URL，可批量上传后自动填入" />
            </div>
          </div>
        </div>

        <aside class="rich-live-preview">
          <div class="preview-head">
            <div>
              <h3>商品详情预览</h3>
              <span>模拟 Ozon 图文流，不影响最终 JSON 格式</span>
            </div>
            <div v-if="previewImages.length" class="preview-thumbs">
              <ProductImagePreview
                v-for="(url, index) in previewImages.slice(0, 5)"
                :key="`${index}-${url}`"
                :src="url"
                :preview-list="previewImages"
                :initial-index="index"
                size="default"
              />
            </div>
          </div>

          <div class="preview-scroll">
            <article v-for="(block, index) in editor.blocks" :key="`preview-${block.id}`" class="preview-block">
              <img v-if="displayBlockImage(block)" :src="displayBlockImage(block)" :alt="block.title || `rich image ${index + 1}`" />
              <h4 v-if="block.title">{{ block.title }}</h4>
              <p v-if="block.text">{{ block.text }}</p>
            </article>
            <el-empty v-if="!canSave" description="添加文字或图片后预览" :image-size="86" />
          </div>
        </aside>
      </div>
    </div>

    <template #footer>
      <div class="rich-dialog-footer">
        <span>保存后会替换当前 JSON 富内容字段。</span>
        <div>
          <el-button @click="visibleProxy = false">取消</el-button>
          <el-button type="primary" :disabled="!canSave" @click="saveRichContent">保存到上架记录</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.ozon-rich-dialog :deep(.el-dialog) {
  border-radius: 10px;
  overflow: hidden;
}

.ozon-rich-dialog :deep(.el-dialog__header) {
  margin: 0;
  padding: 20px 24px 16px;
  border-bottom: 1px solid #e6eaf2;
}

.ozon-rich-dialog :deep(.el-dialog__body) {
  padding: 0;
  background: #f6f8fb;
}

.ozon-rich-dialog :deep(.el-dialog__footer) {
  padding: 0;
  border-top: 1px solid #e6eaf2;
}

.rich-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding-right: 28px;
}

.rich-dialog-header > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.rich-dialog-header strong {
  color: #172033;
  font-size: 18px;
  line-height: 1.2;
}

.rich-dialog-header span,
.toolbar-hint,
.preview-head span,
.rich-dialog-footer span {
  color: #6b7280;
  font-size: 12px;
}

.rich-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.rich-stats span {
  border: 1px solid #dbe4f0;
  border-radius: 999px;
  padding: 5px 9px;
  background: #f8fafc;
  color: #475569;
}

.rich-editor-shell {
  display: flex;
  flex-direction: column;
  height: min(74vh, 760px);
}

.rich-editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 24px;
  background: #fff;
  border-bottom: 1px solid #e6eaf2;
}

.toolbar-left {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.hidden-file {
  display: none;
}

.rich-editor-layout {
  display: grid;
  grid-template-columns: minmax(520px, 1fr) minmax(360px, 430px);
  gap: 16px;
  min-height: 0;
  padding: 16px 24px 18px;
  flex: 1;
}

.rich-block-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding: 2px 6px 8px 2px;
}

.rich-edit-block {
  display: grid;
  grid-template-columns: 62px 148px minmax(0, 1fr);
  gap: 12px;
  border: 1px solid #dde6f2;
  border-radius: 8px;
  padding: 12px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.block-tools {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 170px;
  color: #64748b;
}

.block-tools strong {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: #eef4ff;
  font-weight: 700;
  color: #1d4ed8;
}

.block-tools > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.block-image {
  min-width: 0;
}

.block-image img,
.block-image-empty {
  width: 100%;
  height: 170px;
  border: 1px solid #e5eaf3;
  border-radius: 8px;
  background: #f8fafc;
}

.block-image img {
  display: block;
  object-fit: contain;
}

.block-image-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #94a3b8;
}

.block-image-empty svg {
  width: 24px;
  height: 24px;
}

.block-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rich-live-preview {
  border: 1px solid #e5eaf3;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid #edf1f7;
  background: #fbfcff;
}

.preview-head h3 {
  margin: 0 0 4px;
  font-size: 15px;
  color: #172033;
}

.preview-thumbs {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
  max-width: 166px;
  overflow: hidden;
}

.preview-thumbs :deep(.el-image) {
  width: 28px;
  height: 28px;
  border: 1px solid #edf1f7;
  border-radius: 6px;
  background: #f8fafc;
}

.preview-scroll {
  overflow: auto;
  min-height: 0;
  padding: 14px;
}

.preview-block {
  border: 1px solid #edf1f7;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 14px;
  background: #fff;
}

.preview-block:last-child {
  margin-bottom: 0;
}

.preview-block img {
  display: block;
  width: 100%;
  max-height: 520px;
  object-fit: contain;
  background: #f8fafc;
}

.preview-block h4 {
  margin: 12px 14px 6px;
  color: #1f2937;
  font-size: 15px;
  line-height: 1.45;
}

.preview-block p {
  margin: 0 14px 14px;
  color: #4b5563;
  line-height: 1.65;
  white-space: pre-wrap;
}

.rich-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 24px;
  background: #fff;
}

.rich-dialog-footer > div {
  display: flex;
  gap: 8px;
}

@media (max-width: 900px) {
  .rich-editor-shell {
    height: auto;
    max-height: none;
  }

  .rich-editor-layout {
    grid-template-columns: 1fr;
  }

  .rich-edit-block {
    grid-template-columns: 42px minmax(0, 1fr);
  }

  .block-image {
    grid-column: 2;
  }

  .block-tools {
    min-height: 0;
  }

  .rich-dialog-footer,
  .rich-dialog-header,
  .rich-editor-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
