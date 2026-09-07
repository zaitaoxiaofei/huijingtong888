<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Boxes, CalendarDays, CheckCircle2, ChevronDown, CircleCheck, ClipboardCheck, Clock3, Edit3, ImagePlus, Lightbulb, LayoutDashboard, Link2, ListTodo, PackagePlus, Plus, RefreshCw, Rocket, Search, ShoppingCart, Trash2, TrendingUp, TriangleAlert, Truck, Upload, Users } from "lucide-vue-next";
import { apiClient } from "../../utils/api";
import { uploadListingMedia } from "../../api/tools/imageCropper";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";
import ProductCreateEditDialog from "../../components/inventory/ProductCreateEditDialog.vue";

const router = useRouter();
const stages = [
  { value: "idea", label: "待完善产品资料", short: "待完善" }, { value: "research", label: "调研与核价", short: "调研核价" },
  { value: "supplier", label: "采购与打样", short: "采购打样" }, { value: "content", label: "素材与上架准备", short: "素材准备" },
  { value: "listing", label: "草稿待发布", short: "待发布" }, { value: "listed", label: "已上架验证", short: "已上架" }
];
const tabs = [
  { value: "tasks", label: "任务中心", icon: ListTodo }, { value: "ideas", label: "灵感列表", icon: Lightbulb },
  { value: "products", label: "开发产品", icon: Boxes }, { value: "dashboard", label: "开发总览", icon: LayoutDashboard },
  { value: "analytics", label: "裂变效果", icon: TrendingUp }, { value: "bindings", label: "SKU库存关联", icon: Link2 }
];
const activeTab = ref("tasks");
const loading = ref(false);
const developmentDataLoaded = ref(false);
let developmentDataPromise = null;
const createVisible = ref(false);
const attachVisible = ref(false);
const attachProductId = ref(null);
const attachOptions = ref([]);
const draftLinkVisible = ref(false);
const draftLinkIdea = ref(null);
const draftLinkIds = ref([]);
const draftLinkOptions = ref([]);
const draftLinkKeyword = ref("");
const draftLinkDateRange = ref([]);
const draftLinkLoading = ref(false);
const draftLinkExistingIds = ref(new Set());
const draftLinkPage = ref(1);
const draftLinkPageSize = 10;
const draftLinkTotal = ref(0);
const editVisible = ref(false);
const current = ref(null);
const keyword = ref("");
const projectFilter = ref("all");
const selectedProject = ref(null);
const people = ref([]);
const suppliers = ref([]);
const logisticsRules = ref([]);
const projects = ref([]);
const products = ref([]);
const categoryProjects = ref([]);
const categoryProducts = ref([]);
const categoryProductsLoading = ref(false);
const listingDraftRows = ref([]);
const categoriesLoaded = ref(false);
const draftsLoaded = ref(false);
const creationResourcesLoaded = ref(false);
const ideas = ref([]);
const ideaVisible = ref(false);
const ideaSaving = ref(false);
const ideaImageUploading = ref(false);
const ideaFileInput = ref(null);
const developingIdea = ref(null);
const ideaForm = reactive({ id: null, title: "", image_url: "", source_url: "", note: "", urgency: 5, importance: 5,
  assignee_person_id: null, target_product_count: 0, development_due_at: "" });
const tasks = ref([]);
const bindings = ref([]);
const bindingSummary = ref({});
const bindingLoading = ref(false);
const bindingsLoaded = ref(false);
const bindingStatus = ref("all");
const taskKeyword = ref("");
const taskStatus = ref("all");
const taskType = ref("all");
const taskRange = ref("week");
const taskAnchor = ref(new Date());
const taskCustomRange = ref([]);
const taskListExpanded = ref(true);
const taskPage = ref(1);
const taskPageSize = ref(5);
const taskVisible = ref(false);
const taskSaving = ref(false);
const taskDetailLoading = ref(false);
const taskOperationalDetails = ref({ rows: [], summary: {} });
const taskDetailReason = ref("all");
const taskDetailPage = ref(1);
const taskDetailPageSize = 6;
const taskForm = reactive({ id: null, title: "", owner_person_id: null, project_id: null, candidate_id: null, type: "custom", period: "week", status: "todo", priority: "medium", target: 4, done: 0, unit: "步", start_at: "", due_at: "", deliverable: "", result: "", automation_key: "" });
const bindVisible = ref(false);
const bindRecord = ref(null);
const bindProductId = ref(null);
const bindProductOptions = ref([]);
const metaForm = reactive({ project_id: null, status: "idea", priority: "medium", planned_listing_at: "", note: "", decision_note: "" });

const filteredProducts = computed(() => products.value.filter((row) => {
  if (projectFilter.value !== "all" && Number(row.project_id) !== Number(projectFilter.value)) return false;
  const query = keyword.value.trim().toLowerCase();
  return !query || [row.title, row.product_code, row.category, row.brand, row.vehicle_model, row.owner_name, row.project_name]
    .some((value) => String(value || "").toLowerCase().includes(query));
}));
const filteredDraftLinkOptions = computed(() => {
  const query = draftLinkKeyword.value.trim().toLowerCase();
  if (!query) return draftLinkOptions.value;
  return draftLinkOptions.value.filter((draft) => [draft.product_name, draft.internal_code, draft.vehicle_brand, draft.vehicle_model, draft.id]
    .some((value) => String(value || "").toLowerCase().includes(query)));
});
const selectableDraftLinkOptions = computed(() => filteredDraftLinkOptions.value.filter((draft) => !draftLinkExistingIds.value.has(Number(draft.id))));
function draftCardImage(draft = {}) {
  return draft.effective_images?.[0] || draft.source_images?.[0] || draft.draft_template_primary_image || "";
}
const selectedProjectProducts = computed(() => products.value.filter((row) => Number(row.project_id) === Number(selectedProject.value?.id))
  .sort((a, b) => String(a.brand || "未填品牌").localeCompare(String(b.brand || "未填品牌"), "zh-CN")));
const displayedProjects = computed(() => [...categoryProjects.value].sort((a, b) => Number(b.product_count || 0) - Number(a.product_count || 0) || String(a.name).localeCompare(String(b.name), "zh-CN")));
const projectDetailProducts = computed(() => {
  if (!selectedProject.value) return [];
  if (!selectedProject.value.virtual) return selectedProjectProducts.value;
  return categoryProducts.value.map((row) => ({
    ...row, product_id: row.id, title: row.name, category: row.inventory_category, brand: row.vehicle_brand, status: "idea",
    stock: Number(row.stock || row.current_stock || 0), sku_count: Number(row.sku_count || 0)
  })).sort((a, b) => String(a.brand || "未填品牌").localeCompare(String(b.brand || "未填品牌"), "zh-CN"));
});
const activeProducts = computed(() => products.value.filter((row) => !["listed", "rejected", "paused"].includes(row.status)));
const listedProducts = computed(() => products.value.filter((row) => row.status === "listed"));
const draftProducts = computed(() => products.value.filter((row) => row.status === "listing"));
const taskDone = computed(() => tasks.value.filter((row) => row.status === "done").length);
const methodStats = computed(() => ["manual", "ai_fission"].map((method) => {
  const draftRows = listingDraftRows.value.filter((row) => method === "ai_fission" ? row.development_type === "fission" : row.development_type !== "fission");
  const rows = bindings.value.filter((row) => row.creation_method === method && ["imported", "published", "success"].includes(row.publish_status));
  const ordered = rows.filter((row) => Number(row.order_count || 0) > 0);
  return { method, label: method === "ai_fission" ? "AI 裂变" : "人工草稿", drafts: draftRows.length, published: Math.max(rows.length, draftRows.filter((row) => ["published", "success", "imported"].includes(row.publish_status)).length), ordered: ordered.length,
    orderRate: rows.length ? Math.round(ordered.length / rows.length * 1000) / 10 : 0,
    orders: rows.reduce((sum, row) => sum + Number(row.order_count || 0), 0), quantity: rows.reduce((sum, row) => sum + Number(row.sales_quantity || 0), 0) };
}));
const filteredTasks = computed(() => tasks.value.filter((row) => {
  if (taskStatus.value !== "all" && row.status !== taskStatus.value) return false;
  if (taskType.value !== "all" && row.type !== taskType.value) return false;
  const query = taskKeyword.value.trim().toLowerCase();
  return !query || [row.title, row.name, row.project_name, row.assignee_name, row.owner_name, row.deliverable]
    .some((value) => String(value || "").toLowerCase().includes(query));
}));
const taskTypeOptions = [
  { value: "all", label: "全部类型", icon: ListTodo }, { value: "product_development", label: "开发产品", icon: Boxes },
  { value: "procurement_daily", label: "采购任务", icon: ShoppingCart }, { value: "shipping_daily", label: "每日发货", icon: Truck },
  { value: "custom", label: "自定义", icon: ClipboardCheck }
];
const taskRangeOptions = [{ value: "week", label: "本周" }, { value: "month", label: "月度" }, { value: "quarter", label: "季度" }, { value: "year", label: "年度" }, { value: "custom", label: "自定义" }];
const taskRangeDates = computed(() => {
  if (taskRange.value === "custom" && taskCustomRange.value?.length === 2) return taskCustomRange.value.map((value) => new Date(`${value}T00:00:00+08:00`));
  const anchor = new Date(taskAnchor.value); const year = anchor.getFullYear(); const month = anchor.getMonth();
  if (taskRange.value === "week") { const day = anchor.getDay() || 7; const start = new Date(year, month, anchor.getDate() - day + 1); return [start, new Date(year, month, anchor.getDate() - day + 7)]; }
  if (taskRange.value === "month") return [new Date(year, month, 1), new Date(year, month + 1, 0)];
  if (taskRange.value === "quarter") { const startMonth = Math.floor(month / 3) * 3; return [new Date(year, startMonth, 1), new Date(year, startMonth + 3, 0)]; }
  return [new Date(year, 0, 1), new Date(year, 11, 31)];
});
const taskRangeLabel = computed(() => `${shortDate(taskRangeDates.value[0])} - ${shortDate(taskRangeDates.value[1])}`);
const visibleTasks = computed(() => filteredTasks.value.filter((row) => {
  const point = taskDate(row); if (!point) return taskRange.value === "week";
  return point >= dayStart(taskRangeDates.value[0]) && point <= dayEnd(taskRangeDates.value[1]);
}));
const timelineTasks = computed(() => {
  const occupied = new Map();
  return visibleTasks.value.map((row) => {
    const timelineX = taskTimelineX(row); const progress = taskProgress(row); const bucket = `${Math.round(timelineX / 5)}-${Math.round(progress / 10)}`; const lane = occupied.get(bucket) || 0; occupied.set(bucket, lane + 1);
    return { ...row, timelineX, timelineY: Math.max(6, Math.min(94, progress + lane * 11)), timelineLane: lane };
  });
});
const timelineGroups = computed(() => {
  const groups = new Map();
  for (const row of timelineTasks.value) {
    const key = `${Math.round(row.timelineX)}-${taskProgress(row)}`;
    if (!groups.has(key)) groups.set(key, { ...row, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
});
const paginatedTasks = computed(() => visibleTasks.value.slice((taskPage.value - 1) * taskPageSize.value, taskPage.value * taskPageSize.value));
const taskMetrics = computed(() => ({ total: visibleTasks.value.length, done: visibleTasks.value.filter((row) => row.status === "done" && !taskOverdue(row)).length,
  doing: visibleTasks.value.filter((row) => ["todo", "doing", "review"].includes(row.status) && !taskOverdue(row)).length, overdue: visibleTasks.value.filter(taskOverdue).length }));
const taskDetailFilteredRows = computed(() => (taskOperationalDetails.value.rows || []).filter((row) => taskDetailReason.value === "all" || row.reason === taskDetailReason.value));
const taskDetailRows = computed(() => taskDetailFilteredRows.value.slice((taskDetailPage.value - 1) * taskDetailPageSize, taskDetailPage.value * taskDetailPageSize));
const taskAxisLabels = computed(() => {
  const [start, end] = taskRangeDates.value; const count = taskRange.value === "year" ? 12 : taskRange.value === "quarter" ? 6 : taskRange.value === "month" ? 5 : 7;
  return Array.from({ length: count }, (_, index) => { const ratio = count === 1 ? 0 : index / (count - 1); const date = new Date(start.getTime() + (end.getTime() - start.getTime()) * ratio); return taskRange.value === "year" ? `${date.getMonth() + 1}月` : `${date.getMonth() + 1}/${date.getDate()}`; });
});
const sortedIdeas = computed(() => [...ideas.value].sort((a, b) => Number(b.urgency || 0) - Number(a.urgency || 0)
  || Number(b.importance || 0) - Number(a.importance || 0) || Number(b.id || 0) - Number(a.id || 0)));
const developmentIdeas = computed(() => sortedIdeas.value.filter((row) => row.development_started_at
  && row.assignee_person_id && Number(row.target_product_count || 0) > 0 && row.development_due_at));
const personById = computed(() => new Map(people.value.map((person) => [Number(person.id), person])));

function stageLabel(value) { return stages.find((item) => item.value === value)?.label || value || "待完善"; }
function stageIndex(value) { return Math.max(0, stages.findIndex((item) => item.value === value)); }
function productImage(row) { return row.image_url || (row.product_id ? `/api/products/${row.product_id}/image?thumb=1&w=240` : ""); }
function personAvatar(personId) { return personById.value.get(Number(personId))?.avatar_url || ""; }
function personInitial(name) { return String(name || "?").trim().slice(0, 1); }
function dayStart(value) { const date = new Date(value); date.setHours(0, 0, 0, 0); return date; }
function dayEnd(value) { const date = new Date(value); date.setHours(23, 59, 59, 999); return date; }
function shortDate(value) { const date = new Date(value); return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`; }
function taskDate(row) { const value = row.due_at || row.start_at || row.created_at; return value ? new Date(String(value).length <= 10 ? `${value}T21:00:00+08:00` : value) : null; }
function taskProgress(row) { const target = Number(row.target || 0); if (!target) return row.status === "done" ? 100 : 0; return Math.min(100, Math.round(Number(row.done || 0) / target * 100)); }
function taskOverdue(row) { const due = taskDate({ due_at: row.due_at }); return row.status !== "done" && Boolean(due && due.getTime() < Date.now()); }
function taskTone(row) { if (["closed", "cancelled"].includes(row.status)) return "closed"; if (taskOverdue(row) || row.status === "delayed") return "overdue"; if (row.status === "done") return "done"; const due = taskDate({ due_at: row.due_at }); if (due && due.getTime() - Date.now() < 3 * 86400000) return "risk"; return "doing"; }
function taskToneLabel(row) { return ({ done: "按时完成", doing: row.status === "todo" ? "待开始" : "进行中", risk: "有风险", overdue: "已超时", closed: "已关闭" })[taskTone(row)]; }
function taskTimelineX(row) { const point = taskDate(row); if (!point) return 2; const [start, end] = taskRangeDates.value; return Math.max(2, Math.min(98, (point - start) / Math.max(1, end - start) * 100)); }
function taskTypeMeta(row) { return taskTypeOptions.find((item) => item.value === row?.type) || taskTypeOptions[4]; }
function taskProgressText(row) { return `${taskProgress(row)}%（${Number(row.done || 0)} / ${Number(row.target || 0)} ${row.unit || '项'}）`; }
function taskRelated(row) { try { return JSON.parse(row?.related || "{}"); } catch { return {}; } }
function isDailyOperationalTask(row) { return ["procurement_daily", "shipping_daily"].includes(row?.type); }
function taskStatisticsDate(row) { return taskRelated(row).statistics_date || "-"; }
function taskStatisticsText(row) { const related = taskRelated(row); if (row.type === "procurement_daily") return `共 ${related.total ?? row.target ?? 0} 单，已采购 ${related.completed ?? row.done ?? 0} 单`; if (row.type === "shipping_daily") return `共 ${related.total ?? row.target ?? 0} 单，已打印 ${related.printed ?? 0} 单，已运输 ${related.transported ?? 0} 单`; return taskProgressText(row); }
function taskReasonTone(row) { return row.warning ? "warning" : ["not_procured", "insufficient_stock"].includes(row.reason) ? "blocked" : "waiting"; }
function taskOrderTimeText(row) { return row?.ordered_at ? shanghaiDateTimeText(row.ordered_at) : "未记录出单时间"; }
function taskReasonFilters() { const summary = taskOperationalDetails.value.summary || {}; return [{ value: "all", label: "全部", count: summary.total || 0 }, { value: "not_procured", label: "尚未采购", count: summary.not_procured || 0 }, { value: "procurement_in_transit", label: "采购在途", count: summary.procurement_in_transit || 0 }, { value: "insufficient_stock", label: "库存不足", count: summary.insufficient_stock || 0 }, { value: "stock_ready_unprinted", label: "有库存未打印", count: summary.stock_ready_unprinted || 0 }, { value: "printed_not_transported", label: "已打印未运输", count: summary.printed_not_transported || 0 }].filter((item) => item.value === "all" || item.count); }
async function loadTaskOperationalDetails(row) { taskOperationalDetails.value = { rows: [], summary: {} }; taskDetailReason.value = "all"; taskDetailPage.value = 1; if (!isDailyOperationalTask(row) || !row.id) return; taskDetailLoading.value = true; try { taskOperationalDetails.value = await apiClient.get(`/api/team/tasks/${row.id}/operational-details`, { noCache: true }); } catch (error) { ElMessage.error(error.message || "任务明细加载失败"); } finally { taskDetailLoading.value = false; } }
function enterTaskWorkspace(row) { const related = taskRelated(row); if (row.type === "product_development") activeTab.value = "products"; else router.push({ path: related.route || (row.type === "procurement_daily" ? "/procurement/workspace" : "/orders"), query: related.date ? { date: related.date } : {} }); }
function setCustomProgress(percent) { taskForm.target = 4; taskForm.done = ({ 0: 0, 25: 1, 50: 2, 100: 4 })[percent]; taskForm.status = percent === 100 ? "done" : percent ? "doing" : "todo"; }
function moveTaskRange(direction) { const anchor = new Date(taskAnchor.value); const unit = taskRange.value === "year" ? "FullYear" : taskRange.value === "quarter" ? "Month" : taskRange.value === "month" ? "Month" : "Date"; const amount = taskRange.value === "year" ? direction : taskRange.value === "quarter" ? direction * 3 : taskRange.value === "month" ? direction : direction * 7; anchor[`set${unit}`](anchor[`get${unit}`]() + amount); taskAnchor.value = anchor; }

async function loadData() {
  loading.value = true;
  try {
    const [personRows, projectRows, productRows, taskRows, ideaRows] = await Promise.all([
      apiClient.get("/api/people", { noCache: true }).catch(() => []),
      apiClient.get("/api/team/development-projects", { noCache: true }).catch(() => []),
      apiClient.get("/api/team/development-candidates", { noCache: true }).catch(() => []),
      apiClient.get("/api/team/tasks", { noCache: true }).catch(() => []),
      apiClient.get("/api/team/development-ideas", { noCache: true }).catch(() => [])
    ]);
    people.value = Array.isArray(personRows) ? personRows : personRows?.rows || [];
    projects.value = Array.isArray(projectRows) ? projectRows : [];
    products.value = Array.isArray(productRows) ? productRows : [];
    tasks.value = Array.isArray(taskRows) ? taskRows : [];
    ideas.value = Array.isArray(ideaRows) ? ideaRows : [];
    developmentDataLoaded.value = true;
  } catch (error) { ElMessage.error(error.message || "产品开发数据加载失败"); }
  finally { loading.value = false; }
}
async function loadTaskCenterData() {
  loading.value = true;
  try {
    const [personRows, taskRows] = await Promise.all([
      apiClient.get("/api/people", { noCache: true }).catch(() => []),
      apiClient.get("/api/team/tasks", { noCache: true }).catch(() => [])
    ]);
    people.value = Array.isArray(personRows) ? personRows : personRows?.rows || [];
    tasks.value = Array.isArray(taskRows) ? taskRows : [];
  } catch (error) { ElMessage.error(error.message || "任务中心加载失败"); }
  finally { loading.value = false; }
}
async function loadDevelopmentData() {
  if (developmentDataLoaded.value) return;
  if (!developmentDataPromise) developmentDataPromise = loadData().finally(() => { developmentDataPromise = null; });
  await developmentDataPromise;
}
async function loadCategories(force = false) {
  if (categoriesLoaded.value && !force) return;
  try { const rows = await apiClient.get("/api/team/development-categories", { noCache: true }); categoryProjects.value = Array.isArray(rows) ? rows : []; categoriesLoaded.value = true; }
  catch (error) { ElMessage.error(error.message || "库存类目加载失败"); }
}
async function loadDrafts(force = false) {
  if (draftsLoaded.value && !force) return;
  try { const result = await apiClient.get("/api/listing/drafts?paged=1&lightweight=1&page=1&pageSize=100", { noCache: true }); listingDraftRows.value = result?.rows || []; draftsLoaded.value = true; }
  catch { listingDraftRows.value = []; }
}
async function loadCreationResources() {
  if (creationResourcesLoaded.value) return;
  const [supplierRows, ruleRows] = await Promise.all([apiClient.get("/api/suppliers", { noCache: true }).catch(() => []), apiClient.get("/api/logistics/fee-rules", { noCache: true }).catch(() => [])]);
  suppliers.value = Array.isArray(supplierRows) ? supplierRows : supplierRows?.rows || [];
  logisticsRules.value = Array.isArray(ruleRows) ? ruleRows : ruleRows?.rows || [];
  creationResourcesLoaded.value = true;
}
function ideaDueDateValue(value) {
  const matched = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return matched?.[1] || "";
}
function ideaDueAtText(value) {
  const date = ideaDueDateValue(value);
  return date ? shanghaiDateTimeText(`${date}T21:00:00+08:00`) : "未设置";
}
function openIdea(row = null) {
  Object.assign(ideaForm, row ? { id: row.id, title: row.title, image_url: row.image_url || "", source_url: row.source_url || "", note: row.note || "", urgency: row.urgency || 5, importance: row.importance || 5,
    assignee_person_id: row.assignee_person_id || null, target_product_count: Number(row.target_product_count || 0), development_due_at: ideaDueDateValue(row.development_due_at) }
    : { id: null, title: "", image_url: "", source_url: "", note: "", urgency: 5, importance: 5, assignee_person_id: null, target_product_count: 0, development_due_at: "" });
  ideaVisible.value = true;
}
async function uploadIdeaImage(file) {
  if (!file) return;
  if (!String(file.type || "").startsWith("image/")) return ElMessage.warning("请选择图片文件");
  if (Number(file.size || 0) > 20 * 1024 * 1024) return ElMessage.warning("图片不能超过 20MB");
  ideaImageUploading.value = true;
  try {
    const uploaded = await uploadListingMedia(file, { source_module: "product_development_idea", role: "idea_main_image" });
    ideaForm.image_url = uploaded.publishUrl || uploaded.url || uploaded.previewUrl || "";
    if (!ideaForm.image_url) throw new Error("上传成功，但没有返回图片地址");
    ElMessage.success("主图已上传");
  } catch (error) { ElMessage.error(error.message || "图片上传失败"); } finally { ideaImageUploading.value = false; }
}
function chooseIdeaImage() { ideaFileInput.value?.click(); }
function handleIdeaFileChange(event) { uploadIdeaImage(event.target?.files?.[0]); if (event.target) event.target.value = ""; }
function handleIdeaImageDrop(event) { uploadIdeaImage(event.dataTransfer?.files?.[0]); }
function handleIdeaImagePaste(event) {
  const image = [...(event.clipboardData?.items || [])].find((item) => String(item.type || "").startsWith("image/"));
  if (image) { event.preventDefault(); uploadIdeaImage(image.getAsFile()); }
}
async function saveIdea() {
  if (!ideaForm.title.trim()) return ElMessage.warning("请填写灵感标题");
  ideaSaving.value = true;
  try {
    if (ideaForm.id) await apiClient.put(`/api/team/development-ideas/${ideaForm.id}`, ideaForm);
    else await apiClient.post("/api/team/development-ideas", ideaForm);
    ideaVisible.value = false; ElMessage.success("灵感已保存"); await loadData();
  } catch (error) { ElMessage.error(error.message || "灵感保存失败"); } finally { ideaSaving.value = false; }
}
async function saveIdeaAssignment(row, quiet = false) {
  try {
    await apiClient.put(`/api/team/development-ideas/${row.id}`, {
      ...row,
      development_due_at: ideaDueDateValue(row.development_due_at)
    });
    if (!quiet) ElMessage.success("开发任务配置已保存");
  } catch (error) { ElMessage.error(error.message || "开发任务配置保存失败"); throw error; }
}
async function startIdeaDevelopment(row) {
  if (!row.assignee_person_id || Number(row.target_product_count || 0) < 1 || !row.development_due_at) {
    return ElMessage.warning("请先选择指定人员、填写产品数量和截止时间");
  }
  try {
    await saveIdeaAssignment(row, true);
    await apiClient.post(`/api/team/development-ideas/${row.id}/start-development`, {});
    await loadData(); activeTab.value = "products"; ElMessage.success("已进入产品开发任务");
  } catch (error) { ElMessage.error(error.message || "进入产品开发失败"); }
}
async function viewIdeaTask(row) {
  if (row.status === "idea") return startIdeaDevelopment(row);
  activeTab.value = "products";
}
async function claimIdea(row) {
  try { await apiClient.post(`/api/team/development-ideas/${row.id}/claim`, {}); await loadData(); ElMessage.success("任务已认领"); }
  catch (error) { ElMessage.error(error.message || "任务认领失败"); }
}
async function createIdeaProduct(row) {
  if (row.status !== "developing") return ElMessage.warning("请由指定负责人先认领任务，再开始新增产品");
  developingIdea.value = row; await loadCreationResources(); createVisible.value = true;
}
function ideaOverdue(row) { const dueDate = ideaDueDateValue(row.development_due_at); return Boolean(dueDate && Number(row.output_count || 0) < Number(row.target_product_count || 0)
  && Date.now() > new Date(`${dueDate}T21:00:00+08:00`).getTime()); }
function ideaProgress(row) { return Math.min(100, Math.round(Number(row.output_count || 0) / Math.max(1, Number(row.target_product_count || 0)) * 100)); }
async function createProduct() { developingIdea.value = null; await loadCreationResources(); createVisible.value = true; }
function ideaProductSeed() {
  if (!developingIdea.value) return null;
  return { name: developingIdea.value.title, image_url: developingIdea.value.image_url || "", purchase_url: developingIdea.value.source_url || "",
    supplier_note: developingIdea.value.note || "", source_platform: "1688" };
}
async function loadBindings(force = false) {
  if (bindingsLoaded.value && !force) return;
  bindingLoading.value = true;
  try {
    const result = await apiClient.get(`/api/listing/inventory-bindings?limit=50&status=${bindingStatus.value}`, { noCache: true });
    bindings.value = result?.rows || [];
    bindingSummary.value = result?.summary || {};
    bindingsLoaded.value = true;
  } catch (error) { ElMessage.error(error.message || "SKU 关系加载失败"); }
  finally { bindingLoading.value = false; }
}
async function changeBindingStatus(value) { bindingStatus.value = value; bindingsLoaded.value = false; await loadBindings(true); }

async function addToBoard(product) {
  return apiClient.post("/api/team/development-candidates", {
    product_id: product.id, title: product.name || `库存产品 #${product.id}`, category: product.inventory_category || "",
    brand: product.vehicle_brand || "", vehicle_model: product.vehicle_model || "", owner_person_id: product.owner_person_id || null,
    source_url: product.purchase_url || "", status: "idea"
  });
}

async function handleProductCreated(payload = {}) {
  createVisible.value = false;
  const product = payload.product?.product || payload.product || {};
  const productId = Number(product.id || payload.id || 0);
  if (!productId) { ElMessage.warning("库存产品已创建，请刷新后加入开发看板"); return loadData(); }
  try {
    if (developingIdea.value) {
      await apiClient.post(`/api/team/development-ideas/${developingIdea.value.id}/link-product`, { product_id: productId });
      const draftId = Number(payload.draft?.id || 0);
      if (draftId) await apiClient.post(`/api/team/development-ideas/${developingIdea.value.id}/link-draft`, { draft_id: draftId });
    }
    else await addToBoard({ ...product, id: productId });
    developingIdea.value = null; ElMessage.success("已创建真实库存产品，并加入开发看板"); await loadData();
  }
  catch (error) { ElMessage.error(error.message || "库存产品已创建，但加入开发看板失败"); }
}

async function openDraftLink(row) {
  draftLinkIdea.value = row;
  const personId = Number(row.assignee_person_id || 0);
  if (!personId) return ElMessage.warning("请先为任务指定负责人");
  draftLinkExistingIds.value = new Set((row.drafts || []).map((draft) => Number(draft.id)));
  draftLinkIds.value = [];
  draftLinkKeyword.value = "";
  draftLinkDateRange.value = [];
  draftLinkPage.value = 1;
  draftLinkVisible.value = true;
  await reloadDraftLinkOptions();
}

async function reloadDraftLinkOptions(resetPage = false) {
  const personId = Number(draftLinkIdea.value?.assignee_person_id || 0);
  if (!personId) return;
  if (resetPage) draftLinkPage.value = 1;
  draftLinkLoading.value = true;
  try {
    const dates = draftLinkDateRange.value || [];
    const dateQuery = dates.length === 2 ? `&startDate=${dates[0]}&endDate=${dates[1]}` : "";
    const keywordQuery = draftLinkKeyword.value.trim() ? `&query=${encodeURIComponent(draftLinkKeyword.value.trim())}` : "";
    const result = await apiClient.get(`/api/listing/drafts?paged=1&lightweight=1&page=${draftLinkPage.value}&pageSize=${draftLinkPageSize}&sortBy=created_at&creatorId=${personId}${dateQuery}${keywordQuery}`, { noCache: true });
    listingDraftRows.value = result?.rows || [];
    draftLinkTotal.value = Number(result?.total || 0);
    draftLinkOptions.value = [...listingDraftRows.value].sort((a, b) => {
      const linkedDiff = Number(draftLinkExistingIds.value.has(Number(b.id))) - Number(draftLinkExistingIds.value.has(Number(a.id)));
      return linkedDiff || new Date(b.created_at || 0) - new Date(a.created_at || 0) || Number(b.id) - Number(a.id);
    });
  } catch { listingDraftRows.value = []; draftLinkOptions.value = []; draftLinkTotal.value = 0; }
  finally { draftLinkLoading.value = false; }
}
function toggleDraftLink(draft) {
  const id = Number(draft.id);
  if (draftLinkExistingIds.value.has(id)) return;
  draftLinkIds.value = draftLinkIds.value.includes(id) ? draftLinkIds.value.filter((item) => item !== id) : [...draftLinkIds.value, id];
}
function selectAllDraftLinks() {
  const ids = selectableDraftLinkOptions.value.map((draft) => Number(draft.id));
  draftLinkIds.value = ids.every((id) => draftLinkIds.value.includes(id)) ? [] : ids;
}
function changeDraftLinkPage(page) {
  draftLinkPage.value = page;
  reloadDraftLinkOptions();
}

async function confirmDraftLink() {
  const ideaId = Number(draftLinkIdea.value?.id || 0); const draftIds = draftLinkIds.value.map(Number).filter(Boolean);
  if (!ideaId || !draftIds.length) return ElMessage.warning("请选择要关联的草稿");
  try {
    await apiClient.post(`/api/team/development-ideas/${ideaId}/link-draft`, { draft_ids: draftIds });
    draftLinkVisible.value = false;
    ElMessage.success(`已关联 ${draftIds.length} 个草稿，进度将按草稿内的变体数量计算`);
    await loadData();
  } catch (error) { ElMessage.error(error.message || "关联草稿失败"); }
}

async function handleExistingProductSelected(product = {}) {
  createVisible.value = false;
  const productId = Number(product.id || 0);
  if (!productId) return ElMessage.warning("未获取到现有库存商品 ID");
  try {
    if (developingIdea.value) await apiClient.post(`/api/team/development-ideas/${developingIdea.value.id}/link-product`, { product_id: productId });
    else await addToBoard(product);
    developingIdea.value = null;
    ElMessage.success("已选用现有库存商品，并加入开发看板");
    await loadData();
  } catch (error) { ElMessage.error(error.message || "选用现有库存商品失败"); }
}

async function attachExistingProduct() {
  try {
    const result = await apiClient.get("/api/products?paged=1&page=1&pageSize=100", { noCache: true });
    const existingIds = new Set(products.value.map((row) => Number(row.product_id)).filter(Boolean));
    attachOptions.value = (result?.rows || []).filter((row) => !existingIds.has(Number(row.id)));
    if (!attachOptions.value.length) return ElMessage.info("现有库存产品都已在开发看板中");
    attachProductId.value = null;
    attachVisible.value = true;
  } catch (error) { ElMessage.error(error.message || "加入库存产品失败"); }
}
function handleQuickDevelopment(command) {
  if (command === "attach") return attachExistingProduct();
  return createProduct();
}
async function confirmAttachProduct() {
  const product = attachOptions.value.find((row) => Number(row.id) === Number(attachProductId.value));
  if (!product) return ElMessage.warning("请选择要加入开发看板的库存产品");
  try { await addToBoard(product); attachVisible.value = false; ElMessage.success(`已把「${product.name}」加入开发看板`); await loadData(); }
  catch (error) { ElMessage.error(error.message || "加入库存产品失败"); }
}

function openMeta(row) {
  current.value = row;
  Object.assign(metaForm, { project_id: row.project_id || null, status: row.status || "idea", priority: row.priority || "medium",
    planned_listing_at: row.planned_listing_at || "", note: row.note || "", decision_note: row.decision_note || "" });
  editVisible.value = true;
}
async function saveMeta() {
  try { await apiClient.put(`/api/team/development-candidates/${current.value.id}`, { ...current.value, ...metaForm }); editVisible.value = false; ElMessage.success("开发进度已更新"); await loadData(); }
  catch (error) { ElMessage.error(error.message || "保存失败"); }
}
async function moveStage(row) {
  const next = stages[Math.min(stages.length - 1, stageIndex(row.status) + 1)];
  if (!next || next.value === row.status) return;
  try { await apiClient.put(`/api/team/development-candidates/${row.id}`, { ...row, status: next.value }); ElMessage.success(`已进入：${next.label}`); await loadData(); }
  catch (error) { ElMessage.error(error.message || "阶段更新失败"); }
}
function createListingDraft(row) { router.push({ path: "/asset-variant-center", query: { source: "selection", productId: String(row.product_id), from: "product-development" } }); }
async function openProject(project) {
  selectedProject.value = project; categoryProducts.value = [];
  if (!project.virtual) return;
  categoryProductsLoading.value = true;
  try {
    const result = await apiClient.get(`/api/products?paged=1&page=1&pageSize=100&inventoryCategory=${encodeURIComponent(project.category)}`, { noCache: true });
    categoryProducts.value = result?.rows || [];
  } catch (error) { ElMessage.error(error.message || "类目产品加载失败"); } finally { categoryProductsLoading.value = false; }
}
function openTask(row = null) {
  loadDevelopmentData();
  Object.assign(taskForm, { id: null, title: "", owner_person_id: people.value[0]?.id || null, project_id: null, candidate_id: null, type: "custom", period: "week", status: "todo", priority: "medium", target: 4, done: 0, unit: "步", start_at: "", due_at: "", deliverable: "", result: "", automation_key: "" }, row || {});
  taskVisible.value = true;
  loadTaskOperationalDetails(taskForm);
}
async function saveTask() {
  if (!taskForm.title.trim()) return ElMessage.warning("请填写任务名称");
  taskSaving.value = true;
  try {
    if (taskForm.id) await apiClient.put(`/api/team/tasks/${taskForm.id}`, taskForm); else await apiClient.post("/api/team/tasks", taskForm);
    taskVisible.value = false; ElMessage.success(taskForm.id ? "任务已更新" : "任务已创建"); await loadTaskCenterData();
  } catch (error) { ElMessage.error(error.message || "任务保存失败"); } finally { taskSaving.value = false; }
}
async function deleteTask(row) {
  try { await ElMessageBox.confirm(`确认删除任务「${row.title}」？`, "删除任务", { type: "warning" }); await apiClient.delete(`/api/team/tasks/${row.id}`); ElMessage.success("任务已删除"); await loadTaskCenterData(); }
  catch (error) { if (error !== "cancel" && error !== "close") ElMessage.error(error.message || "删除失败"); }
}
function goDashboardTarget(target) { activeTab.value = target; if (target === "analytics") loadBindings(); }
function editInventoryProduct(row) { router.push({ path: "/inventory/products", query: { productId: String(row.product_id), openEdit: "1" } }); }
function bindingStatusLabel(status) { return ({ bound: "已绑定", unbound: "缺少库存", waiting_online: "等待在线商品", waiting_sku: "等待 SKU", conflict: "绑定冲突", pending: "待处理" })[status] || status || "待处理"; }
function bindingStatusType(status) { return status === "bound" ? "success" : status === "conflict" ? "danger" : status === "unbound" ? "warning" : "info"; }
function bindingRowKey(row) { return `${row?.record_id || 0}-${row?.online_product_id || 0}-${row?.online_ozon_sku || row?.ozon_sku || "pending"}`; }
async function retryBindings(recordIds = []) {
  bindingLoading.value = true;
  try { const result = await apiClient.post("/api/listing/inventory-bindings/retry", { record_ids: recordIds }); ElMessage.success(`已检查 ${result.total || 0} 条，完成绑定 ${result.bound || 0} 条`); await loadBindings(true); }
  catch (error) { ElMessage.error(error.message || "自动补绑失败"); } finally { bindingLoading.value = false; }
}
async function openBind(row) {
  bindRecord.value = row; bindProductId.value = row.source_product_id || null;
  const result = await apiClient.get("/api/products?paged=1&page=1&pageSize=100", { noCache: true });
  bindProductOptions.value = result?.rows || []; bindVisible.value = true;
}
async function confirmBind() {
  if (!bindProductId.value) return ElMessage.warning("请选择库存产品");
  try { await apiClient.post("/api/listing/inventory-bindings/bind", { record_id: bindRecord.value.record_id, online_product_id: bindRecord.value.online_product_id, product_id: bindProductId.value }); bindVisible.value = false; ElMessage.success("库存产品已绑定，历史订单也已重新归因"); await loadBindings(true); }
  catch (error) { ElMessage.error(error.message || "绑定失败"); }
}
onMounted(loadTaskCenterData);
watch(activeTab, (value) => {
  if (value !== "tasks") loadDevelopmentData();
  if (value === "analytics" && bindingStatus.value !== "all") { bindingStatus.value = "all"; bindingsLoaded.value = false; }
  if (value === "projects") loadCategories();
  if (value === "analytics") { loadDrafts(); loadBindings(); }
  if (value === "bindings") loadBindings();
});
watch([taskRange, taskCustomRange, taskKeyword, taskStatus, taskType], () => { taskPage.value = 1; }, { deep: true });
</script>

<template>
  <div v-loading="loading" class="development-center">
    <header class="hero">
      <h1><ListTodo :size="25" />任务系统</h1>
      <div class="hero-nav">
        <nav class="tabs"><button v-for="tab in tabs" :key="tab.value" :class="{active:activeTab===tab.value}" @click="activeTab=tab.value"><component :is="tab.icon" :size="17" />{{ tab.label }}</button></nav>
        <el-dropdown split-button type="primary" class="quick-development" @click="createProduct" @command="handleQuickDevelopment">
          <PackagePlus :size="16" /> 快速开发
          <template #dropdown><el-dropdown-menu><el-dropdown-item command="new">新建开发产品</el-dropdown-item><el-dropdown-item command="attach">加入现有库存产品</el-dropdown-item></el-dropdown-menu></template>
        </el-dropdown>
      </div>
    </header>

    <template v-if="activeTab==='dashboard'">
      <section class="metrics">
        <article class="metric-link" @click="goDashboardTarget('ideas')"><Lightbulb /><div><span>灵感库</span><strong>{{ ideas.length }}</strong><small>快速记录和启动开发</small></div></article>
        <article class="metric-link" @click="goDashboardTarget('products')"><Boxes /><div><span>开发产品</span><strong>{{ activeProducts.length }}</strong><small>关联真实库存主档</small></div></article>
        <article class="metric-link" @click="router.push('/listing-records')"><Rocket /><div><span>发布草稿</span><strong>{{ listingDraftRows.length }}</strong><small>进入草稿箱处理发布</small></div></article>
        <article class="metric-link" @click="goDashboardTarget('analytics')"><CircleCheck /><div><span>上架验证</span><strong>{{ listedProducts.length }}</strong><small>查看发布与出单效果</small></div></article>
        <article class="metric-link" @click="goDashboardTarget('tasks')"><ListTodo /><div><span>完成任务</span><strong>{{ taskDone }}</strong><small>共 {{ tasks.length }} 项任务</small></div></article>
      </section>
      <section class="workflow panel"><div class="section-title"><div><span>统一业务链路</span><h2>从库存产品到 Ozon 上架</h2></div></div><div class="workflow-steps"><div><b>1</b><strong>创建库存产品</strong><small>复用类目、品牌、车型、采购和成本字段</small></div><i>→</i><div><b>2</b><strong>推进开发</strong><small>分配负责人、项目、阶段、排期和任务</small></div><i>→</i><div><b>3</b><strong>创建上架草稿</strong><small>带着真实产品资料进入现有上架流程</small></div><i>→</i><div><b>4</b><strong>发布与验证</strong><small>保留产品与 SKU 的完整关系</small></div></div></section>
      <section class="panel focus-list"><div class="section-title"><div><span>当前重点</span><h2>最近推进的开发产品</h2></div><el-button link type="primary" @click="activeTab='products'">查看全部</el-button></div><div class="product-rows"><article v-for="row in products.slice(0,8)" :key="row.id"><el-image :src="productImage(row)" fit="cover" preview-teleported><template #error><div class="empty-image">无图</div></template></el-image><div class="product-main"><strong>{{ row.title }}</strong><small>{{ row.product_code || `产品 #${row.product_id}` }} · {{ row.category || '未分类' }} · {{ row.owner_name || '未分配' }}</small></div><el-tag effect="plain">{{ stageLabel(row.status) }}</el-tag><span>库存 {{ row.stock }} / SKU {{ row.sku_count }}</span><el-button @click="openMeta(row)">推进</el-button><el-button type="primary" plain @click="createListingDraft(row)">创建草稿</el-button></article><el-empty v-if="!products.length" description="先创建第一个真实库存产品" /></div></section>
    </template>

    <section v-else-if="activeTab==='ideas'" class="panel ideas-page">
      <div class="section-title"><div><span>快速记录，成熟后再进入库存产品</span><h2>灵感列表</h2></div><el-button type="primary" @click="openIdea()"><Lightbulb :size="16" /> 快速创建灵感</el-button></div>
      <div class="idea-grid"><article v-for="row in sortedIdeas" :key="row.id" class="idea-card">
        <div class="idea-card-media"><el-image :src="row.image_url" fit="cover" :preview-src-list="row.image_url?[row.image_url]:[]" preview-teleported><template #error><div class="empty-image">暂无主图</div></template></el-image><el-button class="replace-image-button" size="small" :icon="ImagePlus" @click="openIdea(row)">替换图片</el-button></div>
        <div class="idea-card-content"><header><div class="idea-title-line"><h3>{{ row.title }}</h3><span class="task-count">任务 {{ row.target_product_count || 0 }}</span><span class="priority-badge urgent">紧急 {{ row.urgency }}</span><span class="priority-badge important">重要 {{ row.importance }}</span></div><p>{{ row.note || '暂无备注' }}</p><el-link v-if="row.source_url" :href="row.source_url" target="_blank" type="primary" :underline="false">查看参考链接</el-link></header>
          <div class="idea-people-row"><span><b>指定人员</b><el-avatar :src="personAvatar(row.assignee_person_id)" :size="24">{{ personInitial(row.assignee_name) }}</el-avatar>{{ row.assignee_name || '待指定' }}</span><span><b>创建人</b><el-avatar :src="personAvatar(row.created_by_person_id)" :size="24">{{ personInitial(row.created_by_name || '系统') }}</el-avatar>{{ row.created_by_name || '系统' }}</span></div>
          <div class="idea-meta-row"><span><b>创建时间</b>{{ shanghaiDateTimeText(row.created_at, { assumeUtcWhenNaive: true }) }}</span><span><b>截止时间</b>{{ ideaDueAtText(row.development_due_at) }}</span></div>
          <footer><el-button :icon="Edit3" plain @click="openIdea(row)">编辑</el-button><el-button type="primary" plain @click="viewIdeaTask(row)">查看任务</el-button></footer>
        </div>
      </article><el-empty v-if="!sortedIdeas.length" description="还没有灵感，先记录第一条吧" /></div>
    </section>

    <section v-else-if="activeTab==='products'" class="products-page task-workflow-page">
      <div class="panel task-workflow-panel">
        <div class="section-title"><div><span>只有完成负责人、目标数量、截止时间配置并点击“去开发”的灵感才会进入</span><h2>产品开发任务流程</h2></div><el-button @click="activeTab='ideas'">返回灵感列表</el-button></div>
        <div class="workflow-column-head"><span>第一阶段 · 任务认领</span><span>第二阶段 · 产品进度</span><span>第三阶段 · 草稿箱记录</span><span>第四阶段 · 出单数</span></div>
        <div class="task-workflow-list">
          <article v-for="row in developmentIdeas" :key="row.id" :class="{ overdue: ideaOverdue(row) }">
            <section class="workflow-claim"><div class="workflow-title"><el-image class="idea-image" :src="row.image_url" fit="cover"><template #error><div class="empty-image">无图</div></template></el-image><div><strong>{{ row.title }}</strong><small class="person-inline"><el-avatar :src="personAvatar(row.assignee_person_id)" :size="24">{{ personInitial(row.assignee_name) }}</el-avatar>指定负责人：{{ row.assignee_name }}</small><small>截止时间：{{ row.development_due_at }}</small></div></div><el-button v-if="row.status==='assigned'" type="primary" plain @click="claimIdea(row)">认领任务</el-button><el-tag v-else type="success">已认领</el-tag></section>
            <section class="workflow-progress"><div><strong>{{ row.output_count }}</strong><span>/ {{ row.target_product_count }} 个产品</span></div><el-progress :percentage="ideaProgress(row)" :status="ideaOverdue(row)?'exception':undefined" /><small v-if="ideaOverdue(row)" class="overdue-text">已超过截止时间，任务尚未完成</small><small v-else>{{ row.draft_count }} 个草稿，按草稿内变体统计；店铺副本不重复计数</small><el-button v-if="row.status==='developing'" type="primary" @click="createIdeaProduct(row)">新增产品并创建草稿</el-button><el-button v-if="row.status==='developing'" plain @click="openDraftLink(row)">关联草稿</el-button><span v-else class="claim-tip">负责人认领后才能开始开发</span></section>
            <section class="workflow-drafts"><div v-for="draft in row.drafts" :key="draft.id" class="workflow-draft"><div><strong>{{ draft.product_name || `草稿 #${draft.id}` }}</strong><small>{{ draft.development_type==='fission' ? '裂变草稿' : '普通草稿' }}<template v-if="draft.parent_draft_id"> · 来源 #{{ draft.parent_draft_id }}</template></small></div><el-button link type="primary" @click="router.push({path:'/listing-records',query:{draftId:draft.id}})">查看</el-button></div><el-empty v-if="!row.drafts?.length" :image-size="42" description="暂未创建草稿" /></section>
            <section class="workflow-orders"><strong>{{ row.order_count || 0 }}</strong><span>订单</span><small>订单模块关联后自动统计</small></section>
          </article>
          <el-empty v-if="!developmentIdeas.length" description="暂无符合条件的开发任务，请先填写指定人员、产品数量和截止时间，再点击“去开发”"><el-button type="primary" @click="activeTab='ideas'">去配置灵感任务</el-button></el-empty>
        </div>
      </div>
    </section>

    <section v-else-if="activeTab==='products'" class="products-page"><div v-if="developmentIdeas.length" class="development-tasks panel"><div class="section-title"><div><span>任务认领 → 产品进度 → 关联草稿 → 出单验证</span><h2>产品开发任务</h2></div></div><div class="development-task-list"><article v-for="row in developmentIdeas" :key="row.id" :class="{ overdue: ideaOverdue(row) }"><section class="task-claim"><el-image class="idea-image" :src="row.image_url" fit="cover"><template #error><div class="empty-image">无图</div></template></el-image><div><strong>{{ row.title }}</strong><small>负责人：{{ row.assignee_name || '待认领' }}</small><small>截止：{{ row.development_due_at }}</small><el-button v-if="row.status==='assigned'" size="small" type="primary" plain @click="claimIdea(row)">认领任务</el-button></div></section><section class="task-progress"><strong>{{ row.output_count }} / {{ row.target_product_count }}</strong><span>变体产品进度（可超额）</span><el-progress :percentage="ideaProgress(row)" :status="ideaOverdue(row)?'exception':undefined" /><small>{{ row.draft_count }} 个草稿，店铺副本不重复计数</small></section><section class="task-drafts"><strong>草稿箱记录</strong><div v-for="draft in row.drafts" :key="draft.id"><el-link type="primary" @click="router.push({path:'/listing-records',query:{draftId:draft.id}})">{{ draft.product_name || `草稿 #${draft.id}` }}</el-link><small>{{ draft.development_type==='fission'?'裂变草稿':'普通草稿' }}</small></div><span v-if="!row.drafts?.length">还没有关联草稿</span></section><section class="task-orders"><strong>{{ row.order_count || 0 }}</strong><span>出单数</span><small>订单模块待打通</small></section><section class="task-actions"><el-button type="primary" @click="createIdeaProduct(row)">新增产品</el-button><el-button plain @click="openDraftLink(row)">关联草稿</el-button></section></article></div></div><div class="toolbar panel"><div><el-input v-model="keyword" clearable placeholder="搜索产品、编号、类目、品牌、负责人"><template #prefix><Search :size="16" /></template></el-input><el-select v-model="projectFilter"><el-option label="全部项目" value="all" /><el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" /></el-select></div><el-button type="primary" @click="createProduct"><PackagePlus :size="17" /> 新建开发产品</el-button></div><div class="board"><section v-for="stage in stages" :key="stage.value"><header><strong>{{ stage.short }}</strong><b>{{ filteredProducts.filter(row=>row.status===stage.value).length }}</b></header><article v-for="row in filteredProducts.filter(item=>item.status===stage.value)" :key="row.id" @click="openMeta(row)"><div class="card-head"><el-image :src="productImage(row)" fit="cover"><template #error><div class="empty-image">无图</div></template></el-image><el-tag size="small" :type="row.priority==='high'?'danger':'info'">{{ row.priority==='high'?'高优先':'常规' }}</el-tag></div><h3>{{ row.title }}</h3><p>{{ row.product_code || `产品 #${row.product_id}` }}</p><div class="facts"><span>{{ row.category || '未分类' }}</span><span><Users :size="13" />{{ row.owner_name || '未分配' }}</span><span>库存 {{ row.stock }}</span><span>SKU {{ row.sku_count }}</span></div><footer @click.stop><el-button link @click="editInventoryProduct(row)">产品资料</el-button><el-button v-if="row.status!=='listed'" link type="primary" @click="moveStage(row)">下一阶段</el-button><el-button v-if="['content','listing'].includes(row.status)" link type="success" @click="createListingDraft(row)">创建草稿</el-button></footer></article></section></div></section>
    <section v-else-if="activeTab==='projects'" class="panel projects-page"><div class="section-title"><div><span>完全按照库存中心类目归组 · 产品数量从高到低</span><h2>{{ selectedProject ? selectedProject.name : '库存类目项目' }}</h2></div><el-button v-if="selectedProject" @click="selectedProject=null">返回类目总览</el-button></div><template v-if="!selectedProject"><div class="category-summary"><span>共 {{ displayedProjects.length }} 个类目</span><b>{{ displayedProjects.reduce((sum,item)=>sum+Number(item.product_count||0),0) }} 个库存产品</b></div><div class="project-grid"><article v-for="(project,index) in displayedProjects" :key="project.id" class="project-card" @click="openProject(project)"><div class="category-card-head"><b>#{{ index + 1 }}</b><strong>{{ project.name }}</strong><em>{{ project.product_count }}</em></div><p>{{ project.brand_count || 0 }} 个品牌 · {{ project.listed_count || 0 }} 个产品已关联 SKU</p><el-progress :percentage="Math.round(Number(project.product_count||0)/Math.max(1,Number(displayedProjects[0]?.product_count||1))*100)" :show-text="false" :stroke-width="6" /><el-button link type="primary">查看该类目产品 →</el-button></article></div><el-empty v-if="!displayedProjects.length" description="库存中心尚未填写库存类目，请先完善产品主档的类目字段" /></template><template v-else><el-table v-loading="categoryProductsLoading" :data="projectDetailProducts" class="project-product-table" empty-text="该类目还没有产品"><el-table-column label="主图" width="90"><template #default="{row}"><el-image class="idea-image" :src="productImage(row)" fit="cover" preview-teleported /></template></el-table-column><el-table-column prop="brand" label="品牌" width="150"><template #default="{row}"><strong>{{ row.brand || '未填品牌' }}</strong></template></el-table-column><el-table-column prop="title" label="产品" min-width="220" /><el-table-column prop="vehicle_model" label="车型/款式" min-width="160" /><el-table-column label="库存 / SKU" width="130"><template #default="{row}">{{ row.stock }} / {{ row.sku_count }}</template></el-table-column><el-table-column label="操作" width="180"><template #default="{row}"><el-button plain @click="editInventoryProduct(row)">产品表单</el-button><el-button link type="success" @click="createListingDraft(row)">创建草稿</el-button></template></el-table-column></el-table></template></section>
    <section v-else-if="activeTab==='bindings'" v-loading="bindingLoading" class="panel bindings-page"><div class="section-title"><div><span>把 Ozon 店铺 SKU 对应到真实库存产品，订单、销量和利润才能正确归集</span><h2>SKU 库存关联</h2></div><div class="binding-actions"><el-select :model-value="bindingStatus" style="width:150px" @change="changeBindingStatus"><el-option label="全部状态" value="all" /><el-option label="已绑定" value="bound" /><el-option label="缺少库存" value="unbound" /><el-option label="等待 Ozon" value="waiting_online" /><el-option label="绑定冲突" value="conflict" /></el-select><el-button @click="loadBindings(true)"><RefreshCw :size="16" /> 刷新</el-button><el-button type="primary" @click="retryBindings()">自动匹配库存</el-button></div></div><el-alert class="binding-guide" type="info" :closable="false" show-icon title="这个页面有什么用？"><template #default>每个线上 Ozon SKU 必须关联一个库存产品。系统会先自动匹配；“待人工绑定”的记录需要点击右侧“选择库存产品”。绑定后，订单销量、库存扣减、利润和裂变效果才能归到正确产品。</template></el-alert><div class="binding-note">当前显示最近 50 条；“已绑定”包含草稿自动绑定和历史 SKU 关系反推。</div><div class="binding-metrics"><article><span>当前列表 · 已绑定</span><strong>{{ bindingSummary.bound || 0 }}</strong></article><article><span>当前列表 · 待人工绑定</span><strong>{{ bindingSummary.unbound || 0 }}</strong></article><article><span>当前列表 · 等待同步</span><strong>{{ bindingSummary.waiting || 0 }}</strong></article><article><span>当前列表 · 冲突</span><strong>{{ bindingSummary.conflict || 0 }}</strong></article></div><el-table :data="bindings" :row-key="bindingRowKey" height="560" empty-text="当前筛选下没有 SKU 关联记录"><el-table-column label="商品 / 店铺" min-width="280"><template #default="{row}"><strong>{{ row.draft_name || row.offer_id || '-' }}</strong><div class="cell-sub">{{ row.shop_name }} · {{ row.offer_id }}</div></template></el-table-column><el-table-column prop="online_ozon_sku" label="Ozon SKU" width="145"><template #default="{row}">{{ row.online_ozon_sku || row.ozon_sku || '等待生成' }}</template></el-table-column><el-table-column label="库存产品" min-width="210"><template #default="{row}">{{ row.inventory_product_name || '尚未绑定' }}<div v-if="row.inventory_product_code" class="cell-sub">{{ row.inventory_product_code }}</div></template></el-table-column><el-table-column label="关系" width="135"><template #default="{row}"><el-tag :type="bindingStatusType(row.binding_status)">{{ bindingStatusLabel(row.binding_status) }}</el-tag><div v-if="row.binding_source" class="cell-sub">{{ row.binding_source.includes('draft') ? '开发草稿' : '历史关系反推' }}</div></template></el-table-column><el-table-column label="销量" width="120"><template #default="{row}">{{ row.sales_quantity || 0 }} 件 · {{ row.order_count || 0 }} 单</template></el-table-column><el-table-column label="操作" width="145" fixed="right"><template #default="{row}"><el-button v-if="row.binding_status!=='bound'" type="warning" plain @click="openBind(row)">选择库存产品</el-button><el-tag v-else type="success">关联完成</el-tag></template></el-table-column></el-table></section>
    <section v-else-if="activeTab==='analytics'" class="panel analytics-page"><div class="section-title"><div><span>草稿规模结合发布 SKU 与订单归因</span><h2>人工草稿与 AI 裂变效果</h2></div></div><div class="method-grid"><article v-for="item in methodStats" :key="item.method" :class="item.method"><span>{{ item.label }}</span><strong>{{ item.orderRate }}%</strong><small>已绑定 SKU 出单率</small><div><b>{{ item.drafts }}</b><em>现有草稿</em><b>{{ item.published }}</b><em>已上架</em><b>{{ item.quantity }}</b><em>销售件数</em></div></article></div><el-alert type="info" :closable="false" show-icon title="统计口径"><template #default>草稿数直接来自现有草稿箱；上架与销售数据来自已完成的 SKU 绑定。没有出单数据时仍会展示当前人工草稿和 AI 裂变草稿规模。</template></el-alert></section>
    <section v-else-if="activeTab==='tasks'" class="tasks-page">
      <div class="panel task-overview-toolbar">
        <div class="task-range-tabs"><button v-for="option in taskRangeOptions" :key="option.value" :class="{active:taskRange===option.value}" @click="taskRange=option.value">{{ option.label }}</button></div>
        <div class="task-date-nav"><el-button :disabled="taskRange==='custom'" @click="moveTaskRange(-1)">‹</el-button><strong>{{ taskRangeLabel }}</strong><el-button :disabled="taskRange==='custom'" @click="moveTaskRange(1)">›</el-button><el-button @click="taskAnchor=new Date()">今天</el-button></div>
        <el-date-picker v-if="taskRange==='custom'" v-model="taskCustomRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" />
        <div class="task-filters"><el-input v-model="taskKeyword" clearable placeholder="搜索任务、项目或负责人"><template #prefix><Search :size="16" /></template></el-input><el-select v-model="taskStatus"><el-option label="全部状态" value="all" /><el-option label="待开始" value="todo" /><el-option label="进行中" value="doing" /><el-option label="待复核" value="review" /><el-option label="已完成" value="done" /><el-option label="已延期" value="delayed" /></el-select><el-button type="primary" :icon="Plus" @click="openTask()">新增任务</el-button></div>
      </div>
      <div class="task-type-tabs"><button v-for="option in taskTypeOptions" :key="option.value" :class="[option.value,{active:taskType===option.value}]" @click="taskType=option.value"><component :is="option.icon" :size="15" />{{ option.label }}</button></div>
      <div class="task-summary-grid"><article class="panel total"><div class="task-metric-icon"><CalendarDays :size="22" /></div><div><span>范围内任务</span><strong>{{ taskMetrics.total }}</strong><small>当前筛选范围</small></div></article><article class="panel done"><div class="task-metric-icon"><CheckCircle2 :size="22" /></div><div><span>按时完成</span><strong>{{ taskMetrics.done }}</strong><small>已完成且未逾期</small></div></article><article class="panel doing"><div class="task-metric-icon"><Clock3 :size="22" /></div><div><span>进行中</span><strong>{{ taskMetrics.doing }}</strong><small>待开始、进行或复核</small></div></article><article class="panel overdue"><div class="task-metric-icon"><TriangleAlert :size="22" /></div><div><span>已超时</span><strong>{{ taskMetrics.overdue }}</strong><small>需要优先处理</small></div></article></div>
      <div class="panel timeline-panel">
        <div class="timeline-head"><div><span>按截止时间定位，纵轴表示完成度</span><h2>任务时间轴</h2></div><div class="timeline-legend"><span class="done">按时完成</span><span class="doing">进行中</span><span class="risk">有风险</span><span class="overdue">已超时</span><span class="closed">已关闭</span></div></div>
        <div class="timeline-chart">
          <div class="timeline-y"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
          <div class="timeline-plot"><div v-for="level in [0,25,50,75,100]" :key="level" class="timeline-grid-line" :style="{bottom:`${level}%`}" /><div v-for="(_,index) in taskAxisLabels" :key="index" class="timeline-vertical-line" :style="{left:`${index/Math.max(1,taskAxisLabels.length-1)*100}%`}" /><el-popover v-for="group in timelineGroups" :key="`${group.timelineX}-${group.timelineY}`" placement="top" :width="330" trigger="hover" :show-after="120" :hide-after="650" :enterable="true" persistent><template #reference><div class="timeline-node" :class="[taskTone(group),taskTypeMeta(group).value]" :style="{left:`${group.timelineX}%`,bottom:`${Math.max(7,taskProgress(group))}%`}" @click="openTask(group)"><div class="timeline-avatar-stack"><el-avatar v-for="row in group.rows.slice(0,3)" :key="row.id" :src="personAvatar(row.owner_person_id || row.assignee_person_id)" :size="34">{{ personInitial(row.assignee_name || row.owner_name) }}</el-avatar><b v-if="group.rows.length>3">+{{ group.rows.length-3 }}</b></div><span class="task-type-mark"><component :is="taskTypeMeta(group).icon" :size="13" /></span><div><strong>{{ group.title || group.name }}<template v-if="group.rows.length>1"> 等 {{ group.rows.length }} 项</template></strong><small>{{ taskToneLabel(group) }} · {{ taskProgress(group) }}%</small></div></div></template><div class="task-node-detail"><header><component :is="taskTypeMeta(group).icon" :size="17" /><strong>{{ group.title || group.name }}</strong></header><dl><div><dt>任务类型</dt><dd>{{ taskTypeMeta(group).label }}</dd></div><div><dt>负责人</dt><dd>{{ group.owner_name || group.assignee_name || '未分配' }}</dd></div><div v-if="isDailyOperationalTask(group)"><dt>统计日期</dt><dd>{{ taskStatisticsDate(group) }}</dd></div><div v-if="isDailyOperationalTask(group)"><dt>统计时段</dt><dd>{{ taskRelated(group).window }}（北京时间）</dd></div><div><dt>计划完成</dt><dd>{{ group.due_at || '未设置' }}</dd></div><div><dt>当前进度</dt><dd>{{ taskProgressText(group) }}</dd></div><div v-if="isDailyOperationalTask(group)"><dt>订单统计</dt><dd>{{ taskStatisticsText(group) }}</dd></div><div><dt>状态</dt><dd><span class="task-status" :class="taskTone(group)">{{ taskToneLabel(group) }}</span></dd></div></dl><el-progress :percentage="taskProgress(group)" :stroke-width="8" /><div v-if="group.rows.length>1" class="timeline-group-popover"><strong>同位置还有 {{ group.rows.length-1 }} 项任务</strong><button v-for="row in group.rows" :key="row.id" @click="openTask(row)"><span>{{ row.title || row.name }}</span><small>{{ row.owner_name || '未分配' }}</small></button></div><footer><el-button @click="openTask(group)">查看详情</el-button><el-button v-if="group.type!=='custom'" type="primary" @click="enterTaskWorkspace(group)">进入对应工作台</el-button></footer></div></el-popover><el-empty v-if="!timelineGroups.length" description="当前时间范围暂无任务" /></div>
          <div class="timeline-x"><span v-for="label in taskAxisLabels" :key="label">{{ label }}</span></div>
        </div>
      </div>
      <div class="panel task-list-panel"><button class="task-list-toggle" @click="taskListExpanded=!taskListExpanded"><div><ChevronDown :size="17" :class="{collapsed:!taskListExpanded}" /><span>{{ taskRange==='week' ? '本周任务清单' : '任务清单' }}</span><b>{{ visibleTasks.length }}</b></div><small>{{ taskListExpanded ? '收起' : '展开' }}</small></button><el-collapse-transition><div v-show="taskListExpanded" class="task-list-body"><el-table :data="paginatedTasks" size="small"><el-table-column label="任务名称" min-width="240"><template #default="{row}"><div class="task-name-cell"><strong>{{ row.title || row.name || '未命名任务' }}</strong><small>{{ row.deliverable || row.result || '暂无交付说明' }}</small></div></template></el-table-column><el-table-column label="类型" width="130"><template #default="{row}"><span class="task-type-cell" :class="taskTypeMeta(row).value"><component :is="taskTypeMeta(row).icon" :size="14" />{{ taskTypeMeta(row).label }}</span></template></el-table-column><el-table-column label="负责人" width="150"><template #default="{row}"><div class="person-inline"><el-avatar :src="personAvatar(row.owner_person_id || row.assignee_person_id)" :size="26">{{ personInitial(row.assignee_name || row.owner_name) }}</el-avatar>{{ row.assignee_name || row.owner_name || '未分配' }}</div></template></el-table-column><el-table-column label="当前进度" width="200"><template #default="{row}"><div class="task-progress-cell"><el-progress :percentage="taskProgress(row)" :show-text="false" :stroke-width="7" :status="taskTone(row)==='overdue'?'exception':taskTone(row)==='done'?'success':undefined" /><span>{{ taskProgress(row) }}%</span></div></template></el-table-column><el-table-column label="计划完成" width="130"><template #default="{row}">{{ row.due_at || '未设置' }}</template></el-table-column><el-table-column label="状态" width="105"><template #default="{row}"><span class="task-status" :class="taskTone(row)">{{ taskToneLabel(row) }}</span></template></el-table-column><el-table-column label="操作" width="104" fixed="right" align="center"><template #default="{row}"><div class="task-row-actions"><el-tooltip content="查看任务" placement="top"><el-button circle :icon="Edit3" @click="openTask(row)" /></el-tooltip><el-tooltip v-if="!row.automation_key" content="删除任务" placement="top"><el-button circle :icon="Trash2" type="danger" plain @click="deleteTask(row)" /></el-tooltip></div></template></el-table-column></el-table><el-empty v-if="!visibleTasks.length" description="当前时间范围暂无开发任务" /><div v-if="visibleTasks.length" class="task-pagination"><span>共 {{ visibleTasks.length }} 项任务</span><el-pagination v-model:current-page="taskPage" v-model:page-size="taskPageSize" background layout="prev, pager, next" :total="visibleTasks.length" /></div></div></el-collapse-transition></div>
    </section>

    <ProductCreateEditDialog v-model:visible="createVisible" mode="create" target="inventory" :value="ideaProductSeed()" :people="people" :suppliers="suppliers" :logistics-rules="logisticsRules" @saved="handleProductCreated" @existing-selected="handleExistingProductSelected" />
    <el-dialog v-model="draftLinkVisible" width="1040px" top="4vh" class="draft-link-dialog"><template #header><div class="draft-link-header"><div><h2>批量选择草稿</h2><p>仅查询负责人「{{ draftLinkIdea?.assignee_name || '未指定' }}」的全部草稿，按创建时间从新到旧</p></div><div class="draft-link-summary"><el-tag type="success">{{ draftLinkExistingIds.size }} 条已关联</el-tag><el-tag type="info">共 {{ draftLinkTotal }} 条草稿</el-tag></div></div></template><div class="draft-link-toolbar"><el-input v-model="draftLinkKeyword" clearable placeholder="搜索全部草稿：名称、货号、车型或编号" @keyup.enter="reloadDraftLinkOptions(true)" @clear="reloadDraftLinkOptions(true)"><template #prefix><Search :size="16" /></template><template #append><el-button @click="reloadDraftLinkOptions(true)">搜索</el-button></template></el-input><el-date-picker v-model="draftLinkDateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" @change="reloadDraftLinkOptions(true)" /><el-button @click="selectAllDraftLinks">{{ selectableDraftLinkOptions.every(draft=>draftLinkIds.includes(Number(draft.id))) && selectableDraftLinkOptions.length ? '取消本页全选' : '全选当前页' }}</el-button></div><div v-loading="draftLinkLoading" class="draft-choice-list"><button v-for="draft in filteredDraftLinkOptions" :key="draft.id" type="button" class="draft-choice-card" :class="{selected:draftLinkIds.includes(Number(draft.id)),linked:draftLinkExistingIds.has(Number(draft.id))}" :disabled="draftLinkExistingIds.has(Number(draft.id))" @click="toggleDraftLink(draft)"><el-image :src="draftCardImage(draft)" fit="cover"><template #error><div class="draft-choice-empty">无图</div></template></el-image><div class="draft-choice-main"><strong>{{ draft.product_name || '未命名草稿' }}</strong><span>{{ draft.internal_code || `草稿 #${draft.id}` }}</span><div><el-tag v-if="draftLinkExistingIds.has(Number(draft.id))" size="small" type="success">已关联</el-tag><el-tag v-else size="small">{{ draft.development_type==='fission'?'裂变草稿':'普通草稿' }}</el-tag><small>{{ [draft.vehicle_brand,draft.vehicle_model].filter(Boolean).join(' · ') || '未填写车型/款式' }}</small></div><small>创建于 {{ shanghaiDateTimeText(draft.created_at) }}</small></div><CircleCheck :size="22" class="draft-choice-check" /></button><el-empty v-if="!filteredDraftLinkOptions.length" description="该负责人在当前查询条件下暂无草稿" /></div><div class="draft-link-pagination"><span>筛选结果 {{ draftLinkTotal }} 条，已跨页选择 {{ draftLinkIds.length }} 条</span><el-pagination background :current-page="draftLinkPage" :page-size="draftLinkPageSize" layout="prev, pager, next" :total="draftLinkTotal" @current-change="changeDraftLinkPage" /></div><p class="attach-tip">每页 10 条，翻页不会丢失已选草稿；关联后按草稿内变体数计入进度。</p><template #footer><el-button @click="draftLinkVisible=false">取消</el-button><el-button type="primary" :disabled="!draftLinkIds.length" @click="confirmDraftLink">关联所选 {{ draftLinkIds.length || '' }} 个草稿</el-button></template></el-dialog>
    <el-dialog v-model="ideaVisible" :title="ideaForm.id ? '编辑灵感' : '快速创建灵感'" width="720px" align-center @paste="handleIdeaImagePaste"><el-form label-position="top"><el-form-item label="标题" required><el-input v-model="ideaForm.title" placeholder="一句话记录这个产品灵感" /></el-form-item><el-form-item label="主图"><div class="idea-image-editor"><button type="button" class="idea-image-dropzone" :class="{ uploading: ideaImageUploading }" @click="chooseIdeaImage" @dragover.prevent @drop.prevent="handleIdeaImageDrop"><el-image v-if="ideaForm.image_url" :src="ideaForm.image_url" fit="cover"><template #error><div class="empty-image">图片无法预览</div></template></el-image><div v-else class="idea-image-placeholder"><ImagePlus :size="30" /><strong>{{ ideaImageUploading ? '正在上传…' : '点击、拖拽或粘贴图片' }}</strong><span>支持 Ctrl+V 粘贴，建议使用 3:4 图片</span></div><div v-if="ideaForm.image_url" class="idea-image-change"><Upload :size="15" /> 更换图片</div></button><div class="idea-image-link"><span>也可以添加图片链接</span><el-input v-model="ideaForm.image_url" clearable placeholder="https://..." /></div><input ref="ideaFileInput" class="hidden-file-input" type="file" accept="image/*" @change="handleIdeaFileChange" /></div></el-form-item><el-form-item label="参考链接"><el-input v-model="ideaForm.source_url" placeholder="1688、Ozon、WB 或其他链接" /></el-form-item><el-form-item label="备注"><el-input v-model="ideaForm.note" type="textarea" :rows="3" placeholder="补充卖点、成本判断或需要验证的问题" /></el-form-item><div class="form-grid"><el-form-item label="紧急度（1-10）"><el-slider v-model="ideaForm.urgency" :min="1" :max="10" show-input /></el-form-item><el-form-item label="重要度（1-10）"><el-slider v-model="ideaForm.importance" :min="1" :max="10" show-input /></el-form-item><el-form-item label="指定人员"><el-select v-model="ideaForm.assignee_person_id" filterable clearable placeholder="选择负责人"><el-option v-for="person in people" :key="person.id" :label="person.name" :value="person.id" /></el-select></el-form-item><el-form-item label="任务数量"><el-input-number v-model="ideaForm.target_product_count" :min="1" :max="999" controls-position="right" /></el-form-item><el-form-item label="截止时间"><el-date-picker v-model="ideaForm.development_due_at" type="date" value-format="YYYY-MM-DD" placeholder="选择截止日期" /></el-form-item></div></el-form><template #footer><el-button @click="ideaVisible=false">取消</el-button><el-button type="primary" :loading="ideaSaving" :disabled="ideaImageUploading" @click="saveIdea">保存灵感</el-button></template></el-dialog>
    <el-dialog v-model="taskVisible" width="1040px" align-center append-to-body class="task-detail-dialog" :show-close="false"><template #header><div class="task-dialog-header"><span class="task-dialog-icon" :class="taskTypeMeta(taskForm).value"><component :is="taskTypeMeta(taskForm).icon" :size="22" /></span><div><small>{{ taskTypeMeta(taskForm).label }}</small><h2>{{ taskForm.title || (taskForm.id ? '编辑任务' : '新增自定义任务') }}</h2><p>{{ taskForm.automation_key ? '进度由业务数据自动计算，负责人可人工指定' : '设置负责人、完成日期和固定进度档位' }}</p></div><button type="button" aria-label="关闭" @click="taskVisible=false">×</button></div></template><el-form label-position="top" class="task-detail-form"><template v-if="taskForm.automation_key"><div class="task-dialog-metrics"><article><span>当前进度</span><strong>{{ taskProgress(taskForm) }}%</strong><small>{{ taskProgressText(taskForm) }}</small></article><article><span>计划完成</span><strong>{{ taskForm.due_at || '-' }}</strong><small>任务节点日期</small></article><article><span>当前状态</span><strong><i class="task-status" :class="taskTone(taskForm)">{{ taskToneLabel(taskForm) }}</i></strong><small>系统实时判断</small></article></div><div class="task-dialog-progress"><el-progress :percentage="taskProgress(taskForm)" :stroke-width="10" :show-text="false" /><span>{{ taskStatisticsText(taskForm) }}</span></div><div v-if="isDailyOperationalTask(taskForm)" class="task-statistics-scope"><div><span>统计日期</span><strong>{{ taskStatisticsDate(taskForm) }}</strong></div><div><span>北京时间范围</span><strong>{{ taskRelated(taskForm).window }}</strong></div><p>统计范围固定为前一自然日，当天新增订单不会改变本任务分母。</p></div><section v-if="isDailyOperationalTask(taskForm)" v-loading="taskDetailLoading" class="operational-detail-section"><header><div><span>{{ taskForm.type==='procurement_daily' ? '待采购订单' : '未完成订单与原因' }}</span><h3>{{ taskForm.type==='procurement_daily' ? '具体处理清单' : '发货异常诊断' }}</h3></div><b v-if="taskOperationalDetails.summary?.warning">{{ taskOperationalDetails.summary.warning }} 项需警惕</b></header><div v-if="taskForm.type==='shipping_daily'" class="reason-filter-tabs"><button v-for="item in taskReasonFilters()" :key="item.value" type="button" :class="{active:taskDetailReason===item.value}" @click="taskDetailReason=item.value;taskDetailPage=1">{{ item.label }}<b>{{ item.count }}</b></button></div><div class="operational-order-list"><article v-for="row in taskDetailRows" :key="row.row_id"><el-image class="order-alert-image" :src="row.image_url" fit="cover" :preview-src-list="row.image_url ? [row.image_url] : []" preview-teleported><template #error><div class="order-alert-image-empty">无图</div></template></el-image><div class="order-alert-main"><div class="order-alert-title"><strong>{{ row.order_number }}</strong><span class="reason-badge" :class="taskReasonTone(row)">{{ row.reason_label }}</span></div><span>{{ row.shop_name || '未标注店铺' }} · {{ Number(row.quantity || 0) }} 件</span><span class="order-alert-time"><Clock3 :size="12" />出单时间：{{ taskOrderTimeText(row) }}</span><p>{{ row.product_names || row.sku_summary || '暂无商品名称' }}</p><div class="order-alert-meta"><small v-if="row.procurement_status">采购状态：{{ row.procurement_status }}</small><small v-if="row.sku_summary">SKU：{{ row.sku_summary }}</small><el-button link type="primary" @click="enterTaskWorkspace(taskForm)">去处理</el-button></div></div></article><el-empty v-if="!taskDetailLoading && !taskDetailFilteredRows.length" :image-size="54" description="当前分类没有待处理订单" /></div><el-pagination v-if="taskDetailFilteredRows.length>taskDetailPageSize" v-model:current-page="taskDetailPage" small background layout="prev, pager, next" :page-size="taskDetailPageSize" :total="taskDetailFilteredRows.length" /></section><div class="task-owner-card"><div><el-avatar :src="personAvatar(taskForm.owner_person_id)" :size="42">{{ personInitial(taskForm.owner_name) }}</el-avatar><div><strong>任务负责人</strong><small>自动刷新进度时不会覆盖人工指定人员</small></div></div><el-select v-model="taskForm.owner_person_id" filterable clearable placeholder="选择负责人"><el-option v-for="person in people" :key="person.id" :label="person.name" :value="person.id" /></el-select></div></template><template v-else><el-form-item label="任务名称" required><el-input v-model="taskForm.title" placeholder="明确写清需要完成的工作" /></el-form-item><div class="form-grid"><el-form-item label="负责人"><el-select v-model="taskForm.owner_person_id" filterable clearable placeholder="选择负责人"><el-option v-for="person in people" :key="person.id" :label="person.name" :value="person.id" /></el-select></el-form-item><el-form-item label="计划完成日期"><el-date-picker v-model="taskForm.due_at" type="date" value-format="YYYY-MM-DD" /></el-form-item></div><el-form-item label="当前进度"><div class="custom-progress-steps"><button type="button" :class="{active:taskProgress(taskForm)===0}" @click="setCustomProgress(0)">未开始 0%</button><button type="button" :class="{active:taskProgress(taskForm)===25}" @click="setCustomProgress(25)">已开始 25%</button><button type="button" :class="{active:taskProgress(taskForm)===50}" @click="setCustomProgress(50)">完成一半 50%</button><button type="button" :class="{active:taskProgress(taskForm)===100}" @click="setCustomProgress(100)">已完成 100%</button></div></el-form-item><el-form-item label="完成标准"><el-input v-model="taskForm.deliverable" type="textarea" :rows="2" placeholder="什么结果才算完成" /></el-form-item><el-form-item label="当前进展 / 结果"><el-input v-model="taskForm.result" type="textarea" :rows="2" /></el-form-item></template></el-form><template #footer><div class="task-dialog-footer"><el-button @click="taskVisible=false">取消</el-button><el-button v-if="taskForm.automation_key && taskForm.type!=='custom'" @click="taskVisible=false;enterTaskWorkspace(taskForm)">进入对应工作台</el-button><el-button type="primary" :loading="taskSaving" @click="saveTask">{{ taskForm.automation_key ? '保存负责人' : '保存任务' }}</el-button></div></template></el-dialog>
    <el-dialog v-model="attachVisible" title="加入现有库存产品" width="520px" align-center><p class="attach-tip">选择后只增加开发进度，不会复制或修改库存产品资料。</p><el-select v-model="attachProductId" filterable placeholder="按产品名称或编号选择" style="width:100%"><el-option v-for="row in attachOptions" :key="row.id" :value="row.id" :label="`${row.name}（${row.code || `#${row.id}`}）`" /></el-select><template #footer><el-button @click="attachVisible=false">取消</el-button><el-button type="primary" @click="confirmAttachProduct">加入开发看板</el-button></template></el-dialog>
    <el-dialog v-model="bindVisible" title="绑定库存产品" width="560px" align-center><p class="attach-tip">Ozon SKU：{{ bindRecord?.online_ozon_sku || bindRecord?.ozon_sku || '等待生成' }}。绑定后历史订单也会沿 SKU 归集到该库存产品。</p><el-select v-model="bindProductId" filterable placeholder="选择对应库存产品" style="width:100%"><el-option v-for="row in bindProductOptions" :key="row.id" :value="row.id" :label="`${row.name}（${row.code || `#${row.id}`}）`" /></el-select><template #footer><el-button @click="bindVisible=false">取消</el-button><el-button type="primary" @click="confirmBind">确认绑定</el-button></template></el-dialog>
    <el-drawer v-model="editVisible" size="520px" direction="rtl" destroy-on-close><template #header><div class="drawer-title"><span>开发推进</span><h2>{{ current?.title }}</h2><small>{{ current?.product_code || `库存产品 #${current?.product_id}` }}</small></div></template><div v-if="current" class="drawer-body"><div class="master-card"><el-image :src="productImage(current)" fit="cover"><template #error><div class="empty-image">无图</div></template></el-image><div><strong>产品主档来自库存中心</strong><p>{{ current.category || '未分类' }} · {{ current.brand || '未填品牌' }} · {{ current.vehicle_model || '未填车型' }}</p><el-button link type="primary" @click="editInventoryProduct(current)">编辑完整产品资料</el-button></div></div><el-form label-position="top"><el-form-item label="所属项目"><el-select v-model="metaForm.project_id" clearable filterable placeholder="可选"><el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item><div class="form-grid"><el-form-item label="开发阶段"><el-select v-model="metaForm.status"><el-option v-for="stage in stages" :key="stage.value" :label="stage.label" :value="stage.value" /></el-select></el-form-item><el-form-item label="优先级"><el-select v-model="metaForm.priority"><el-option label="高优先级" value="high" /><el-option label="常规" value="medium" /><el-option label="低优先级" value="low" /></el-select></el-form-item></div><el-form-item label="计划上架日期"><el-date-picker v-model="metaForm.planned_listing_at" type="date" value-format="YYYY-MM-DD" /></el-form-item><el-form-item label="当前进展 / 下一步"><el-input v-model="metaForm.note" type="textarea" :rows="4" placeholder="记录目前做到哪里、下一步做什么" /></el-form-item><el-form-item label="评审结论"><el-input v-model="metaForm.decision_note" type="textarea" :rows="3" placeholder="记录为什么继续、暂停或调整" /></el-form-item></el-form><div class="drawer-actions"><el-button @click="saveMeta">保存进度</el-button><el-button type="primary" @click="createListingDraft(current)"><Rocket :size="16" /> 创建上架草稿</el-button></div></div></el-drawer>
  </div>
</template>

<style scoped>
.attach-tip{margin-top:0;color:#667085}.bindings-page,.analytics-page{padding:22px}.binding-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.binding-metrics article{display:grid;padding:15px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc}.binding-metrics span{font-size:13px;color:#667085}.binding-metrics strong{font-size:26px}.cell-sub{margin-top:4px;color:#98a2b3;font-size:12px}.method-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:22px 0}.method-grid article{display:grid;padding:24px;border:1px solid #dde5ef;border-radius:16px;background:linear-gradient(145deg,#fff,#f6f9fd)}.method-grid article.ai_fission{background:linear-gradient(145deg,#f3f7ff,#edf3ff);border-color:#ccdcf7}.method-grid article>span{color:#52657e}.method-grid article>strong{font-size:42px;color:#235fb8}.method-grid article>small{color:#7b8797}.method-grid article>div{display:grid;grid-template-columns:auto 1fr auto 1fr auto 1fr;gap:8px;align-items:end;margin-top:20px;padding-top:16px;border-top:1px solid #dfe6ef}.method-grid b{font-size:20px}.method-grid em{font-style:normal;color:#8591a2;font-size:12px}.development-center{min-height:100%;padding:22px;background:#f4f7fb;color:#172033}.hero{display:flex;justify-content:space-between;align-items:center;padding:26px 30px;border-radius:18px;background:linear-gradient(120deg,#12233f,#214c83);color:#fff;box-shadow:0 14px 32px #183d6c2b}.hero span,.section-title span{font-size:12px;letter-spacing:1.5px;opacity:.72}.hero h1{margin:5px 0 8px;font-size:29px}.hero p{margin:0;color:#dbe8f8}.hero-actions{display:flex;gap:10px}.tabs{display:flex;gap:5px;margin:18px 0;padding:5px;border:1px solid #e3e9f2;border-radius:12px;background:#fff;width:max-content}.tabs button{display:flex;align-items:center;gap:7px;padding:9px 16px;border:0;border-radius:9px;background:transparent;color:#667085;cursor:pointer}.tabs button.active{background:#eaf2ff;color:#2463c7;font-weight:700}.panel{border:1px solid #e2e8f0;border-radius:16px;background:#fff;box-shadow:0 4px 18px #1f3b6410}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.metrics article{display:flex;gap:14px;align-items:center;padding:20px;border:1px solid #e2e8f0;border-radius:15px;background:#fff}.metrics svg{padding:10px;width:42px;height:42px;border-radius:12px;background:#edf4ff;color:#2d6fd2}.metrics div{display:grid}.metrics span{font-size:13px;color:#667085}.metrics strong{font-size:28px}.metrics small{color:#98a2b3}.section-title{display:flex;align-items:center;justify-content:space-between}.section-title h2{margin:4px 0 0;font-size:20px}.workflow{margin-top:15px;padding:22px}.workflow-steps{display:flex;align-items:center;gap:15px;margin-top:20px}.workflow-steps>div{flex:1;display:grid;gap:5px;padding:16px;border-radius:12px;background:#f7f9fc}.workflow-steps b{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:#2f6ed2;color:#fff}.workflow-steps small{color:#7a8699;line-height:1.5}.workflow-steps i{color:#99a8bc}.focus-list{margin-top:15px;padding:22px}.product-rows{margin-top:14px}.product-rows article{display:grid;grid-template-columns:58px minmax(230px,1fr) 120px 140px auto auto;align-items:center;gap:14px;padding:10px 4px;border-top:1px solid #edf0f5}.product-rows .el-image,.master-card .el-image{width:58px;height:72px;border-radius:8px;background:#f0f3f7}.product-main{display:grid;gap:7px}.product-main small{color:#7a8699}.empty-image{display:grid;place-items:center;width:100%;height:100%;color:#a3adba;font-size:12px}.toolbar{display:flex;justify-content:space-between;padding:14px}.toolbar>div{display:flex;gap:10px}.toolbar .el-input{width:360px}.toolbar .el-select{width:200px}.board{display:grid;grid-template-columns:repeat(6,minmax(220px,1fr));gap:12px;margin-top:14px;overflow-x:auto}.board>section{min-height:560px;padding:10px;border-radius:14px;background:#eaf0f7}.board>section>header{display:flex;justify-content:space-between;padding:7px}.board>section>header b{padding:2px 8px;border-radius:10px;background:#fff;color:#567}.board article{margin-top:9px;padding:11px;border:1px solid #dce3ed;border-radius:12px;background:#fff;cursor:pointer}.card-head{display:flex;justify-content:space-between}.card-head .el-image{width:64px;height:84px;border-radius:8px;background:#f0f3f7}.board h3{margin:10px 0 4px;font-size:14px}.board p{margin:0;color:#8792a3;font-size:12px}.facts{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:11px;color:#657287;font-size:12px}.facts span{display:flex;align-items:center;gap:4px}.board footer{display:flex;justify-content:flex-end;margin-top:7px;border-top:1px solid #eef1f5}.projects-page{padding:22px}.project-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px}.project-grid article{padding:18px;border:1px solid #e1e7ef;border-radius:12px}.project-grid p{min-height:38px;color:#718096}.project-grid div{display:flex;gap:18px;color:#4d6684;font-size:13px}.drawer-title h2{margin:4px 0}.drawer-title small{color:#8a96a8}.drawer-body{padding:0 6px}.master-card{display:flex;gap:14px;padding:14px;margin-bottom:18px;border-radius:12px;background:#f4f7fb}.master-card>div{flex:1}.master-card p{color:#6b778a}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.drawer-actions{display:flex;justify-content:flex-end;gap:10px;padding-top:14px;border-top:1px solid #e8edf3}@media(max-width:1200px){.metrics{grid-template-columns:repeat(2,1fr)}.board{grid-template-columns:repeat(6,230px)}.product-rows article{grid-template-columns:58px 1fr 110px auto}.product-rows article>span,.product-rows article>.el-button:first-of-type{display:none}}@media(max-width:720px){.development-center{padding:12px}.hero{align-items:flex-start;flex-direction:column;gap:18px}.metrics,.binding-metrics,.method-grid{grid-template-columns:1fr}.workflow-steps{display:grid}.workflow-steps i{display:none}.toolbar,.toolbar>div{align-items:stretch;flex-direction:column;gap:10px}.toolbar .el-input,.toolbar .el-select{width:100%}.project-grid{grid-template-columns:1fr}}
.tasks-page{display:grid;gap:14px}.task-overview-toolbar{display:flex;align-items:center;gap:12px;padding:14px 16px;flex-wrap:wrap}.task-range-tabs{display:flex;padding:4px;border-radius:10px;background:#f1f5f9}.task-range-tabs button{min-width:58px;padding:8px 14px;border:0;border-radius:8px;background:transparent;color:#667085;cursor:pointer}.task-range-tabs button.active{background:#fff;color:#2463c7;font-weight:700;box-shadow:0 2px 10px #1f3b641c}.task-date-nav{display:flex;align-items:center;gap:6px}.task-date-nav strong{min-width:210px;text-align:center;font-size:13px}.binding-actions,.task-filters{display:flex;gap:10px;align-items:center}.task-filters{margin-left:auto}.task-filters .el-input{width:250px}.task-filters .el-select{width:125px}.task-summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.task-summary-grid article{position:relative;display:flex;align-items:center;gap:14px;min-height:92px;padding:16px 18px;box-sizing:border-box;overflow:hidden}.task-summary-grid article:after{position:absolute;right:0;bottom:0;left:0;height:3px;background:#64748b;content:""}.task-summary-grid article.done:after{background:#22a861}.task-summary-grid article.doing:after{background:#3f8cff}.task-summary-grid article.overdue:after{background:#ef5350}.task-metric-icon{display:grid;place-items:center;flex:0 0 46px;width:46px;height:46px;border-radius:13px;background:#eef3f9;color:#52657e}.task-summary-grid .done .task-metric-icon{background:#e9f8ef;color:#16864b}.task-summary-grid .doing .task-metric-icon{background:#eaf2ff;color:#2463c7}.task-summary-grid .overdue .task-metric-icon{background:#fff0f0;color:#d94040}.task-summary-grid span{display:block;color:#667085;font-size:13px}.task-summary-grid strong{display:block;margin-top:1px;font-size:28px;line-height:1.05}.task-summary-grid small{display:block;margin-top:4px;color:#98a2b3;font-size:11px}.timeline-panel{padding:20px 22px}.timeline-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.timeline-head h2{margin:4px 0 0;font-size:20px}.timeline-head>div>span{color:#7b8797;font-size:12px}.timeline-legend{display:flex;gap:16px;flex-wrap:wrap;padding-top:5px}.timeline-legend span{display:flex;align-items:center;gap:6px;color:#52657e;font-size:12px}.timeline-legend span:before{width:9px;height:9px;border-radius:50%;background:#64748b;content:""}.timeline-legend .done:before{background:#22a861}.timeline-legend .doing:before{background:#3f8cff}.timeline-legend .risk:before{background:#f59e0b}.timeline-legend .overdue:before{background:#ef5350}.timeline-chart{display:grid;grid-template-columns:50px 1fr;grid-template-rows:280px 30px;margin-top:22px}.timeline-y{display:flex;flex-direction:column;justify-content:space-between;padding:0 10px 0 0;color:#7b8797;font-size:11px;text-align:right}.timeline-plot{position:relative;border-left:1px solid #d8e1ec;border-bottom:1px solid #d8e1ec;background:#fbfcfe;overflow:visible}.timeline-grid-line{position:absolute;right:0;left:0;border-top:1px dashed #dce5ef}.timeline-vertical-line{position:absolute;top:0;bottom:0;border-left:1px solid #edf1f6}.timeline-node{position:absolute;display:flex;align-items:center;gap:7px;width:210px;transform:translate(-17px,50%);cursor:pointer;z-index:2}.timeline-node .el-avatar{flex:none;border:3px solid #3f8cff;background:#e8eef8;color:#52637a;box-shadow:0 3px 10px #17203326}.timeline-node>div{display:grid;min-width:0;max-width:158px;padding:6px 9px;border:1px solid #dbe3ed;border-radius:9px;background:#fff;box-shadow:0 5px 14px #17203316}.timeline-node strong{overflow:hidden;color:#243247;font-size:12px;white-space:nowrap;text-overflow:ellipsis}.timeline-node small{overflow:hidden;margin-top:2px;color:#7b8797;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.timeline-node.done .el-avatar{border-color:#22a861}.timeline-node.risk .el-avatar{border-color:#f59e0b}.timeline-node.overdue .el-avatar{border-color:#ef5350}.timeline-node.closed .el-avatar{border-color:#94a3b8;filter:grayscale(1)}.timeline-x{grid-column:2;display:flex;justify-content:space-between;padding-top:9px;color:#7b8797;font-size:11px}.task-list-panel{padding:18px 20px 20px}.task-list-panel .el-table{margin-top:14px}.task-status{display:inline-flex;padding:4px 9px;border-radius:999px;background:#eaf2ff;color:#2463c7;font-size:12px;font-weight:700}.task-status.done{background:#e9f8ef;color:#16864b}.task-status.risk{background:#fff4dc;color:#ad6800}.task-status.overdue{background:#fff0f0;color:#d94040}.task-status.closed{background:#f1f3f5;color:#667085}.binding-note{margin-top:14px;padding:10px 12px;border-radius:8px;background:#f7f9fc;color:#667085;font-size:13px}@media(max-width:1200px){.task-filters{margin-left:0;width:100%}.task-summary-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:1050px){.timeline-node{width:auto}.timeline-node>div{display:none}}@media(max-width:720px){.task-summary-grid{grid-template-columns:1fr 1fr}.task-summary-grid article{min-height:78px;padding:12px}.task-summary-grid small{display:none}.task-date-nav strong{min-width:150px}.task-filters{align-items:stretch;flex-direction:column}.task-filters .el-input,.task-filters .el-select{width:100%}.timeline-chart{grid-template-rows:250px 28px}}
.person-inline{display:flex;align-items:center;gap:7px}.person-inline .el-avatar,.idea-people-row .el-avatar{flex:none;background:#e8eef8;color:#52637a}.idea-people-row>span{display:flex;align-items:center;gap:7px}
.binding-guide{margin-top:16px}
.ideas-page{padding:18px}.idea-image{width:64px;height:84px;border-radius:8px;background:#f0f3f7}.idea-grid{display:grid;grid-template-columns:repeat(2,minmax(520px,1fr));gap:12px;margin-top:14px}.idea-card{display:grid;grid-template-columns:132px 1fr;min-height:160px;overflow:hidden;border:1px solid #dfe6ef;border-radius:13px;background:#fff}.idea-card-image{width:132px;height:100%;min-height:160px;background:#f0f3f7}.idea-card-content{display:grid;grid-template-rows:auto auto auto;gap:10px;padding:12px 14px}.idea-card-content header{display:flex;justify-content:space-between;gap:10px}.idea-card h3{margin:1px 0 5px}.idea-card p{display:-webkit-box;overflow:hidden;margin:0;color:#667085;font-size:13px;-webkit-line-clamp:1;-webkit-box-orient:vertical}.idea-card small{color:#98a2b3}.idea-controls{display:grid;grid-template-columns:auto auto minmax(115px,1fr) 88px 142px;gap:7px;align-items:center}.idea-controls .el-input-number,.idea-controls .el-date-editor{width:100%}.idea-card footer{display:flex;align-items:center;justify-content:flex-end;gap:7px;padding-top:8px;border-top:1px solid #edf0f5}.idea-card footer small{margin-right:auto}.development-tasks{margin-bottom:14px;padding:20px}.development-task-list{display:grid;gap:12px;margin-top:16px}.development-task-list>article{display:grid;grid-template-columns:minmax(220px,1.2fr) minmax(200px,1fr) minmax(260px,1.4fr) 100px 100px;gap:16px;align-items:center;padding:14px;border:1px solid #dfe6ef;border-radius:12px}.development-task-list>article.overdue{border-color:#f56c6c;background:#fff5f5}.task-claim{display:flex;gap:12px}.task-claim>div,.task-progress,.task-drafts,.task-orders{display:grid;gap:5px}.task-drafts>div{display:flex;justify-content:space-between;gap:8px}.task-orders{text-align:center}.task-orders>strong{font-size:26px;color:#2463c7}@media(max-width:1400px){.idea-grid{grid-template-columns:1fr}.development-task-list>article{grid-template-columns:1fr 1fr}.task-actions{grid-column:2}}@media(max-width:800px){.idea-grid,.development-task-list>article{grid-template-columns:1fr}.idea-card{grid-template-columns:100px 1fr}.idea-card-image{width:100px}.idea-controls{grid-template-columns:1fr 1fr}.idea-controls .el-select{grid-column:1/-1}.idea-card footer small{display:none}.task-actions{grid-column:auto}}
.project-product-table{margin-top:18px}
.category-summary{display:flex;gap:18px;margin-top:18px;color:#667085}.category-summary b{color:#245fae}.category-card-head{display:grid!important;grid-template-columns:34px 1fr auto!important;align-items:center;gap:8px!important}.category-card-head>b{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:#eaf2ff;color:#2768c7}.category-card-head>strong{font-size:16px}.category-card-head>em{font-style:normal;font-size:26px;font-weight:800;color:#245fae}.project-grid{grid-template-columns:repeat(4,minmax(220px,1fr))}.project-card p{min-height:auto;margin:14px 0;color:#738198}.project-card .el-progress{margin:12px 0 4px}@media(max-width:1400px){.project-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:1000px){.project-grid{grid-template-columns:repeat(2,1fr)}}
.idea-image-editor{display:grid;grid-template-columns:150px 1fr;gap:16px;width:100%;align-items:center}.idea-image-dropzone{position:relative;width:120px;height:160px;padding:0;overflow:hidden;border:2px dashed #b9c8dc;border-radius:10px;background:#f7f9fc;color:#667085;cursor:pointer}.idea-image-dropzone:hover{border-color:#409eff;background:#f0f7ff}.idea-image-dropzone.uploading{pointer-events:none;opacity:.7}.idea-image-dropzone .el-image{width:100%;height:100%}.idea-image-placeholder{display:grid;place-items:center;gap:6px;padding:14px;height:100%;box-sizing:border-box}.idea-image-placeholder span{font-size:11px;line-height:1.4}.idea-image-change{position:absolute;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;gap:5px;padding:7px;background:#172033cc;color:#fff;font-size:12px}.idea-image-link{display:grid;gap:8px}.idea-image-link span{color:#667085;font-size:13px}.hidden-file-input{display:none}@media(max-width:720px){.idea-image-editor{grid-template-columns:1fr}.idea-image-dropzone{width:120px}}
.metrics{grid-template-columns:repeat(5,1fr)}.metric-link{cursor:pointer;transition:transform .16s ease,box-shadow .16s ease}.metric-link:hover{transform:translateY(-2px);box-shadow:0 8px 22px #1f3b6418}@media(max-width:1400px){.metrics{grid-template-columns:repeat(3,1fr)}}@media(max-width:900px){.metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:720px){.metrics{grid-template-columns:1fr}}
.hero{align-items:stretch;flex-direction:column;gap:18px;padding:22px 30px 14px}.hero-main{display:flex;justify-content:space-between;align-items:center}.tabs{max-width:100%;margin:0;padding:4px;width:max-content;box-sizing:border-box;overflow-x:auto;border-color:#ffffff30;border-radius:11px;background:#ffffff14}.tabs button{flex:none;padding:8px 15px;border-radius:8px;color:#dbe8f8}.tabs button:hover{background:#ffffff14;color:#fff}.tabs button.active{background:#fff;color:#2463c7}@media(max-width:720px){.hero{gap:14px;padding:18px}.hero-main{align-items:flex-start;flex-direction:column;gap:18px;width:100%}.tabs{width:100%}}
.hero{margin-bottom:14px}.hero h1{display:flex;align-items:center;gap:9px}
.hero{align-items:center;flex-direction:row;justify-content:space-between;gap:24px;padding:14px 22px}.hero h1{flex:none;margin:0;font-size:24px}.hero-nav{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:0}.quick-development{flex:none}.quick-development :deep(.el-button){display:inline-flex;align-items:center;gap:6px}.tabs{min-width:0}@media(max-width:1100px){.hero{align-items:stretch;flex-direction:column;gap:12px}.hero-nav{justify-content:flex-start}}@media(max-width:720px){.hero-nav{align-items:stretch;flex-direction:column}.quick-development{align-self:flex-start}}
.idea-controls{grid-template-columns:122px 122px minmax(150px,1fr) 96px 150px;gap:8px}.priority-input{display:flex;align-items:center;gap:5px;min-width:0;height:32px;border:0;background:transparent}.priority-input span{flex:0 0 34px;text-align:left;font-size:12px;font-weight:600}.priority-input .el-input-number{flex:0 0 82px;width:82px!important;height:32px}.priority-input.urgent{color:#d94b4b}.priority-input.important{color:#b87816}.idea-controls>.el-select,.idea-controls>.el-input-number,.idea-controls>.el-date-editor{min-width:0;width:100%!important}.idea-card-content{min-width:0}.idea-card-content header>div{min-width:0}
@media(min-width:1100px){.idea-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.idea-controls{grid-template-columns:repeat(3,minmax(0,1fr))}.priority-input{width:100%}.priority-input .el-input-number{flex:1 1 auto;width:auto!important}.idea-card footer small{display:none}}
.idea-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.idea-card{grid-template-columns:124px minmax(0,1fr);min-height:184px;padding:12px;gap:14px;border-color:#d8e2ef;box-shadow:0 5px 16px #1f3b640d;transition:transform .16s ease,box-shadow .16s ease}.idea-card:hover{transform:translateY(-2px);box-shadow:0 9px 24px #1f3b6417}.idea-card-media{position:relative;width:122px;height:164px;padding:5px;box-sizing:border-box;border:2px solid #c8d6e8;border-radius:11px;background:#f4f7fb}.idea-card-media .el-image{width:100%;height:100%;overflow:hidden;border-radius:7px;background:#e9eef5}.replace-image-button{position:absolute;right:9px;bottom:9px;left:9px;width:calc(100% - 18px);padding:6px;background:#fffffff0}.idea-card-content{display:grid;grid-template-rows:auto auto auto 1fr;gap:9px;min-width:0;padding:1px 0 0}.idea-card-content header{display:grid;grid-template-columns:1fr auto;align-items:start;gap:5px 10px;padding-bottom:8px;border-bottom:1px solid #edf1f6}.idea-card-content header>p{grid-column:1/2}.idea-card-content header>.el-link{grid-column:2;grid-row:2}.idea-title-line{grid-column:1/-1;display:flex;align-items:center;gap:6px;min-width:0}.idea-title-line h3{overflow:hidden;margin:0 4px 0 0;font-size:16px;white-space:nowrap;text-overflow:ellipsis}.task-count,.priority-badge{flex:none;padding:3px 7px;border-radius:999px;font-size:11px;font-weight:700;line-height:1.4}.task-count{background:#eef4ff;color:#316bc1}.priority-badge.urgent{background:#fff0f0;color:#d84a4a}.priority-badge.important{background:#fff7e8;color:#b66d08}.idea-people-row,.idea-meta-row{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;background:#f7f9fc}.idea-people-row>span,.idea-meta-row>span{display:flex;align-items:center;gap:7px;min-width:0;color:#344054;font-size:12px;white-space:nowrap}.idea-people-row b,.idea-meta-row b{color:#7a8699;font-size:12px;font-weight:600}.idea-card-content>footer{align-self:end;display:flex;justify-content:flex-end;gap:7px;padding-top:7px;border-top:1px solid #edf1f6}.idea-card-content>footer .el-button{min-width:76px}@media(max-width:1250px){.idea-grid{grid-template-columns:1fr}}@media(max-width:720px){.idea-card{grid-template-columns:100px minmax(0,1fr)}.idea-card-media{width:98px;height:132px}.idea-people-row,.idea-meta-row{grid-template-columns:1fr}.idea-title-line{flex-wrap:wrap}.idea-title-line h3{width:100%}}
.task-workflow-panel{padding:20px}.workflow-column-head,.task-workflow-list>article{display:grid;grid-template-columns:minmax(230px,1.15fr) minmax(220px,1fr) minmax(280px,1.35fr) 130px;gap:0}.workflow-column-head{margin-top:16px;border:1px solid #dfe6ef;border-bottom:0;border-radius:12px 12px 0 0;background:#f5f8fc}.workflow-column-head span{padding:11px 14px;border-right:1px solid #dfe6ef;color:#52657e;font-size:13px;font-weight:700}.workflow-column-head span:last-child{border-right:0}.task-workflow-list>article{border:1px solid #dfe6ef;background:#fff}.task-workflow-list>article+article{border-top:0}.task-workflow-list>article:last-of-type{border-radius:0 0 12px 12px}.task-workflow-list>article.overdue{border-color:#f56c6c;background:#fff4f4}.task-workflow-list>article>section{display:flex;min-height:150px;padding:14px;box-sizing:border-box;border-right:1px solid #e5eaf1}.task-workflow-list>article>section:last-child{border-right:0}.workflow-claim{align-items:flex-start;justify-content:space-between;gap:10px}.workflow-title{display:flex;gap:11px;min-width:0}.workflow-title>div{display:grid;gap:6px;min-width:0}.workflow-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workflow-title small,.workflow-progress small,.workflow-orders small{color:#8290a3}.workflow-progress{flex-direction:column;gap:9px}.workflow-progress>div strong{font-size:28px;color:#2463c7}.workflow-progress>div span{margin-left:5px;color:#667085}.overdue-text{color:#e5484d!important;font-weight:700}.claim-tip{color:#98a2b3;font-size:13px}.workflow-drafts{flex-direction:column;gap:7px;overflow:auto;max-height:190px}.workflow-draft{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;border-radius:7px;background:#f7f9fc}.workflow-draft>div{display:grid;gap:3px;min-width:0}.workflow-draft strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.workflow-draft small{color:#8995a7}.workflow-orders{align-items:center;justify-content:center;flex-direction:column;gap:5px;text-align:center}.workflow-orders strong{font-size:32px;color:#2463c7}.workflow-orders span{font-weight:700}.task-workflow-list>.el-empty{padding:70px 0}@media(max-width:1100px){.workflow-column-head{display:none}.task-workflow-list>article{grid-template-columns:1fr 1fr;margin-top:12px;border:1px solid #dfe6ef!important;border-radius:12px!important}.task-workflow-list>article>section:nth-child(2){border-right:0}.task-workflow-list>article>section:nth-child(-n+2){border-bottom:1px solid #e5eaf1}}
.idea-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.idea-card{grid-template-columns:100px minmax(0,1fr);min-height:158px;padding:10px;gap:11px}.idea-card-media{width:98px;height:132px;padding:4px}.replace-image-button{right:7px;bottom:7px;left:7px;width:calc(100% - 14px);min-height:26px;padding:4px 2px;font-size:11px}.idea-card-content{gap:7px}.idea-card-content header{gap:3px 7px;padding-bottom:6px}.idea-title-line{gap:4px;flex-wrap:wrap}.idea-title-line h3{max-width:100%;font-size:15px}.task-count,.priority-badge{padding:2px 5px;font-size:10px}.idea-people-row,.idea-meta-row{gap:6px;padding:6px 7px}.idea-people-row>span,.idea-meta-row>span,.idea-people-row b,.idea-meta-row b{font-size:11px}.idea-meta-row>span{white-space:normal}.idea-card-content>footer{gap:5px;padding-top:5px}.idea-card-content>footer .el-button{min-width:64px;padding-right:9px;padding-left:9px}@media(max-width:1050px){.idea-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:720px){.idea-grid{grid-template-columns:1fr}}
.task-list-panel{padding:0!important;overflow:hidden}.task-list-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;padding:13px 16px;border:0;background:#fff;color:#243247;cursor:pointer}.task-list-toggle>div{display:flex;align-items:center;gap:8px}.task-list-toggle svg{color:#3977d5;transition:transform .18s}.task-list-toggle svg.collapsed{transform:rotate(-90deg)}.task-list-toggle span{font-size:15px;font-weight:750}.task-list-toggle b{display:grid;place-items:center;min-width:23px;height:23px;padding:0 6px;border-radius:999px;background:#eaf2ff;color:#2868c7;font-size:11px}.task-list-toggle>small{color:#8a96a8}.task-list-body{padding:0 14px 12px;border-top:1px solid #edf1f6}.task-list-body .el-table{margin-top:0}.task-list-body :deep(.el-table__header th){height:38px;background:#f7f9fc;color:#52657e;font-size:12px}.task-list-body :deep(.el-table__row){height:50px}.task-list-body :deep(.el-table__cell){padding:6px 0}.task-name-cell{display:grid;gap:2px}.task-name-cell strong{overflow:hidden;color:#243247;font-size:12px;white-space:nowrap;text-overflow:ellipsis}.task-name-cell small{overflow:hidden;color:#98a2b3;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.task-progress-cell{display:grid;grid-template-columns:1fr 34px;align-items:center;gap:8px}.task-progress-cell span{color:#667085;font-size:11px}.task-row-actions{display:flex;justify-content:center;gap:6px}.task-row-actions .el-button{width:28px;height:28px}.task-pagination{display:flex;align-items:center;justify-content:space-between;padding:11px 4px 0}.task-pagination>span{color:#7b8797;font-size:11px}.timeline-avatar-stack{display:flex;align-items:center}.timeline-avatar-stack .el-avatar+.el-avatar{margin-left:-13px}.timeline-avatar-stack b{display:grid;place-items:center;width:28px;height:28px;margin-left:-10px;border:2px solid #fff;border-radius:50%;background:#e8eef8;color:#52657e;font-size:10px}.timeline-group-popover{display:grid;gap:5px}.timeline-group-popover>strong{padding:3px 4px 8px;color:#243247}.timeline-group-popover button{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px;border:0;border-radius:7px;background:#f7f9fc;color:#344054;cursor:pointer;text-align:left}.timeline-group-popover button:hover{background:#eaf2ff}.timeline-group-popover button span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.timeline-group-popover button small{flex:none;color:#7b8797}.timeline-panel{overflow:hidden}.timeline-chart{grid-template-rows:250px 30px}.timeline-node{width:225px}.tasks-page{max-height:calc(100vh - 190px);overflow:auto;padding-right:2px}.tasks-page::-webkit-scrollbar{width:6px}.tasks-page::-webkit-scrollbar-thumb{border-radius:6px;background:#cbd5e1}@media(max-width:720px){.task-list-body{overflow-x:auto}.task-pagination{align-items:flex-start;flex-direction:column;gap:8px}.tasks-page{max-height:none;overflow:visible}}
.task-type-tabs{display:flex;gap:8px;align-items:center}.task-type-tabs button{display:flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid #dfe6ef;border-radius:8px;background:#fff;color:#52657e;cursor:pointer}.task-type-tabs button.active{border-color:#3f8cff;background:#3f8cff;color:#fff}.task-type-tabs button.product_development:not(.active){color:#7c3aed}.task-type-tabs button.procurement_daily:not(.active){color:#ea7a13}.task-type-tabs button.shipping_daily:not(.active){color:#0891b2}.task-type-cell{display:inline-flex;align-items:center;gap:6px;font-size:12px}.task-type-cell.product_development{color:#7c3aed}.task-type-cell.procurement_daily{color:#ea7a13}.task-type-cell.shipping_daily{color:#0891b2}.task-type-cell.custom{color:#2f6ed2}.task-type-mark{display:grid;place-items:center;flex:none;width:22px;height:22px;border-radius:7px;background:#eaf2ff;color:#2f6ed2}.timeline-node.product_development .task-type-mark{background:#f3e8ff;color:#7c3aed}.timeline-node.procurement_daily .task-type-mark{background:#fff1df;color:#ea7a13}.timeline-node.shipping_daily .task-type-mark{background:#e6f8fb;color:#0891b2}.task-node-detail{display:grid;gap:10px}.task-node-detail header{display:flex;align-items:center;gap:8px;color:#243247}.task-node-detail dl{display:grid;gap:7px;margin:0}.task-node-detail dl>div{display:grid;grid-template-columns:76px 1fr;align-items:center}.task-node-detail dt{color:#7b8797;font-size:12px}.task-node-detail dd{margin:0;color:#344054;font-size:13px}.task-node-detail footer{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}.task-form-type{display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:12px;border-radius:10px;background:#f5f8fc;color:#2f6ed2}.task-form-type>div{display:grid;gap:2px}.task-form-type small{color:#7b8797}.automated-progress{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px;width:100%}.automated-progress span{color:#52657e;font-size:12px}.custom-progress-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;width:100%}.custom-progress-steps button{padding:10px 7px;border:1px solid #dfe6ef;border-radius:8px;background:#fff;color:#667085;cursor:pointer}.custom-progress-steps button.active{border-color:#3f8cff;background:#eaf2ff;color:#2463c7;font-weight:700}@media(max-width:720px){.task-type-tabs{overflow-x:auto}.task-type-tabs button{flex:none}.custom-progress-steps{grid-template-columns:1fr 1fr}}
.task-statistics-scope{display:grid;gap:4px;width:100%;padding:11px 13px;border-radius:9px;background:#f5f8fc}.task-statistics-scope strong{color:#243247}.task-statistics-scope span{color:#52657e}.task-statistics-scope small{color:#7b8797}
.task-dialog-header{display:grid;grid-template-columns:52px 1fr 34px;align-items:start;gap:14px;padding:2px 2px 15px;border-bottom:1px solid #e8edf4}.task-dialog-header>div{min-width:0}.task-dialog-header small{color:#3977d5;font-size:12px;font-weight:700}.task-dialog-header h2{overflow:hidden;margin:3px 0 4px;color:#1d2939;font-size:21px;white-space:nowrap;text-overflow:ellipsis}.task-dialog-header p{margin:0;color:#7b8797;font-size:12px}.task-dialog-header>button{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:9px;background:#f2f5f9;color:#667085;font-size:22px;cursor:pointer}.task-dialog-icon{display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:#eaf2ff;color:#2f6ed2}.task-dialog-icon.procurement_daily{background:#fff1df;color:#ea7a13}.task-dialog-icon.shipping_daily{background:#e6f8fb;color:#0891b2}.task-dialog-icon.product_development{background:#f3e8ff;color:#7c3aed}.task-dialog-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}.task-dialog-metrics article{display:grid;gap:4px;min-height:92px;padding:14px;border:1px solid #e2e8f0;border-radius:12px;background:#fafcff}.task-dialog-metrics span,.task-dialog-metrics small{color:#7b8797;font-size:11px}.task-dialog-metrics strong{color:#243247;font-size:20px}.task-dialog-metrics i{font-style:normal;font-size:12px}.task-dialog-progress{display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px;margin-bottom:16px;padding:13px 15px;border-radius:11px;background:#f5f8fc}.task-dialog-progress span{color:#52657e;font-size:12px}.task-statistics-scope{grid-template-columns:1fr 1.35fr;gap:12px;margin-bottom:16px;padding:15px}.task-statistics-scope>div{display:grid;gap:4px}.task-statistics-scope>div span{color:#7b8797;font-size:11px}.task-statistics-scope>div strong{font-size:14px}.task-statistics-scope p{grid-column:1/-1;margin:2px 0 0;padding-top:9px;border-top:1px solid #e2e8f0;color:#7b8797;font-size:11px}.task-owner-card{display:grid;grid-template-columns:1fr 220px;align-items:center;gap:20px;padding:15px;border:1px solid #dfe6ef;border-radius:12px}.task-owner-card>div{display:flex;align-items:center;gap:11px}.task-owner-card>div>div{display:grid;gap:3px}.task-owner-card small{color:#7b8797;font-size:11px}.task-dialog-footer{display:flex;justify-content:flex-end;gap:8px}.task-detail-form{padding-top:2px}:global(.task-detail-dialog){overflow:hidden;border-radius:16px;box-shadow:0 24px 60px #17203330}:global(.task-detail-dialog .el-dialog__header){margin:0;padding:20px 22px 0}:global(.task-detail-dialog .el-dialog__body){padding:18px 22px 8px}:global(.task-detail-dialog .el-dialog__footer){padding:14px 22px 20px;border-top:1px solid #edf1f6}@media(max-width:720px){.task-dialog-metrics{grid-template-columns:1fr}.task-owner-card{grid-template-columns:1fr}.task-statistics-scope{grid-template-columns:1fr}}
.operational-detail-section{display:grid;gap:11px;margin:0 0 16px;padding:15px;border:1px solid #dfe6ef;border-radius:13px;background:#fff}.operational-detail-section>header{display:flex;align-items:center;justify-content:space-between}.operational-detail-section>header span{color:#7b8797;font-size:11px}.operational-detail-section>header h3{margin:2px 0 0;color:#243247;font-size:16px}.operational-detail-section>header>b{padding:5px 8px;border-radius:999px;background:#fff0f0;color:#d94040;font-size:11px}.reason-filter-tabs{display:flex;gap:6px;overflow-x:auto}.reason-filter-tabs button{display:flex;align-items:center;gap:5px;flex:none;padding:6px 8px;border:1px solid #dfe6ef;border-radius:8px;background:#f8fafc;color:#52657e;font-size:11px;cursor:pointer}.reason-filter-tabs button.active{border-color:#3f8cff;background:#eaf2ff;color:#2463c7}.reason-filter-tabs b{display:grid;place-items:center;min-width:18px;height:18px;border-radius:999px;background:#e8edf4;font-size:10px}.operational-order-list{display:grid;gap:7px;max-height:300px;overflow:auto}.operational-order-list article{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px 12px;padding:10px 11px;border:1px solid #e8edf4;border-radius:10px;background:#fbfcfe}.order-alert-main{display:grid;gap:2px;min-width:0}.order-alert-main>strong{color:#243247;font-size:13px}.order-alert-main>span{color:#667085;font-size:11px}.order-alert-main>p{overflow:hidden;margin:2px 0 0;color:#52657e;font-size:11px;white-space:nowrap;text-overflow:ellipsis}.reason-badge{align-self:start;padding:4px 7px;border-radius:999px;font-size:10px;font-weight:700}.reason-badge.blocked{background:#fff0f0;color:#d94040}.reason-badge.waiting{background:#fff4dc;color:#ad6800}.reason-badge.warning{background:#ffe8e8;color:#c62828;box-shadow:0 0 0 1px #ffb8b8 inset}.order-alert-meta{grid-column:1/-1;display:flex;align-items:center;gap:10px;padding-top:6px;border-top:1px solid #edf1f6}.order-alert-meta small{overflow:hidden;flex:1;color:#7b8797;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.operational-detail-section>.el-pagination{justify-content:flex-end}:global(.task-detail-dialog .el-dialog__body){max-height:calc(100vh - 210px);overflow:auto}@media(max-width:720px){.operational-order-list article{grid-template-columns:1fr}.reason-badge,.order-alert-meta{grid-column:1}.order-alert-meta{flex-wrap:wrap}}
.operational-order-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;max-height:430px;padding-right:3px}.operational-order-list article{grid-template-columns:64px minmax(0,1fr);gap:11px;min-height:108px;padding:11px}.order-alert-image{width:64px;height:84px;overflow:hidden;border-radius:8px;background:#edf1f6}.order-alert-image-empty{display:grid;place-items:center;width:100%;height:100%;color:#98a2b3;font-size:11px}.order-alert-main{align-content:start;gap:4px}.order-alert-title{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.order-alert-title strong{overflow:hidden;color:#243247;font-size:13px;white-space:nowrap;text-overflow:ellipsis}.order-alert-main>span{color:#667085;font-size:11px}.order-alert-time{display:flex;align-items:center;gap:4px;color:#52657e!important}.order-alert-main>p{display:-webkit-box;overflow:hidden;margin:1px 0;color:#344054;font-size:11px;line-height:1.5;white-space:normal;-webkit-line-clamp:2;-webkit-box-orient:vertical}.order-alert-meta{grid-column:auto;gap:8px;margin-top:2px;padding-top:5px}.order-alert-meta .el-button{flex:none}.task-owner-card{margin-top:2px}:global(.task-detail-dialog){max-width:calc(100vw - 40px)}:global(.task-detail-dialog .el-dialog__body){max-height:calc(100vh - 175px)}@media(max-width:900px){.operational-order-list{grid-template-columns:1fr}}@media(max-width:560px){.operational-order-list article{grid-template-columns:64px minmax(0,1fr)}}
.order-alert-meta .el-button{align-self:center;min-height:22px;height:22px;margin-left:auto;padding:2px 7px!important;border:1px solid #cfe0f7;border-radius:6px;background:#f4f8ff;font-size:11px;line-height:16px}.order-alert-meta .el-button:hover{border-color:#8bb9f4;background:#eaf3ff}
.operational-order-list article{position:relative;min-height:132px;box-sizing:border-box;overflow:visible}.order-alert-main{min-height:108px;padding-bottom:28px;box-sizing:border-box}.order-alert-meta{position:absolute;right:10px;bottom:7px;left:86px;min-height:24px;margin:0;padding-top:3px;box-sizing:border-box;background:#fbfcfe}.order-alert-meta .el-button{position:absolute;right:0;bottom:0}.order-alert-meta small{padding-right:62px}:global(.task-detail-dialog){width:min(1180px,calc(100vw - 32px))!important;max-height:96vh;margin-top:2vh!important}:global(.task-detail-dialog .el-dialog__body){max-height:calc(96vh - 150px);overflow:auto}
.draft-link-header{display:flex;align-items:center;justify-content:space-between;gap:16px}.draft-link-header h2{margin:0;color:#243247;font-size:20px}.draft-link-header p{margin:5px 0 0;color:#7b8797;font-size:12px}.draft-link-summary,.draft-link-toolbar{display:flex;align-items:center;gap:9px}.draft-link-toolbar{margin-bottom:14px}.draft-link-toolbar>.el-input{flex:1}.draft-link-toolbar>.el-date-editor{flex:0 0 310px}.draft-choice-list{display:grid;grid-template-columns:1fr 1fr;gap:10px;height:590px;padding:2px 5px 2px 2px;overflow:auto}.draft-choice-card{position:relative;display:grid;grid-template-columns:78px minmax(0,1fr) 24px;gap:11px;min-height:108px;padding:10px;border:1px solid #dfe6ef;border-radius:11px;background:#fff;color:inherit;cursor:pointer;text-align:left;transition:border-color .15s,box-shadow .15s,background .15s}.draft-choice-card:hover{border-color:#9bc2f5;box-shadow:0 5px 14px #1f3b6414}.draft-choice-card.selected{border-color:#409eff;background:#f2f8ff;box-shadow:0 0 0 2px #409eff20}.draft-choice-card.linked{border-color:#b7e4c7;background:#f3fbf6;cursor:default;opacity:1}.draft-choice-card>.el-image{width:78px;height:104px;overflow:hidden;border-radius:8px;background:#edf1f6}.draft-choice-empty{display:grid;place-items:center;width:100%;height:100%;color:#98a2b3;font-size:12px}.draft-choice-main{display:grid;align-content:start;gap:6px;min-width:0}.draft-choice-main>strong{display:-webkit-box;overflow:hidden;color:#243247;font-size:13px;line-height:1.45;-webkit-line-clamp:2;-webkit-box-orient:vertical}.draft-choice-main>span{overflow:hidden;color:#3977d5;font-size:11px;white-space:nowrap;text-overflow:ellipsis}.draft-choice-main>div{display:flex;align-items:center;gap:7px;min-width:0}.draft-choice-main>div small{overflow:hidden;color:#667085;white-space:nowrap;text-overflow:ellipsis}.draft-choice-main>small{color:#98a2b3;font-size:10px}.draft-choice-check{align-self:center;color:#cbd5e1}.draft-choice-card.selected .draft-choice-check,.draft-choice-card.linked .draft-choice-check{color:#409eff}.draft-choice-card.linked .draft-choice-check{color:#22a861}.draft-choice-list>.el-empty{grid-column:1/-1;padding:40px 0}.draft-link-dialog .attach-tip{margin:13px 0 0;padding:9px 11px;border-radius:8px;background:#f5f8fc;color:#667085;font-size:12px}:global(.draft-link-dialog){max-width:calc(100vw - 32px)}:global(.draft-link-dialog .el-dialog__body){padding-top:12px}@media(max-width:720px){.draft-choice-list{grid-template-columns:1fr;height:62vh}.draft-link-header,.draft-link-toolbar{align-items:stretch;flex-direction:column}.draft-link-toolbar>.el-date-editor{flex:auto;width:100%}.draft-choice-card{grid-template-columns:68px minmax(0,1fr) 22px}.draft-choice-card>.el-image{width:68px;height:92px}}
.draft-link-pagination{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:12px}.draft-link-pagination>span{color:#7b8797;font-size:12px}.draft-link-dialog .attach-tip{margin-top:10px}@media(max-width:720px){.draft-link-pagination{align-items:flex-start;flex-direction:column}}
</style>
