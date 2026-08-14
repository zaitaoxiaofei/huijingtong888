<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { DocumentAdd, EditPen, Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { getOnboardingArticleHistory, listOnboardingArticles, saveOnboardingArticle } from "../../api/onboardingKnowledge";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";

const loading = ref(false);
const rows = ref([]);
const selectedId = ref(null);
const keyword = ref("");
const category = ref("全部");
const canEdit = ref(false);
const editorVisible = ref(false);
const historyVisible = ref(false);
const saving = ref(false);
const historyRows = ref([]);
const editor = reactive(emptyArticle());

const categories = computed(() => ["全部", ...new Set(rows.value.map((item) => item.category))]);
const filteredRows = computed(() => rows.value.filter((item) => {
  if (category.value !== "全部" && item.category !== category.value) return false;
  const search = keyword.value.trim().toLowerCase();
  return !search || [item.title, item.summary, item.content, item.audience].join(" ").toLowerCase().includes(search);
}));
const selectedArticle = computed(() => filteredRows.value.find((item) => item.id === selectedId.value) || filteredRows.value[0] || null);
const articleBlocks = computed(() => parseContent(selectedArticle.value?.content || ""));

function emptyArticle() {
  return { id: null, title: "", category: "入职基础", audience: "所有员工", summary: "", content: "", source_url: "", source_checked_at: "", status: "published", sort_order: 100 };
}

function parseContent(content) {
  return String(content).split(/\r?\n/).map((line) => {
    const text = line.trim();
    if (!text) return { type: "space", text: "" };
    if (text.startsWith("## ")) return { type: "h2", text: text.slice(3) };
    if (text.startsWith("# ")) return { type: "h1", text: text.slice(2) };
    if (/^[-*]\s/.test(text)) return { type: "li", text: text.slice(2) };
    if (/^\d+\.\s/.test(text)) return { type: "li", text: text.replace(/^\d+\.\s/, "") };
    return { type: "p", text };
  });
}

async function loadArticles() {
  loading.value = true;
  try {
    const result = await listOnboardingArticles();
    rows.value = result.rows || [];
    canEdit.value = Boolean(result.can_edit);
    if (!rows.value.some((item) => item.id === selectedId.value)) selectedId.value = rows.value[0]?.id || null;
  } catch (error) { ElMessage.error(error.message || "知识库加载失败"); }
  finally { loading.value = false; }
}

function selectArticle(item) { selectedId.value = item.id; }
function openEditor(article = null) {
  Object.assign(editor, emptyArticle(), article ? JSON.parse(JSON.stringify(article)) : {});
  editor.source_checked_at = editor.source_checked_at ? String(editor.source_checked_at).slice(0, 10) : "";
  editorVisible.value = true;
}
async function submitArticle() {
  saving.value = true;
  try {
    const result = await saveOnboardingArticle(editor);
    ElMessage.success(editor.id ? `已保存第 ${result.version} 版` : "文章已创建");
    editorVisible.value = false;
    await loadArticles();
    selectedId.value = Number(result.id);
  } catch (error) { ElMessage.error(error.message || "保存失败"); }
  finally { saving.value = false; }
}
async function openHistory(article) {
  try {
    historyRows.value = await getOnboardingArticleHistory(article.id);
    historyVisible.value = true;
  } catch (error) { ElMessage.error(error.message || "修改记录加载失败"); }
}

onMounted(loadArticles);
</script>

<template>
  <div class="knowledge-page" v-loading="loading">
    <header class="knowledge-hero">
      <div><span class="eyebrow">员工知识中心</span><h1>入职须知</h1><p>系统操作、Ozon 平台规则、物流履约和异常处理，都可以在这里查询。</p></div>
      <el-button v-if="canEdit" type="primary" :icon="DocumentAdd" @click="openEditor()">新建文章</el-button>
    </header>

    <div class="knowledge-toolbar">
      <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="搜索标题、操作步骤或常见问题" />
      <el-segmented v-model="category" :options="categories" />
    </div>

    <main class="knowledge-layout">
      <aside class="article-list">
        <button v-for="item in filteredRows" :key="item.id" :class="['article-item', { active: selectedArticle?.id === item.id }]" @click="selectArticle(item)">
          <span><el-tag size="small" effect="plain">{{ item.category }}</el-tag><el-tag v-if="item.status === 'draft'" size="small" type="warning">草稿</el-tag></span>
          <strong>{{ item.title }}</strong><small>{{ item.audience }} · 第 {{ item.version }} 版</small>
        </button>
        <el-empty v-if="!filteredRows.length" description="没有找到相关内容" />
      </aside>

      <article v-if="selectedArticle" class="article-content">
        <div class="article-head">
          <div><el-tag effect="plain">{{ selectedArticle.category }}</el-tag><h2>{{ selectedArticle.title }}</h2><p v-if="selectedArticle.summary">{{ selectedArticle.summary }}</p></div>
          <div v-if="canEdit" class="article-actions"><el-button @click="openHistory(selectedArticle)">修改记录</el-button><el-button type="primary" :icon="EditPen" @click="openEditor(selectedArticle)">编辑</el-button></div>
        </div>
        <div class="article-meta">
          <span>适用：{{ selectedArticle.audience }}</span>
          <span>最后修改：{{ selectedArticle.updated_by_name || selectedArticle.created_by_name || "系统初始化" }}</span>
          <span>{{ shanghaiDateTimeText(selectedArticle.updated_at, { assumeUtcWhenNaive: true }) }}（北京时间）</span>
        </div>
        <section class="prose">
          <template v-for="(block, index) in articleBlocks" :key="index">
            <h2 v-if="block.type === 'h1'">{{ block.text }}</h2><h3 v-else-if="block.type === 'h2'">{{ block.text }}</h3>
            <div v-else-if="block.type === 'li'" class="list-row"><span>•</span><p>{{ block.text }}</p></div>
            <p v-else-if="block.type === 'p'">{{ block.text }}</p><div v-else class="space" />
          </template>
        </section>
        <footer v-if="selectedArticle.source_url" class="source-box">规则来源：<a :href="selectedArticle.source_url" target="_blank" rel="noopener">查看原始资料</a><span v-if="selectedArticle.source_checked_at">核对日期：{{ selectedArticle.source_checked_at }}</span></footer>
      </article>
    </main>

    <el-drawer v-model="editorVisible" :title="editor.id ? '编辑知识文章' : '新建知识文章'" size="680px" destroy-on-close>
      <el-form label-position="top"><div class="form-grid"><el-form-item label="标题"><el-input v-model="editor.title" /></el-form-item><el-form-item label="分类"><el-select v-model="editor.category" allow-create filterable><el-option v-for="item in categories.slice(1)" :key="item" :label="item" :value="item" /></el-select></el-form-item><el-form-item label="适用岗位"><el-input v-model="editor.audience" /></el-form-item><el-form-item label="状态"><el-radio-group v-model="editor.status"><el-radio-button value="published">已发布</el-radio-button><el-radio-button value="draft">草稿</el-radio-button></el-radio-group></el-form-item></div>
        <el-form-item label="摘要"><el-input v-model="editor.summary" maxlength="500" show-word-limit /></el-form-item>
        <el-form-item label="正文"><el-input v-model="editor.content" type="textarea" :rows="20" placeholder="# 一级标题&#10;## 二级标题&#10;- 列表项&#10;普通段落" /><small class="editor-tip">支持 # 标题、## 小标题、- 列表和普通段落；不会执行 HTML 或脚本。</small></el-form-item>
        <div class="form-grid"><el-form-item label="规则来源链接（可选）"><el-input v-model="editor.source_url" /></el-form-item><el-form-item label="来源核对日期"><el-date-picker v-model="editor.source_checked_at" type="date" value-format="YYYY-MM-DD" /></el-form-item></div>
      </el-form><template #footer><el-button @click="editorVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="submitArticle">保存并记录修改人</el-button></template>
    </el-drawer>

    <el-dialog v-model="historyVisible" title="文章修改记录" width="680px"><el-table :data="historyRows" empty-text="当前还没有历史版本"><el-table-column prop="version" label="版本" width="90" /><el-table-column prop="changed_by_name" label="修改人"><template #default="{ row }">{{ row.changed_by_name || '系统' }}</template></el-table-column><el-table-column label="修改时间" width="210"><template #default="{ row }">{{ shanghaiDateTimeText(row.changed_at, { assumeUtcWhenNaive: true }) }}</template></el-table-column><el-table-column prop="status" label="保存前状态" width="110" /></el-table></el-dialog>
  </div>
</template>

<style scoped>
.knowledge-page{min-height:100%;padding:24px;background:#f4f7fb;color:#1b2733}.knowledge-hero{display:flex;align-items:flex-end;justify-content:space-between;padding:28px 32px;border-radius:18px;background:linear-gradient(125deg,#0f385b,#176b79);color:white;box-shadow:0 14px 34px rgba(15,56,91,.16)}.knowledge-hero h1{margin:5px 0 8px;font-size:30px}.knowledge-hero p{margin:0;color:#d7edf0}.eyebrow{font-size:12px;letter-spacing:.16em;color:#8fdae0}.knowledge-toolbar{display:flex;align-items:center;gap:16px;margin:18px 0}.knowledge-toolbar .el-input{max-width:460px}.knowledge-layout{display:grid;grid-template-columns:290px minmax(0,1fr);gap:18px;align-items:start}.article-list,.article-content{background:white;border:1px solid #e3e9ef;border-radius:14px}.article-list{padding:10px;max-height:calc(100vh - 245px);overflow:auto}.article-item{width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:14px;border:0;border-radius:10px;background:transparent;text-align:left;cursor:pointer;color:#2b3845}.article-item:hover{background:#f3f7f9}.article-item.active{background:#eaf4f5;box-shadow:inset 3px 0 #157581}.article-item small{color:#788694}.article-item span{display:flex;gap:5px}.article-content{padding:30px 38px;min-height:560px}.article-head{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #edf0f3;padding-bottom:20px}.article-head h2{font-size:27px;margin:12px 0 6px}.article-head p{margin:0;color:#687684}.article-actions{display:flex;align-items:flex-start;white-space:nowrap}.article-meta{display:flex;flex-wrap:wrap;gap:10px 24px;padding:14px 0;color:#758391;font-size:13px}.prose{max-width:850px;line-height:1.85;font-size:15px}.prose h2{font-size:22px;margin:22px 0 8px}.prose h3{font-size:17px;margin:20px 0 6px;color:#155e69}.prose p{margin:4px 0}.list-row{display:flex;gap:10px;padding-left:4px}.list-row>span{color:#16808b;font-weight:bold}.space{height:8px}.source-box{display:flex;gap:24px;margin-top:28px;padding:14px 16px;border-radius:9px;background:#f5f8fa;color:#657380}.source-box a{color:#157581}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.editor-tip{color:#7d8994}.el-select,.el-date-editor{width:100%}@media(max-width:900px){.knowledge-layout{grid-template-columns:1fr}.article-list{max-height:300px}.article-content{padding:22px}.knowledge-toolbar{align-items:stretch;flex-direction:column}.knowledge-toolbar .el-input{max-width:none}.knowledge-hero{align-items:flex-start;gap:18px;flex-direction:column}}
</style>
