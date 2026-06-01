<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeft, Check, Delete, Refresh } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { withImageToken } from "../../api/tools/imageCropper";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const submitting = ref(false);
const deleting = ref(false);

const state = reactive({
  recordId: null,
  updated_at: "",
  shopId: null,
  shopName: "",
  status: "",
  payloadText: "",
  responseText: "",
  form: {
    name: "",
    offer_id: "",
    price: "",
    old_price: "",
    currency_code: "RUB",
    primary_image: "",
    imagesText: "",
    videoUrlsText: "",
    description_category_id: "",
    type_id: "",
    weight: "",
    depth: "",
    width: "",
    height: ""
  }
});

const imagePreview = computed(() => [state.form.primary_image, ...splitLines(state.form.imagesText)].filter(Boolean).slice(0, 8));

onMounted(loadDraft);

async function loadDraft() {
  const key = String(route.query.recordDraft || "").trim();
  const recordId = Number(route.query.recordId || 0) || null;
  if (!key && !recordId) return;
  loading.value = true;
  try {
    let draft = null;
    if (key) {
      const raw = sessionStorage.getItem(key);
      if (raw) draft = JSON.parse(raw);
    }
    if (!draft && recordId) {
      const row = await apiClient.get(`/api/listing/publish-records/${recordId}`, { noCache: true });
      if (row?.id) draft = buildDraftFromRow(row);
    }
    if (!draft) {
      ElMessage.warning("没有找到这条上架记录，请从上架记录列表重新打开");
      return;
    }
    applyDraft(draft);
  } catch (error) {
    ElMessage.error(error.message || "载入上架记录失败");
  } finally {
    loading.value = false;
  }
}

function buildDraftFromRow(row) {
  return {
    record_id: row.id,
    updated_at: row.updated_at || "",
    shop_id: row.shop_id,
    shop_name: row.shop_name,
    status: row.status,
    template: {
      source_raw: row.request || {},
      editable_payload: {
        source_raw: row.request || {}
      }
    },
    response: {
      response: row.response,
      error: row.error
    }
  };
}

function applyDraft(draft) {
  const sourceRaw = draft.template?.editable_payload?.source_raw || draft.template?.source_raw || draft.request || {};
  const item = sourceRaw.items?.[0] || {};
  state.recordId = Number(draft.record_id || draft.recordId || route.query.recordId || 0) || null;
  state.updated_at = draft.updated_at || draft.updatedAt || "";
  state.shopId = Number(draft.shop_id || draft.shopId || sourceRaw.shop_id || 0) || null;
  state.shopName = draft.shop_name || "";
  state.status = draft.status || "";
  state.payloadText = JSON.stringify(sourceRaw.items ? sourceRaw : { items: [item] }, null, 2);
  state.responseText = JSON.stringify(draft.response || {}, null, 2);
  state.form = {
    name: item.name || draft.template?.title || "",
    offer_id: item.offer_id || draft.template?.editable_payload?.sku || "",
    price: item.price || draft.template?.editable_payload?.price?.value || "",
    old_price: item.old_price || draft.template?.editable_payload?.price?.old_price || "",
    currency_code: item.currency_code || draft.template?.editable_payload?.price?.currency_code || "RUB",
    primary_image: item.primary_image || "",
    imagesText: (item.images || []).join("\n"),
    videoUrlsText: extractVideoUrls(item).join("\n"),
    description_category_id: item.description_category_id || draft.template?.editable_payload?.description_category_id || "",
    type_id: item.type_id || draft.template?.editable_payload?.type_id || "",
    weight: item.weight || "",
    depth: item.depth || "",
    width: item.width || "",
    height: item.height || ""
  };
}

function applyFormToPayload() {
  const payload = JSON.parse(state.payloadText || "{}");
  if (!Array.isArray(payload.items) || !payload.items[0]) payload.items = [{}];
  const item = payload.items[0];
  item.name = state.form.name;
  item.offer_id = state.form.offer_id;
  item.price = String(state.form.price || "");
  item.old_price = String(state.form.old_price || state.form.price || "");
  item.currency_code = state.form.currency_code || "RUB";
  item.primary_image = state.form.primary_image;
  item.images = splitLines(state.form.imagesText);
  item.description_category_id = state.form.description_category_id;
  item.type_id = state.form.type_id;
  item.weight = Number(state.form.weight || 0);
  item.depth = Number(state.form.depth || 0);
  item.width = Number(state.form.width || 0);
  item.height = Number(state.form.height || 0);
  setVideoUrls(item, splitLines(state.form.videoUrlsText));
  state.payloadText = JSON.stringify(payload, null, 2);
  return payload;
}

async function submitRecord() {
  if (!state.recordId) {
    ElMessage.warning("缺少上架记录 ID");
    return;
  }
  let payload;
  try {
    payload = applyFormToPayload();
  } catch {
    ElMessage.error("技术 JSON 格式不正确");
    return;
  }
  await ElMessageBox.confirm("确认按当前修改内容重新提交 Ozon？", "重新提交", {
    type: "warning",
    confirmButtonText: "重新提交",
    cancelButtonText: "取消"
  });
  submitting.value = true;
  try {
    const updated = await apiClient.post(`/api/listing/publish-records/${state.recordId}/retry`, {
      payload,
      updated_at: state.updated_at || ""
    });
    state.updated_at = updated.updated_at || "";
    state.status = updated.status;
    state.responseText = JSON.stringify({ response: updated.response, error: updated.error }, null, 2);
    ElMessage.success("已重新提交 Ozon，可回到上架记录稍后刷新状态");
  } finally {
    submitting.value = false;
  }
}

async function deleteRecord() {
  if (!state.recordId) return;
  await ElMessageBox.confirm("删除后记录不再显示，不会下架 Ozon 已上架商品。", "删除上架记录", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  deleting.value = true;
  try {
    await apiClient.delete(`/api/listing/publish-records/${state.recordId}`);
    ElMessage.success("上架记录已删除");
    router.push({ name: "listing-records" });
  } finally {
    deleting.value = false;
  }
}

function extractVideoUrls(item = {}) {
  return (item.complex_attributes || [])
    .flatMap((group) => group.attributes || [])
    .filter((attr) => Number(attr.id || 0) === 21841)
    .flatMap((attr) => attr.values || [])
    .map((value) => String(value.value || "").trim())
    .filter(Boolean);
}

function setVideoUrls(item, urls = []) {
  const others = (item.complex_attributes || []).filter((group) => {
    const attrs = group.attributes || [];
    return !attrs.some((attr) => [21841, 21837].includes(Number(attr.id || 0)));
  });
  if (urls.length) {
    others.push({
      attributes: [
        { complex_id: 100001, id: 21841, values: urls.map((url) => ({ value: url })) },
        { complex_id: 100001, id: 21837, values: urls.map((url, index) => ({ value: videoName(url, index) })) }
      ]
    });
  }
  item.complex_attributes = others;
}

function videoName(url, index) {
  try {
    return new URL(url).pathname.split("/").pop()?.replace(/\.[^.]+$/, "") || `video_${index + 1}`;
  } catch {
    return `video_${index + 1}`;
  }
}

function splitLines(value) {
  return String(value || "").split(/\r?\n|,|，/).map((item) => item.trim()).filter(Boolean);
}
</script>

<template>
  <div class="page-stack record-editor" v-loading="loading">
    <section class="workspace-header">
      <div>
        <h1>编辑上架</h1>
        <p>从上架记录带入原始请求，修改标题、价格、图片、视频或技术参数后重新提交。</p>
      </div>
      <div class="header-actions">
        <el-button class="erp-btn erp-btn-secondary" :icon="ArrowLeft" @click="router.push({ name: 'listing-records' })">返回记录</el-button>
        <el-button class="erp-btn erp-btn-danger" type="danger" plain :icon="Delete" :loading="deleting" @click="deleteRecord">删除记录</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Check" :loading="submitting" @click="submitRecord">重新提交 Ozon</el-button>
      </div>
    </section>

    <el-alert v-if="state.recordId" type="warning" :closable="false" show-icon :title="`正在编辑记录 #${state.recordId}`" />

    <section class="editor-grid">
      <div class="editor-panel">
        <h2>基础信息</h2>
        <el-form label-width="110px">
          <el-form-item label="标题"><el-input v-model="state.form.name" /></el-form-item>
          <el-form-item label="Offer ID"><el-input v-model="state.form.offer_id" /></el-form-item>
          <div class="form-row">
            <el-form-item label="售价"><el-input v-model="state.form.price" /></el-form-item>
            <el-form-item label="划线价"><el-input v-model="state.form.old_price" /></el-form-item>
            <el-form-item label="币种"><el-input v-model="state.form.currency_code" /></el-form-item>
          </div>
          <div class="form-row">
            <el-form-item label="类目 ID"><el-input v-model="state.form.description_category_id" /></el-form-item>
            <el-form-item label="类型 ID"><el-input v-model="state.form.type_id" /></el-form-item>
          </div>
          <div class="form-row">
            <el-form-item label="重量 g"><el-input v-model="state.form.weight" /></el-form-item>
            <el-form-item label="长 mm"><el-input v-model="state.form.depth" /></el-form-item>
            <el-form-item label="宽 mm"><el-input v-model="state.form.width" /></el-form-item>
            <el-form-item label="高 mm"><el-input v-model="state.form.height" /></el-form-item>
          </div>
        </el-form>
      </div>

      <div class="editor-panel">
        <h2>素材</h2>
        <el-form label-width="110px">
          <el-form-item label="主图 URL"><el-input v-model="state.form.primary_image" type="textarea" :rows="2" /></el-form-item>
          <el-form-item label="附图 URL"><el-input v-model="state.form.imagesText" type="textarea" :rows="7" placeholder="每行一个图片 URL" /></el-form-item>
          <el-form-item label="视频 URL"><el-input v-model="state.form.videoUrlsText" type="textarea" :rows="5" placeholder="每行一个视频公网 URL" /></el-form-item>
        </el-form>
        <div class="image-strip" v-if="imagePreview.length">
          <img v-for="url in imagePreview" :key="url" :src="withImageToken(url)" alt="" />
        </div>
      </div>
    </section>

    <section class="editor-panel">
      <div class="panel-title">
        <h2>技术 JSON</h2>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="applyFormToPayload">同步表单到 JSON</el-button>
      </div>
      <el-input v-model="state.payloadText" type="textarea" :rows="16" />
    </section>

    <section class="editor-panel">
      <h2>Ozon 返回 / 错误</h2>
      <el-input v-model="state.responseText" type="textarea" :rows="10" readonly />
    </section>
  </div>
</template>

<style scoped>
.record-editor { gap: 16px; }
.workspace-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.workspace-header h1, .editor-panel h2 { margin: 0; }
.workspace-header p { margin: 6px 0 0; color: var(--el-text-color-secondary); }
.header-actions, .panel-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.editor-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.editor-panel { border: 1px solid #e5eaf3; border-radius: 8px; background: #fff; padding: 16px; }
.editor-panel h2 { font-size: 16px; margin-bottom: 14px; }
.form-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.form-row:has(.el-form-item:nth-child(4)) { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.image-strip { display: flex; gap: 8px; flex-wrap: wrap; margin-left: 110px; }
.image-strip img { width: 72px; height: 72px; object-fit: cover; border: 1px solid #edf1f7; border-radius: 8px; background: #f8fafc; }
@media (max-width: 1100px) {
  .workspace-header, .header-actions { flex-direction: column; align-items: stretch; }
  .editor-grid, .form-row { grid-template-columns: 1fr; }
  .image-strip { margin-left: 0; }
}
</style>
