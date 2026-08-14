<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock3,
  ExternalLink,
  FileText,
  Layers3,
  Link2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Target,
  Trash2,
  Truck,
  Users
} from "lucide-vue-next";
import { apiClient } from "../../utils/api";
import { uploadListingMedia, uploadTeamAttachment } from "../../api/tools/imageCropper";
import { shanghaiDateKey, shanghaiDateText } from "../../utils/shanghai-date";
import {
  developmentTypeLabel,
  normalizeDevelopmentType
} from "../../utils/product-development-meta";

const router = useRouter();

const periodOptions = [
  { label: "本周", value: "week" },
  { label: "本月", value: "month" },
  { label: "本季度", value: "quarter" },
  { label: "年度", value: "year" }
];

const workTypes = [
  { label: "采集验证", value: "collection", icon: Search, tone: "blue" },
  { label: "选品定版", value: "selection", icon: Target, tone: "green" },
  { label: "裂变型号", value: "fission", icon: RefreshCw, tone: "orange" },
  { label: "草稿上架", value: "draft", icon: FileText, tone: "violet" },
  { label: "采购验证", value: "procurement", icon: ShoppingCart, tone: "amber" },
  { label: "车型销量复盘", value: "vehicle_sales", icon: BarChart3, tone: "cyan" },
  { label: "产品优化", value: "optimization", icon: Layers3, tone: "slate" }
];

const statusColumns = [
  { label: "未开始", value: "todo" },
  { label: "进行中", value: "doing" },
  { label: "待复核", value: "review" },
  { label: "已完成", value: "done" },
  { label: "已延期", value: "delayed" }
];

const priorityMap = {
  high: { label: "高", type: "danger" },
  medium: { label: "中", type: "warning" },
  low: { label: "低", type: "info" }
};

const sourceLabels = {
  collector: "采集箱",
  selection: "选品池",
  draft: "草稿箱",
  dev_candidate: "待开发",
  heatmap: "车型销量",
  note: "手动关联"
};

const loading = ref(false);
const heatmapLoading = ref(false);
const saving = ref(false);
const activePeriod = ref("month");
const activeTypeFilter = ref("all");
const keyword = ref("");
const selectedProductKey = ref("");
const selectedTypeValue = ref("selection");
const taskDialogVisible = ref(false);
const typeDialogVisible = ref(false);
const productDialogVisible = ref(false);
const candidateAttachmentUploading = ref(false);
const people = ref([]);
const tasks = ref([]);
const collectorRows = ref([]);
const selectionRows = ref([]);
const draftRows = ref([]);
const heatmapModels = ref([]);

function addDays(value, days) {
  const date = new Date(`${value || shanghaiDateKey()}T00:00:00+08:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return shanghaiDateKey(date);
}

function derivePeriodFromDue(value) {
  const today = new Date(`${shanghaiDateKey()}T00:00:00+08:00`).getTime();
  const target = new Date(`${value || shanghaiDateKey()}T00:00:00+08:00`).getTime();
  const days = Math.ceil((target - today) / 86400000);
  if (days <= 14) return "week";
  if (days <= 62) return "month";
  if (days <= 124) return "quarter";
  return "year";
}

function vehicleModelKey(row = {}) {
  const explicit = String(row.vehicle_model_key || row.vehicleModelKey || "").trim().toLowerCase();
  if (explicit) return explicit;
  return [row.vehicle_brand, row.vehicle_model]
    .map((item) => String(item || "").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ""))
    .filter(Boolean)
    .join("-");
}

function productDevelopmentType(product = {}) {
  return normalizeDevelopmentType(
    product.development_type
      || product.selection?.development_type
      || product.collectors?.find((item) => item.development_type)?.development_type
      || product.drafts?.find((item) => item.development_type)?.development_type
  );
}

const emptyTaskForm = () => {
  const dueAt = addDays(shanghaiDateKey(), 7);
  return {
    id: null,
    title: "",
    type: "selection",
    owner_person_id: null,
    collaborator_person_ids: [],
    target: 1,
    done: 0,
    unit: "项",
    status: "todo",
    priority: "medium",
    start_at: shanghaiDateKey(),
    due_at: dueAt,
    period: derivePeriodFromDue(dueAt),
    related_kind: "selection",
    related_id: "",
    related: "",
    source_url: "",
    image_url: "",
    attachments: [],
    candidate_note: "",
    result: ""
  };
};

const taskForm = reactive(emptyTaskForm());

const typeByValue = computed(() => new Map(workTypes.map((item) => [item.value, item])));
const personById = computed(() => new Map(people.value.map((item) => [Number(item.id), item])));
const activePeople = computed(() => people.value.filter((item) => Number(item.active ?? 1) !== 0));

const periodTasks = computed(() => tasks.value.filter((task) => task.period === activePeriod.value));

const filteredTasks = computed(() => periodTasks.value.filter((task) => {
  if (activeTypeFilter.value !== "all" && task.type !== activeTypeFilter.value) return false;
  return true;
}));

const selectedType = computed(() => typeByValue.value.get(selectedTypeValue.value) || workTypes[0]);
const selectedTypeTasks = computed(() => periodTasks.value.filter((task) => task.type === selectedTypeValue.value));
const selectedProduct = computed(() => boardProducts.value.find((item) => item.key === selectedProductKey.value) || null);

const boardProducts = computed(() => {
  const rows = [];
  const usedCollectorKeys = new Set();
  const usedDraftKeys = new Set();
  const baseSelections = selectionRows.value.filter((item) => !Number(item.source_selection_id || 0));
  const seedSelections = baseSelections.length ? baseSelections : selectionRows.value;

  for (const selection of seedSelections.slice(0, 120)) {
    const product = productFromSelection(selection);
    const selectionId = Number(selection.id || 0);
    const variants = selectionRows.value.filter((item) => {
      if (Number(item.id || 0) === selectionId) return true;
      return Number(item.source_selection_id || 0) === selectionId;
    });
    const collectors = collectorRows.value.filter((row) => collectorMatchesSelection(row, selection));
    const drafts = draftRows.value.filter((row) => draftMatchesSelection(row, selection, variants));
    collectors.forEach((row) => usedCollectorKeys.add(String(row.sku || row.id || "")));
    drafts.forEach((row) => usedDraftKeys.add(String(row.id || "")));
    rows.push(enrichProduct({
      ...product,
      variants,
      collectors,
      drafts
    }));
  }

  for (const collector of collectorRows.value.slice(0, 80)) {
    const key = String(collector.sku || collector.id || "");
    if (!key || usedCollectorKeys.has(key)) continue;
    rows.push(enrichProduct(productFromCollector(collector)));
  }

  for (const draft of draftRows.value.slice(0, 80)) {
    const key = String(draft.id || "");
    if (!key || usedDraftKeys.has(key)) continue;
    rows.push(enrichProduct(productFromDraft(draft)));
  }

  for (const task of periodTasks.value.slice(0, 160)) {
    const relation = parseRelation(task.related);
    if (relation.kind !== "dev_candidate") continue;
    rows.push(enrichProduct(productFromCandidateTask(task, relation)));
  }

  return rows
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 160);
});

const filteredBoardProducts = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  return boardProducts.value.filter((product) => {
    if (activeTypeFilter.value !== "all" && !product.tasks.some((task) => task.type === activeTypeFilter.value)) return false;
    if (!text) return true;
    return [
      product.title,
      product.code,
      product.vehicle,
      product.selection_id,
      product.source_id,
      product.owner_name,
      ...(product.attachments || []).map((item) => item.name)
    ].some((value) => String(value || "").toLowerCase().includes(text));
  });
});

const relationOptions = computed(() => {
  const products = boardProducts.value.slice(0, 80).map((item) => ({
    kind: item.source_type,
    id: item.source_id,
    productKey: item.key,
    label: `${item.title} - ${item.vehicle || item.code || sourceLabels[item.source_type] || ""}`.trim()
  }));
  return [
    { label: "产品开发卡", options: products },
    {
      label: "采集箱",
      options: collectorRows.value.slice(0, 40).map((item) => ({
        kind: "collector",
        id: item.sku || item.id,
        productKey: `collector:${item.sku || item.id}`,
        label: `${item.title || item.product_id || item.sku} - ${item.sku || ""}`
      }))
    },
    {
      label: "选品池",
      options: selectionRows.value.slice(0, 40).map((item) => ({
        kind: "selection",
        id: item.id,
        productKey: `selection:${item.id}`,
        label: `${item.name || item.selection_id || item.code} - ${item.vehicle_model || item.code || ""}`
      }))
    },
    {
      label: "草稿箱",
      options: draftRows.value.slice(0, 40).map((item) => ({
        kind: "draft",
        id: item.id,
        productKey: `draft:${item.id}`,
        label: `${item.product_name || item.internal_code || `草稿 ${item.id}`} - ${item.internal_code || ""}`
      }))
    }
  ];
});

const summaryCards = computed(() => {
  const products = filteredBoardProducts.value;
  const running = products.filter((item) => item.progress > 0 && item.progress < 100).length;
  const newCount = products.filter((item) => productDevelopmentType(item) === "new").length;
  const copyCount = products.filter((item) => productDevelopmentType(item) === "copy").length;
  const fissionCount = products.filter((item) => productDevelopmentType(item) === "fission").length;
  const linkedOrders = products.reduce((sum, item) => sum + Number(item.order_count || 0), 0);
  return [
    { label: "开发产品", value: products.length, suffix: "个", icon: ClipboardList, tone: "blue" },
    { label: "新品", value: newCount, suffix: "个", icon: Target, tone: "green" },
    { label: "复制", value: copyCount, suffix: "个", icon: Layers3, tone: "violet" },
    { label: "裂变", value: fissionCount, suffix: "个", icon: RefreshCw, tone: "orange" },
    { label: linkedOrders ? "关联订单" : "进行中", value: linkedOrders || running, suffix: linkedOrders ? "单" : "个", icon: CheckCircle2, tone: "cyan" }
  ];
});

const typeProgress = computed(() => workTypes.map((type) => {
  const typeTasks = periodTasks.value.filter((task) => task.type === type.value);
  const productRows = boardProducts.value.filter((product) => product.stageTypes.includes(type.value));
  const target = typeTasks.reduce((sum, task) => sum + Number(task.target || 0), 0) || productRows.length;
  const done = typeTasks.reduce((sum, task) => sum + Number(task.done || 0), 0) || productRows.filter((item) => stageDone(item, type.value)).length;
  const ownerIds = [...new Set([
    ...typeTasks.map((task) => Number(task.owner_person_id || 0)),
    ...productRows.map((product) => Number(product.owner_person_id || 0))
  ].filter(Boolean))];
  return {
    ...type,
    taskCount: typeTasks.length,
    productCount: productRows.length,
    target,
    done,
    ownerIds,
    rate: target ? Math.min(100, Math.round((done / target) * 100)) : 0
  };
}));

const peopleWorkloads = computed(() => activePeople.value.map((person) => {
  const personId = Number(person.id);
  const ownedProducts = boardProducts.value.filter((product) => Number(product.owner_person_id || 0) === personId);
  const assignedTasks = periodTasks.value.filter((task) => {
    if (Number(task.owner_person_id || 0) === personId) return true;
    return (task.collaborator_person_ids || []).map(Number).includes(personId);
  });
  const typeRows = workTypes
    .map((type) => ({
      ...type,
      count: assignedTasks.filter((task) => task.type === type.value).length
        + ownedProducts.filter((product) => product.stageTypes.includes(type.value)).length
    }))
    .filter((item) => item.count > 0);
  const taskTarget = assignedTasks.reduce((sum, task) => sum + Number(task.target || 0), 0);
  const taskDone = assignedTasks.reduce((sum, task) => sum + Number(task.done || 0), 0);
  const productProgress = ownedProducts.length
    ? Math.round(ownedProducts.reduce((sum, product) => sum + product.progress, 0) / ownedProducts.length)
    : 0;
  const taskProgressValue = taskTarget ? Math.round((taskDone / taskTarget) * 100) : 0;
  const rate = ownedProducts.length && assignedTasks.length
    ? Math.round((productProgress + taskProgressValue) / 2)
    : (ownedProducts.length ? productProgress : taskProgressValue);
  return {
    person,
    products: ownedProducts,
    tasks: assignedTasks,
    typeRows,
    total: ownedProducts.length + assignedTasks.length,
    rate: Math.min(100, rate)
  };
}).sort((a, b) => b.total - a.total || b.rate - a.rate));

watch(() => taskForm.due_at, (value) => {
  taskForm.period = derivePeriodFromDue(value);
});

function safeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

async function safeGet(url, fallback, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiClient.get(url, {
      noCache: true,
      routeScoped: false,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("[product-development-board] optional source timeout:", url);
      return fallback;
    }
    console.warn("[product-development-board] optional source failed:", url, error?.message || error);
    return fallback;
  } finally {
    window.clearTimeout(timer);
  }
}

async function loadData() {
  loading.value = true;
  try {
    const [
      peoplePayload,
      taskPayloadRows,
      selectionPayload,
      collectorPayload,
      draftPayload
    ] = await Promise.all([
      safeGet("/api/people", [], { timeoutMs: 5000 }),
      safeGet("/api/team/tasks", [], { timeoutMs: 5000 }),
      safeGet("/api/products/selection?paged=1&page=1&pageSize=100&summaryMode=skip", { rows: [] }, { timeoutMs: 8000 }),
      safeGet("/api/listing/collector-box?page=1&pageSize=100&summaryMode=skip", { rows: [] }, { timeoutMs: 8000 }),
      safeGet("/api/listing/drafts?paged=1&lightweight=1&projectOnly=1&page=1&pageSize=100", { rows: [] }, { timeoutMs: 8000 })
    ]);
    people.value = safeRows(peoplePayload);
    tasks.value = safeRows(taskPayloadRows).filter((task) => typeByValue.value.has(task.type));
    selectionRows.value = safeRows(selectionPayload);
    collectorRows.value = safeRows(collectorPayload);
    draftRows.value = safeRows(draftPayload);
    if (!taskForm.owner_person_id) taskForm.owner_person_id = activePeople.value[0]?.id || null;
    loadHeatmapData();
  } catch (error) {
    ElMessage.error(error.message || "产品开发看板数据加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadHeatmapData() {
  heatmapLoading.value = true;
  try {
    const heatmapPayload = await safeGet("/api/order-car-heatmap/models?sourceLimit=8000", { rows: [] }, { timeoutMs: 6000 });
    heatmapModels.value = safeRows(heatmapPayload);
  } finally {
    heatmapLoading.value = false;
  }
}

function productFromSelection(row) {
  return {
    key: `selection:${row.id}`,
    source_type: "selection",
    source_id: String(row.id || ""),
    title: row.name || row.selection_id || row.code || `选品 ${row.id}`,
    code: row.selection_id || row.code || "",
    image_url: row.image_url || "",
    vehicle: [row.vehicle_brand, row.vehicle_model].filter(Boolean).join(" ") || row.vehicle_model || "",
    vehicle_model_key: vehicleModelKey(row),
    development_type: normalizeDevelopmentType(row.development_type),
    selection_id: row.selection_id || "",
    owner_person_id: row.owner_person_id || null,
    owner_name: row.owner_name || "",
    status: row.business_status || row.selection_status || "",
    updated_at: row.updated_at || row.created_at || "",
    selection: row,
    collectors: [],
    variants: [row],
    drafts: []
  };
}

function productFromCollector(row) {
  return {
    key: `collector:${row.sku || row.id}`,
    source_type: "collector",
    source_id: String(row.sku || row.id || ""),
    title: row.title || row.product_id || row.sku || "采集商品",
    code: row.sku || row.product_id || "",
    image_url: row.image_url || "",
    vehicle: [row.vehicle_brand, row.vehicle_model].filter(Boolean).join(" ") || row.vehicle_model || "",
    vehicle_model_key: vehicleModelKey(row),
    development_type: normalizeDevelopmentType(row.development_type),
    selection_id: "",
    owner_person_id: null,
    owner_name: "",
    status: row.status || "",
    updated_at: row.updated_at || row.created_at || row.collected_at || "",
    selection: null,
    collectors: [row],
    variants: [],
    drafts: []
  };
}

function productFromDraft(row) {
  return {
    key: `draft:${row.id}`,
    source_type: "draft",
    source_id: String(row.id || ""),
    title: row.product_name || row.internal_code || `草稿 ${row.id}`,
    code: row.internal_code || "",
    image_url: firstImage(row.source_images || row.images || row.source_images_json),
    vehicle: [row.vehicle_brand, row.vehicle_model].filter(Boolean).join(" ") || row.vehicle_model || "",
    vehicle_model_key: vehicleModelKey(row),
    development_type: normalizeDevelopmentType(row.development_type),
    selection_id: "",
    owner_person_id: row.created_by_person_id || null,
    owner_name: "",
    status: row.status || "",
    updated_at: row.updated_at || row.created_at || "",
    selection: null,
    collectors: [],
    variants: [],
    drafts: [row]
  };
}

function productFromCandidateTask(task, relation = {}) {
  return {
    key: `dev_candidate:${task.id}`,
    source_type: "dev_candidate",
    source_id: String(task.id || ""),
    title: task.title || relation.label || relation.note || relation.source_url || "待开发选品",
    code: relation.source_url || "",
    image_url: relation.image_url || "",
    vehicle: "",
    vehicle_model_key: "",
    development_type: normalizeDevelopmentType(relation.development_type || "new"),
    selection_id: "",
    owner_person_id: task.owner_person_id || null,
    owner_name: task.owner_name || "",
    status: "待开发",
    updated_at: task.updated_at || task.created_at || "",
    selection: null,
    collectors: [],
    variants: [],
    drafts: [],
    candidate_task: task,
    candidate_note: relation.note || task.result || "",
    attachments: normalizeAttachments(relation.attachments)
  };
}

function productVehicleModels(product = {}) {
  const values = [
    product.vehicle,
    product.selection?.vehicle_model,
    ...((product.variants || []).flatMap((item) => [
      [item.vehicle_brand, item.vehicle_model].filter(Boolean).join(" "),
      item.vehicle_model
    ])),
    ...((product.drafts || []).flatMap((item) => [
      [item.vehicle_brand, item.vehicle_model].filter(Boolean).join(" "),
      item.vehicle_model
    ]))
  ];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function productLifecycleStatus(product = {}) {
  const isFission = productDevelopmentType(product) === "fission"
    || (product.variants || []).some((item) => normalizeDevelopmentType(item.development_type) === "fission")
    || (product.drafts || []).some((item) => normalizeDevelopmentType(item.development_type) === "fission");
  if (isFission) return { label: "裂变", type: "warning" };
  if (product.selection || product.draft_count > 0) return { label: "已上架", type: "success" };
  return { label: "待开发", type: "info" };
}

function enrichProduct(product) {
  const tasksForProduct = relatedTasks(product);
  const orderMetric = matchingHeatmapMetric(product);
  const ownerId = product.owner_person_id || tasksForProduct[0]?.owner_person_id || null;
  const stages = productStages(product, tasksForProduct, orderMetric);
  const progress = Math.round(stages.reduce((sum, item) => sum + item.rate, 0) / Math.max(stages.length, 1));
  const lifecycle = productLifecycleStatus(product);
  const vehicleModels = productVehicleModels(product);
  const attachments = normalizeAttachments(product.attachments);
  return {
    ...product,
    attachments,
    attachment_count: attachments.length,
    owner_person_id: ownerId,
    owner_name: product.owner_name || personName(ownerId),
    tasks: tasksForProduct,
    order_count: orderMetric?.order_count || 0,
    sku_count: orderMetric?.sku_count || 0,
    revenue: orderMetric?.revenue || 0,
    development_type: productDevelopmentType(product),
    development_type_label: developmentTypeLabel(productDevelopmentType(product)),
    lifecycle_status: lifecycle.label,
    lifecycle_status_type: lifecycle.type,
    vehicle_models: vehicleModels,
    vehicle_models_text: vehicleModels.length ? vehicleModels.join("、") : "还没有车型记录",
    stages,
    stageTypes: stages.filter((item) => item.rate > 0).map((item) => item.type),
    progress,
    variant_count: Math.max(product.variants?.length || 0, 0),
    draft_count: product.drafts?.length || 0,
    collector_count: product.collectors?.length || 0
  };
}

function productStages(product, productTasks, orderMetric) {
  const taskRate = (type) => {
    const rows = productTasks.filter((task) => task.type === type);
    const target = rows.reduce((sum, task) => sum + Number(task.target || 0), 0);
    const done = rows.reduce((sum, task) => sum + Number(task.done || 0), 0);
    return target ? Math.min(100, Math.round((done / target) * 100)) : null;
  };
  const collectionRate = product.collector_count ? 100 : (taskRate("collection") ?? 0);
  const selectionRate = product.selection ? 100 : (taskRate("selection") ?? 0);
  const fissionRate = productDevelopmentType(product) === "fission" || product.variant_count > 1 ? 100 : (taskRate("fission") ?? (product.variant_count ? 45 : 0));
  const draftRate = product.draft_count ? 100 : (taskRate("draft") ?? 0);
  const procurementRate = taskRate("procurement") ?? 0;
  const salesRate = orderMetric?.order_count ? 100 : (taskRate("vehicle_sales") ?? 0);
  return [
    { label: "采集", type: "collection", rate: collectionRate, count: product.collector_count },
    { label: "选品", type: "selection", rate: selectionRate, count: product.selection ? 1 : 0 },
    { label: "裂变", type: "fission", rate: fissionRate, count: product.variant_count },
    { label: "草稿", type: "draft", rate: draftRate, count: product.draft_count },
    { label: "采购", type: "procurement", rate: procurementRate, count: productTasks.filter((task) => task.type === "procurement").length },
    { label: "销量", type: "vehicle_sales", rate: salesRate, count: orderMetric?.order_count || 0 }
  ];
}

function stageDone(product, type) {
  return product.stages.find((item) => item.type === type)?.rate >= 100;
}

function relatedTasks(product) {
  return periodTasks.value.filter((task) => {
    const relation = parseRelation(task.related);
    if (relation.productKey && relation.productKey === product.key) return true;
    if (relation.kind === product.source_type && String(relation.id || "") === String(product.source_id || "")) return true;
    const haystack = `${task.related || ""} ${task.title || ""}`.toLowerCase();
    return [
      product.source_id,
      product.selection_id,
      product.code,
      product.title
    ].filter(Boolean).some((value) => haystack.includes(String(value).toLowerCase()));
  });
}

function collectorMatchesSelection(collector, selection) {
  if (Number(collector.selection_product_id || 0) && Number(collector.selection_product_id || 0) === Number(selection.id || 0)) return true;
  const fields = [collector.sku, collector.product_id, collector.title].join(" ").toLowerCase();
  return [selection.selection_id, selection.code, selection.name].filter(Boolean).some((value) => fields.includes(String(value).toLowerCase()));
}

function draftMatchesSelection(draft, selection, variants = []) {
  const fields = [draft.internal_code, draft.product_name].join(" ").toLowerCase();
  const candidates = [
    selection.id,
    selection.selection_id,
    selection.code,
    selection.name,
    ...variants.flatMap((item) => [item.id, item.selection_id, item.code, item.name])
  ].filter(Boolean);
  return candidates.some((value) => fields.includes(String(value).toLowerCase()));
}

function matchingHeatmapMetric(product) {
  const vehicle = normalizeText(product.vehicle);
  const key = String(product.vehicle_model_key || "").trim().toLowerCase();
  if (!vehicle && !key) return null;
  return heatmapModels.value.find((row) => {
    const metricKey = vehicleModelKey({ vehicle_brand: row.brand, vehicle_model: row.model });
    if (key && metricKey && (key.includes(metricKey) || metricKey.includes(key))) return true;
    const metricVehicle = normalizeText([row.brand, row.model].filter(Boolean).join(" "));
    return metricVehicle && (vehicle.includes(metricVehicle) || metricVehicle.includes(vehicle));
  }) || null;
}

function parseRelation(value) {
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { kind: "note", label: text };
  } catch {
    return { kind: "note", label: text };
  }
}

function relationText(value) {
  const relation = parseRelation(value);
  if (relation.kind === "dev_candidate") return relation.label || relation.note || relation.source_url || "待开发选品";
  if (relation.label) return relation.label;
  return value || "未关联";
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function firstImage(value) {
  const list = Array.isArray(value) ? value : parseJson(value, []);
  const first = list.find(Boolean);
  if (typeof first === "string") return first;
  return first?.url || first?.image_url || first?.imageUrl || first?.src || "";
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function personName(id) {
  return personById.value.get(Number(id))?.name || "未分配";
}

function personAvatar(id) {
  return personById.value.get(Number(id))?.avatar_url || "";
}

function initials(name) {
  const text = String(name || "").trim();
  return text ? text.slice(0, 1).toUpperCase() : "?";
}

function taskType(task) {
  return typeByValue.value.get(task.type) || workTypes[0];
}

function taskProgress(task) {
  if (!Number(task.target || 0)) return 0;
  return Math.min(100, Math.round((Number(task.done || 0) / Number(task.target || 0)) * 100));
}

function normalizeAttachments(value) {
  const list = Array.isArray(value) ? value : parseJson(value, []);
  return list
    .map((item) => {
      if (typeof item === "string") return { name: item.split("/").pop() || "附件", url: item, size: 0, contentType: "" };
      return {
        name: String(item?.name || item?.fileName || item?.storageName || "附件").trim(),
        url: String(item?.url || item?.href || "").trim(),
        size: Number(item?.size || 0),
        contentType: String(item?.contentType || item?.mime_type || "").trim(),
        extension: String(item?.extension || "").trim()
      };
    })
    .filter((item) => item.url);
}

function formatFileSize(value) {
  const size = Number(value || 0);
  if (!size) return "";
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  if (size >= 1024) return `${Math.round(size / 1024)}KB`;
  return `${size}B`;
}

function resetTaskForm(values = {}) {
  Object.assign(taskForm, emptyTaskForm(), values);
}

function selectedRelationOption() {
  return relationOptions.value
    .flatMap((group) => group.options)
    .find((item) => `${item.kind}:${item.id}:${item.productKey || ""}` === taskForm.related_id);
}

function relationSelectValue(option) {
  return `${option.kind}:${option.id}:${option.productKey || ""}`;
}

function applyRelationSelect(value) {
  const option = relationOptions.value.flatMap((group) => group.options).find((item) => relationSelectValue(item) === value);
  if (!option) return;
  taskForm.related_kind = option.kind;
  taskForm.related_id = relationSelectValue(option);
}

function taskPayload(source, options = {}) {
  const option = options.useSelectedRelation ? selectedRelationOption() : null;
  const candidateRelated = JSON.stringify({
    kind: "dev_candidate",
    label: source.title,
    image_url: String(source.image_url || "").trim(),
    source_url: String(source.source_url || "").trim(),
    attachments: normalizeAttachments(source.attachments),
    note: String(source.candidate_note || source.result || "").trim(),
    development_type: "new"
  });
  const related = option
    ? JSON.stringify({
      kind: option.kind,
      id: option.id,
      productKey: option.productKey,
      label: option.label
    })
    : (source.related_kind === "dev_candidate" ? candidateRelated : source.related);
  return {
    title: source.title,
    type: source.type || "selection",
    owner_person_id: source.owner_person_id,
    collaborator_person_ids: source.collaborator_person_ids || [],
    period: source.period,
    status: source.status,
    priority: source.priority,
    target: Number(source.target || 1),
    done: Math.min(Number(source.done || 0), Number(source.target || 1)),
    unit: source.unit || "项",
    start_at: source.start_at,
    due_at: source.due_at,
    related,
    result: source.result || source.candidate_note || "待开发"
  };
}

function openCreateDialog(product = null, type = "selection") {
  const relation = product
    ? {
      kind: product.source_type,
      id: product.source_id,
      productKey: product.key,
      label: product.title
    }
    : null;
  resetTaskForm({
    title: product ? `${product.title} - ${typeByValue.value.get(type)?.label || "开发记录"}` : "",
    type: type || "selection",
    owner_person_id: product?.owner_person_id || activePeople.value[0]?.id || null,
    related_kind: relation?.kind || "dev_candidate",
    related_id: relation ? relationSelectValue(relation) : "",
    related: relation ? JSON.stringify(relation) : "",
    image_url: product?.image_url || "",
    source_url: product?.code && /^https?:\/\//i.test(product.code) ? product.code : "",
    attachments: normalizeAttachments(product?.attachments),
    candidate_note: "",
    status: "todo",
    result: product ? "" : "待开发",
    period: activePeriod.value
  });
  taskDialogVisible.value = true;
}

function openEditDialog(task) {
  const relation = parseRelation(task.related);
  const relatedId = relation.kind && relation.id
    ? relationSelectValue({ kind: relation.kind, id: relation.id, productKey: relation.productKey || "" })
    : "";
  resetTaskForm({
    id: task.id,
    title: task.title || "",
    type: task.type || "selection",
    owner_person_id: task.owner_person_id || activePeople.value[0]?.id || null,
    collaborator_person_ids: [...(task.collaborator_person_ids || [])],
    target: Number(task.target || 1),
    done: Number(task.done || 0),
    unit: task.unit || "项",
    status: task.status || "todo",
    priority: task.priority || "medium",
    start_at: task.start_at || shanghaiDateKey(),
    due_at: task.due_at || addDays(shanghaiDateKey(), 7),
    period: task.period || activePeriod.value,
    related_kind: relation.kind || "note",
    related_id: relatedId,
    related: task.related || "",
    source_url: relation.source_url || "",
    image_url: relation.image_url || "",
    attachments: normalizeAttachments(relation.attachments),
    candidate_note: relation.note || "",
    result: task.result || ""
  });
  taskDialogVisible.value = true;
}

function openProductDetail(product) {
  selectedProductKey.value = product.key;
  productDialogVisible.value = true;
}

function openTypeDialog(type) {
  selectedTypeValue.value = type.value;
  typeDialogVisible.value = true;
}

async function handleCandidateImageFile(file) {
  const raw = file?.raw || file;
  if (!raw) return;
  if (Number(raw.size || 0) > 2 * 1024 * 1024) {
    ElMessage.warning("图片请控制在 2MB 以内，方便快速保存和打开");
    return;
  }
  try {
    const uploaded = await uploadListingMedia(raw, {
      source_module: "team_candidate",
      role: "team_candidate_image"
    });
    taskForm.image_url = uploaded.publishUrl || uploaded.url || uploaded.previewUrl || "";
    if (!taskForm.image_url) throw new Error("图片上传成功，但未返回可保存的 OSS 地址");
  } catch (error) {
    ElMessage.error(error.message || "图片上传失败");
  }
}

async function handleCandidateAttachmentFile(file) {
  const raw = file?.raw || file;
  if (!raw) return;
  if (Number(raw.size || 0) > 20 * 1024 * 1024) {
    ElMessage.warning("附件不能超过 20MB");
    return;
  }
  candidateAttachmentUploading.value = true;
  try {
    const uploaded = await uploadTeamAttachment(raw);
    taskForm.attachments = [
      ...normalizeAttachments(taskForm.attachments),
      {
        name: uploaded.name || raw.name || "附件",
        url: uploaded.url,
        size: uploaded.size || raw.size || 0,
        contentType: uploaded.contentType || raw.type || "",
        extension: uploaded.extension || ""
      }
    ];
    ElMessage.success("附件已上传");
  } catch (error) {
    ElMessage.error(error.message || "附件上传失败");
  } finally {
    candidateAttachmentUploading.value = false;
  }
}

function removeCandidateAttachment(index) {
  taskForm.attachments = normalizeAttachments(taskForm.attachments).filter((_, itemIndex) => itemIndex !== index);
}

function openAttachment(attachment) {
  const url = String(attachment?.url || "").trim();
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

async function saveTask() {
  if (!String(taskForm.title || taskForm.source_url || taskForm.image_url || taskForm.candidate_note || "").trim() && !normalizeAttachments(taskForm.attachments).length) {
    ElMessage.warning("写几个字、放一张图、贴一个链接或上传附件都可以");
    return;
  }
  if (!String(taskForm.title || "").trim()) {
    taskForm.title = String(taskForm.candidate_note || taskForm.source_url || "待开发选品").trim().slice(0, 80);
  }
  if (!taskForm.owner_person_id) {
    ElMessage.warning("请选择负责人");
    return;
  }
  saving.value = true;
  try {
    const payload = taskPayload(taskForm, { useSelectedRelation: true });
    if (taskForm.id) {
      await apiClient.put(`/api/team/tasks/${taskForm.id}`, payload);
      ElMessage.success("选品已更新");
    } else {
      await apiClient.post("/api/team/tasks", payload);
      ElMessage.success("选品已创建");
    }
    taskDialogVisible.value = false;
    await loadData();
  } catch (error) {
    ElMessage.error(error.message || "选品保存失败");
  } finally {
    saving.value = false;
  }
}

async function quickSaveTask(task) {
  try {
    await apiClient.put(`/api/team/tasks/${task.id}`, taskPayload(task));
    ElMessage.success("进度已更新");
    await loadData();
  } catch (error) {
    ElMessage.error(error.message || "进度更新失败");
  }
}

async function deleteTask(task) {
  try {
    await ElMessageBox.confirm(`确定删除任务「${task.title}」吗？`, "删除开发任务", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/team/tasks/${task.id}`);
    ElMessage.success("任务已删除");
    await loadData();
  } catch (error) {
    if (error === "cancel") return;
    ElMessage.error(error.message || "任务删除失败");
  }
}

function navigateSource(kind, payload = {}) {
  if (kind === "collector") {
    router.push({ path: "/collector-box", query: { query: payload.sku || payload.id || payload.source_id || "" } });
  } else if (kind === "selection") {
    router.push({ path: "/selection", query: { query: payload.selection_id || payload.code || payload.id || payload.source_id || "" } });
  } else if (kind === "draft") {
    router.push({ path: "/listing-records", query: { query: payload.internal_code || payload.id || payload.source_id || "" } });
  } else if (kind === "heatmap") {
    router.push({ path: "/order-car-heatmap", query: { keyword: payload.vehicle || "" } });
  } else if (kind === "dev_candidate") {
    if (payload.code && /^https?:\/\//i.test(payload.code)) {
      window.open(payload.code, "_blank", "noopener,noreferrer");
    } else if (payload.candidate_task) {
      openEditDialog(payload.candidate_task);
    }
  }
}

onMounted(loadData);
</script>

<template>
  <div v-loading="loading" class="product-dev-page">
    <header class="dev-header">
      <div>
        <span class="eyebrow">PRODUCT DEVELOPMENT</span>
        <h1>产品开发看板</h1>
        <p>聚焦新产品从采集箱、选品池到草稿箱的开发链路，并把裂变型号、负责人、进度、车型销量和订单反馈放在同一张看板里。</p>
      </div>
      <div class="header-actions">
        <el-radio-group v-model="activePeriod" size="large">
          <el-radio-button v-for="item in periodOptions" :key="item.value" :value="item.value">
            {{ item.label }}
          </el-radio-button>
        </el-radio-group>
        <el-button :icon="RefreshCw" @click="loadData">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreateDialog()">创建选品</el-button>
      </div>
    </header>

    <section class="summary-grid">
      <article v-for="card in summaryCards" :key="card.label" class="summary-card" :class="`is-${card.tone}`">
        <component :is="card.icon" :size="21" />
        <span>{{ card.label }}</span>
        <strong>{{ card.value }}{{ card.suffix }}</strong>
      </article>
    </section>

    <section class="people-panel">
      <div class="panel-heading">
        <div>
          <span>PEOPLE</span>
          <h2>产品开发人员负载</h2>
        </div>
      </div>
      <div class="people-lens">
        <article v-for="row in peopleWorkloads" :key="row.person.id" class="person-pill" :class="{ 'is-empty': !row.total }">
          <el-avatar :src="row.person.avatar_url" :size="48">{{ initials(row.person.name) }}</el-avatar>
          <div class="person-main">
            <div class="person-title">
              <strong>{{ row.person.name }}</strong>
              <span>{{ row.products.length }} 个产品 / {{ row.tasks.length }} 项任务</span>
            </div>
            <div class="person-types">
              <el-tag v-for="type in row.typeRows.slice(0, 4)" :key="type.value" size="small" effect="light">
                {{ type.label }} {{ type.count }}
              </el-tag>
              <span v-if="!row.typeRows.length">暂无当前周期开发事项</span>
            </div>
            <el-progress :percentage="row.rate" :stroke-width="9" :show-text="false" />
          </div>
          <b>{{ row.rate }}%</b>
        </article>
      </div>
    </section>

    <section class="toolbar-panel">
      <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="搜索产品、选品编号、车型或负责人" />
      <el-select v-model="activeTypeFilter" placeholder="开发节点">
        <el-option label="全部节点" value="all" />
        <el-option v-for="item in workTypes" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
    </section>

    <main class="board-layout">
      <section class="product-board">
        <article v-for="product in filteredBoardProducts" :key="product.key" class="product-card" @click="openProductDetail(product)">
          <div class="product-media">
            <el-image v-if="product.image_url" :src="product.image_url" fit="cover" preview-teleported />
            <div v-else class="image-empty">无图</div>
          </div>
          <div class="product-body">
            <div class="product-head">
              <div>
                <h3>{{ product.title }}</h3>
                <span>{{ product.code || sourceLabels[product.source_type] }} <template v-if="product.vehicle">/ {{ product.vehicle }}</template></span>
              </div>
              <div class="product-tags">
                <el-tag effect="light">{{ sourceLabels[product.source_type] }}</el-tag>
                <el-tooltip :content="product.vehicle_models_text" placement="top" :disabled="product.lifecycle_status !== '裂变'">
                  <el-tag :type="product.lifecycle_status_type" effect="plain">{{ product.lifecycle_status }}</el-tag>
                </el-tooltip>
                <el-tag type="warning" effect="plain">{{ product.development_type_label }}</el-tag>
              </div>
            </div>
            <div class="source-chain">
              <button type="button" :class="{ active: product.collector_count }" @click.stop="navigateSource('collector', product.collectors[0] || product)">
                采集箱 {{ product.collector_count }}
              </button>
              <button type="button" :class="{ active: product.selection }" @click.stop="navigateSource('selection', product.selection || product)">
                选品池 {{ product.selection ? 1 : 0 }}
              </button>
              <button type="button" :class="{ active: product.draft_count }" @click.stop="navigateSource('draft', product.drafts[0] || product)">
                草稿箱 {{ product.draft_count }}
              </button>
              <button type="button" :class="{ active: product.order_count }" @click.stop="navigateSource('heatmap', product)">
                订单 {{ product.order_count }}
              </button>
            </div>
            <div class="stage-strip">
              <button
                v-for="stage in product.stages"
                :key="stage.type"
                type="button"
                :class="{ done: stage.rate >= 100, active: stage.rate > 0 && stage.rate < 100 }"
                @click.stop="openCreateDialog(product, stage.type)"
              >
                <span>{{ stage.label }}</span>
                <b>{{ stage.count }}</b>
              </button>
            </div>
            <div class="product-progress">
              <el-progress :percentage="product.progress" :stroke-width="8" />
            </div>
            <footer>
              <div class="owner">
                <el-avatar :src="personAvatar(product.owner_person_id)" :size="28">{{ initials(personName(product.owner_person_id)) }}</el-avatar>
                <span>{{ personName(product.owner_person_id) }}</span>
              </div>
              <div class="metrics">
                <span>{{ product.variant_count }} 型号</span>
                <span>{{ product.sku_count }} SKU</span>
                <span v-if="product.attachment_count">附件 {{ product.attachment_count }}</span>
              </div>
            </footer>
          </div>
        </article>
        <el-empty v-if="!filteredBoardProducts.length" description="暂无可展示的产品开发数据" :image-size="80" />
      </section>

      <aside class="side-panel">
        <div class="panel-heading">
          <div>
            <span>WORK TYPE</span>
            <h2>开发节点进度</h2>
          </div>
        </div>
        <div class="type-list">
          <button
            v-for="item in typeProgress"
            :key="item.value"
            type="button"
            class="type-row"
            :class="`is-${item.tone}`"
            @click="openTypeDialog(item)"
          >
            <div class="type-title">
              <component :is="item.icon" :size="18" />
              <strong>{{ item.label }}</strong>
              <small>{{ item.productCount }} 产品 / {{ item.taskCount }} 任务</small>
            </div>
            <div class="type-owners">
              <el-avatar v-for="ownerId in item.ownerIds.slice(0, 4)" :key="ownerId" :src="personAvatar(ownerId)" :size="24">
                {{ initials(personName(ownerId)) }}
              </el-avatar>
            </div>
            <b>{{ item.rate }}%</b>
            <el-progress :percentage="item.rate" :stroke-width="8" :show-text="false" />
          </button>
        </div>
      </aside>
    </main>

    <el-dialog v-model="taskDialogVisible" :title="taskForm.id ? '编辑选品' : '创建选品'" width="760px" align-center destroy-on-close>
      <el-form label-position="top" class="task-form">
        <el-form-item label="选品描述">
          <el-input v-model="taskForm.title" placeholder="写几个字就行，例如：RAV4 后备箱垫、KIA RIO 车贴、看下这个 1688 款" />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="图片">
            <div class="candidate-image-field">
              <el-image v-if="taskForm.image_url" :src="taskForm.image_url" fit="cover" />
              <el-upload :auto-upload="false" :show-file-list="false" accept="image/*" @change="handleCandidateImageFile">
                <el-button>上传图片</el-button>
              </el-upload>
              <el-input v-model="taskForm.image_url" placeholder="也可以粘贴图片 URL" />
            </div>
          </el-form-item>
          <el-form-item label="1688 / 参考链接">
            <el-input v-model="taskForm.source_url" placeholder="https://detail.1688.com/..." />
          </el-form-item>
        </div>
        <el-form-item label="随手备注">
          <el-input v-model="taskForm.candidate_note" type="textarea" :rows="2" placeholder="可空，记录材质、车型、想法或需要确认的点" />
        </el-form-item>
        <el-form-item label="附件">
          <div class="candidate-attachments">
            <el-upload
              :auto-upload="false"
              :show-file-list="false"
              accept=".xlsx,.xls,.docx,.doc,.pdf,.csv,.txt,.zip,.ppt,.pptx"
              multiple
              :disabled="candidateAttachmentUploading"
              @change="handleCandidateAttachmentFile"
            >
              <el-button :icon="Paperclip" :loading="candidateAttachmentUploading">上传 Excel / Word / PDF</el-button>
            </el-upload>
            <div v-if="taskForm.attachments.length" class="attachment-list">
              <div v-for="(attachment, index) in taskForm.attachments" :key="`${attachment.url}-${index}`" class="attachment-chip">
                <FileText :size="15" />
                <button type="button" class="attachment-main" @click="openAttachment(attachment)">
                  <span>{{ attachment.name }}</span>
                  <small>{{ formatFileSize(attachment.size) }}</small>
                </button>
                <el-button link type="danger" @click="removeCandidateAttachment(index)">移除</el-button>
              </div>
            </div>
          </div>
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="开发节点">
            <el-select v-model="taskForm.type" filterable>
              <el-option v-for="item in workTypes" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="关联来源">
            <el-select v-model="taskForm.related_id" filterable clearable placeholder="选择采集箱 / 选品池 / 草稿箱" @change="applyRelationSelect">
              <el-option-group v-for="group in relationOptions" :key="group.label" :label="group.label">
                <el-option v-for="item in group.options" :key="relationSelectValue(item)" :label="item.label" :value="relationSelectValue(item)" />
              </el-option-group>
            </el-select>
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="负责人">
            <el-select v-model="taskForm.owner_person_id" filterable placeholder="选择内部人员">
              <el-option v-for="person in activePeople" :key="person.id" :label="person.name" :value="person.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="协作人">
            <el-select v-model="taskForm.collaborator_person_ids" multiple filterable collapse-tags collapse-tags-tooltip placeholder="可选">
              <el-option v-for="person in activePeople" :key="person.id" :label="person.name" :value="person.id" />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-grid three">
          <el-form-item label="目标数量">
            <el-input-number v-model="taskForm.target" :min="1" :max="99999" controls-position="right" />
          </el-form-item>
          <el-form-item label="已完成数量">
            <el-input-number v-model="taskForm.done" :min="0" :max="Number(taskForm.target || 1)" controls-position="right" />
          </el-form-item>
          <el-form-item label="单位">
            <el-input v-model="taskForm.unit" placeholder="项 / 型号 / SKU / 张" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="开始时间">
            <el-date-picker v-model="taskForm.start_at" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
          <el-form-item label="结束时间">
            <el-date-picker v-model="taskForm.due_at" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
        </div>
        <div class="form-grid three">
          <el-form-item label="所属周期">
            <el-select v-model="taskForm.period">
              <el-option v-for="item in periodOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="taskForm.status">
              <el-option v-for="item in statusColumns" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="优先级">
            <el-select v-model="taskForm.priority">
              <el-option label="高" value="high" />
              <el-option label="中" value="medium" />
              <el-option label="低" value="low" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="执行记录">
          <el-input v-model="taskForm.result" type="textarea" :rows="3" placeholder="记录当前进展、阻塞点或复核结果" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="taskDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveTask">保存选品</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="typeDialogVisible" :title="`${selectedType.label}明细`" width="920px" align-center>
      <section class="type-detail-summary">
        <strong>{{ selectedTypeTasks.length }} 项任务</strong>
        <span>点击数量、负责人或状态即可更新</span>
      </section>
      <el-table :data="selectedTypeTasks" border>
        <el-table-column prop="title" label="任务" min-width="220" />
        <el-table-column label="关联" min-width="180">
          <template #default="{ row }">{{ relationText(row.related) }}</template>
        </el-table-column>
        <el-table-column label="负责人" width="160">
          <template #default="{ row }">
            <el-select v-model="row.owner_person_id" filterable @change="quickSaveTask(row)">
              <el-option v-for="person in activePeople" :key="person.id" :label="person.name" :value="person.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="190">
          <template #default="{ row }">
            <div class="inline-number">
              <el-input-number v-model="row.done" :min="0" :max="Number(row.target || 1)" size="small" controls-position="right" @change="quickSaveTask(row)" />
              <span>/ {{ row.target }} {{ row.unit }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="进度" width="150">
          <template #default="{ row }">
            <el-progress :percentage="taskProgress(row)" :stroke-width="8" />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-select v-model="row.status" @change="quickSaveTask(row)">
              <el-option v-for="item in statusColumns" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button link type="primary" :icon="Pencil" @click="openEditDialog(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="productDialogVisible" :title="selectedProduct?.title || '产品开发详情'" width="980px" align-center>
      <section v-if="selectedProduct" class="product-detail">
        <div class="detail-hero">
          <el-image v-if="selectedProduct.image_url" :src="selectedProduct.image_url" fit="cover" preview-teleported />
          <div v-else class="image-empty">无图</div>
          <div>
            <span>{{ selectedProduct.code || sourceLabels[selectedProduct.source_type] }}</span>
            <h3>{{ selectedProduct.title }}</h3>
            <p>{{ selectedProduct.vehicle || "未识别车型" }}</p>
            <el-progress :percentage="selectedProduct.progress" :stroke-width="9" />
          </div>
        </div>
        <div class="detail-chain">
          <button v-if="selectedProduct.source_type === 'dev_candidate'" type="button" @click="navigateSource('dev_candidate', selectedProduct)">
            <Link2 :size="16" /> 参考链接 / 编辑
          </button>
          <button type="button" @click="navigateSource('collector', selectedProduct.collectors[0] || selectedProduct)">
            <Link2 :size="16" /> 采集箱 {{ selectedProduct.collector_count }}
          </button>
          <button type="button" @click="navigateSource('selection', selectedProduct.selection || selectedProduct)">
            <Target :size="16" /> 选品池 {{ selectedProduct.selection ? 1 : 0 }}
          </button>
          <button type="button" @click="navigateSource('draft', selectedProduct.drafts[0] || selectedProduct)">
            <FileText :size="16" /> 草稿箱 {{ selectedProduct.draft_count }}
          </button>
          <button type="button" @click="navigateSource('heatmap', selectedProduct)">
            <BarChart3 :size="16" /> 订单 {{ selectedProduct.order_count }}
          </button>
        </div>
        <div v-if="selectedProduct.attachments.length" class="detail-attachments">
          <div class="detail-section-title">
            <Paperclip :size="16" />
            <strong>需求附件</strong>
          </div>
          <button v-for="(attachment, index) in selectedProduct.attachments" :key="`${attachment.url}-${index}`" type="button" class="attachment-row" @click="openAttachment(attachment)">
            <FileText :size="16" />
            <span>{{ attachment.name }}</span>
            <small>{{ formatFileSize(attachment.size) }}</small>
          </button>
        </div>
        <el-table :data="selectedProduct.tasks" border>
          <el-table-column label="任务" min-width="220">
            <template #default="{ row }">
              <strong>{{ row.title }}</strong>
              <div class="muted">{{ taskType(row).label }} / {{ relationText(row.related) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="负责人" width="150">
            <template #default="{ row }">
              <div class="owner">
                <el-avatar :src="personAvatar(row.owner_person_id)" :size="26">{{ initials(personName(row.owner_person_id)) }}</el-avatar>
                <span>{{ personName(row.owner_person_id) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="140">
            <template #default="{ row }">{{ row.done }} / {{ row.target }} {{ row.unit }}</template>
          </el-table-column>
          <el-table-column label="进度" width="160">
            <template #default="{ row }"><el-progress :percentage="taskProgress(row)" :stroke-width="8" /></template>
          </el-table-column>
          <el-table-column label="操作" width="130">
            <template #default="{ row }">
              <el-button link type="primary" :icon="Pencil" @click="openEditDialog(row)">编辑</el-button>
              <el-button link type="danger" :icon="Trash2" @click="deleteTask(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!selectedProduct.tasks.length" description="这个产品还没有开发任务" :image-size="70" />
      </section>
      <template #footer>
        <el-button :icon="ExternalLink" @click="navigateSource(selectedProduct?.source_type, selectedProduct || {})">打开来源</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreateDialog(selectedProduct, 'selection')">为该产品补充选品</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.product-dev-page {
  min-height: 100%;
  padding: 18px;
  color: #172033;
  background: #f5f7fb;
}

.dev-header,
.summary-card,
.people-panel,
.toolbar-panel,
.side-panel,
.product-card {
  border: 1px solid #e3e8f1;
  border-radius: 8px;
  background: #ffffff;
}

.dev-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 18px;
}

.eyebrow,
.panel-heading span {
  color: #64748b;
  font-size: 12px;
  font-weight: 800;
}

.dev-header h1 {
  margin: 6px 0 8px;
  color: #0f172a;
  font-size: 26px;
  line-height: 1.2;
}

.dev-header p {
  max-width: 860px;
  margin: 0;
  color: #64748b;
  font-size: 14px;
  line-height: 1.6;
}

.header-actions,
.toolbar-panel,
.owner,
.type-title,
.type-owners,
.detail-chain button {
  display: flex;
  align-items: center;
}

.header-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.summary-card {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 10px;
  min-height: 96px;
  padding: 16px;
}

.summary-card svg {
  grid-row: 1 / 3;
}

.summary-card span {
  color: #64748b;
  font-size: 13px;
  font-weight: 700;
}

.summary-card strong {
  color: #0f172a;
  font-size: 28px;
  line-height: 1;
}

.is-blue svg,
.type-row.is-blue svg {
  color: #2563eb;
}

.is-orange svg,
.type-row.is-orange svg {
  color: #ea580c;
}

.is-green svg,
.type-row.is-green svg {
  color: #059669;
}

.is-cyan svg,
.type-row.is-cyan svg {
  color: #0891b2;
}

.is-violet svg,
.type-row.is-violet svg {
  color: #7c3aed;
}

.type-row.is-amber svg {
  color: #b45309;
}

.type-row.is-slate svg {
  color: #475569;
}

.people-panel,
.toolbar-panel,
.side-panel {
  margin-top: 12px;
  padding: 14px;
}

.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 12px;
}

.panel-heading h2 {
  margin: 4px 0 0;
  color: #0f172a;
  font-size: 18px;
  line-height: 1.2;
}

.people-lens {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  gap: 12px;
}

.person-pill {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 98px;
  padding: 14px 18px;
  border: 1px solid #d9e2f0;
  border-radius: 999px;
  background: linear-gradient(90deg, #ffffff 0%, #f7fbff 100%);
}

.person-pill.is-empty {
  background: #fafafa;
}

.person-main {
  min-width: 0;
}

.person-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.person-title strong {
  color: #0f172a;
  font-size: 16px;
}

.person-title span,
.person-types span,
.muted {
  color: #64748b;
  font-size: 12px;
}

.person-types {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
  margin-bottom: 8px;
}

.person-pill b {
  color: #2563eb;
  font-size: 18px;
}

.toolbar-panel {
  gap: 10px;
}

.toolbar-panel .el-input {
  max-width: 420px;
}

.toolbar-panel .el-select {
  width: 180px;
}

.board-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 12px;
  margin-top: 12px;
}

.product-board {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 12px;
}

.product-card {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr);
  gap: 14px;
  min-height: 246px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.product-card:hover {
  border-color: #93c5fd;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.08);
}

.product-media,
.detail-hero .el-image,
.image-empty {
  width: 118px;
  height: 156px;
  overflow: hidden;
  border-radius: 8px;
  background: #eef2f7;
}

.product-media :deep(.el-image),
.product-media :deep(img) {
  width: 100%;
  height: 100%;
}

.image-empty {
  display: grid;
  place-items: center;
  color: #94a3b8;
  font-size: 13px;
  font-weight: 700;
}

.product-body {
  min-width: 0;
}

.product-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.product-head h3 {
  display: -webkit-box;
  overflow: hidden;
  min-height: 44px;
  margin: 0 0 4px;
  color: #0f172a;
  font-size: 16px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.product-head span,
.metrics span {
  color: #64748b;
  font-size: 12px;
}

.product-tags {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.source-chain,
.stage-strip,
.product-card footer,
.metrics,
.inline-number {
  display: flex;
  align-items: center;
}

.source-chain {
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 10px;
}

.source-chain button,
.stage-strip button,
.detail-chain button {
  border: 1px solid #dbe3ee;
  border-radius: 999px;
  color: #475569;
  background: #f8fafc;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.source-chain button {
  padding: 5px 9px;
}

.source-chain button.active {
  border-color: #93c5fd;
  color: #1d4ed8;
  background: #eff6ff;
}

.stage-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 6px;
}

.stage-strip button {
  display: grid;
  gap: 2px;
  min-width: 0;
  min-height: 48px;
  padding: 6px 4px;
  border-radius: 8px;
  text-align: center;
}

.stage-strip button.done {
  border-color: #86efac;
  color: #047857;
  background: #f0fdf4;
}

.stage-strip button.active {
  border-color: #facc15;
  color: #92400e;
  background: #fffbeb;
}

.stage-strip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-strip b {
  font-size: 13px;
}

.product-progress {
  margin: 12px 0 10px;
}

.product-card footer {
  justify-content: space-between;
  gap: 10px;
}

.owner {
  gap: 8px;
  color: #475569;
  font-size: 12px;
  font-weight: 700;
}

.metrics {
  gap: 10px;
}

.type-list {
  display: grid;
  gap: 10px;
}

.type-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px 10px;
  width: 100%;
  padding: 12px;
  border: 1px solid #edf1f7;
  border-radius: 8px;
  background: #fafbfe;
  cursor: pointer;
  text-align: left;
}

.type-row:hover {
  border-color: #93c5fd;
}

.type-row .el-progress {
  grid-column: 1 / -1;
}

.type-title {
  min-width: 0;
  gap: 8px;
}

.type-title strong {
  color: #172033;
  font-size: 14px;
}

.type-title small {
  display: block;
  color: #64748b;
  font-size: 12px;
}

.type-owners .el-avatar + .el-avatar {
  margin-left: -8px;
}

.type-row b {
  color: #0f172a;
}

.candidate-image-field {
  display: grid;
  grid-template-columns: 72px auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.candidate-image-field :deep(.el-image) {
  width: 72px;
  height: 72px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.candidate-attachments {
  display: grid;
  gap: 10px;
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attachment-chip,
.attachment-row {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  border: 1px solid #dbe3ee;
  border-radius: 8px;
  color: #334155;
  background: #f8fafc;
}

.attachment-chip {
  max-width: 100%;
  padding: 5px 8px;
}

.attachment-main {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.attachment-chip span,
.attachment-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-chip small,
.attachment-row small {
  flex: none;
  color: #64748b;
}

.task-form :deep(.el-select),
.task-form :deep(.el-date-editor.el-input),
.task-form :deep(.el-input-number) {
  width: 100%;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.form-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.type-detail-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid #e7ebf3;
  border-radius: 8px;
  background: #f8fafc;
}

.inline-number {
  gap: 8px;
}

.product-detail {
  display: grid;
  gap: 14px;
}

.detail-hero {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 14px;
  padding: 12px;
  border: 1px solid #e7ebf3;
  border-radius: 8px;
  background: #f8fafc;
}

.detail-hero h3 {
  margin: 4px 0;
  color: #0f172a;
  font-size: 20px;
}

.detail-hero p,
.detail-hero span {
  margin: 0 0 12px;
  color: #64748b;
  font-size: 13px;
}

.detail-chain {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.detail-chain button {
  justify-content: center;
  gap: 6px;
  min-height: 42px;
  border-radius: 8px;
}

.detail-attachments {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.detail-section-title {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  gap: 6px;
  color: #0f172a;
}

.attachment-row {
  justify-content: flex-start;
  min-height: 40px;
  padding: 8px 10px;
  cursor: pointer;
}

@media (max-width: 1280px) {
  .summary-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .board-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .product-dev-page {
    padding: 12px;
  }

  .dev-header,
  .header-actions,
  .toolbar-panel {
    flex-direction: column;
    align-items: stretch;
  }

  .summary-grid,
  .people-lens,
  .product-board,
    .form-grid,
    .form-grid.three,
    .candidate-image-field,
    .detail-attachments,
    .detail-chain {
    grid-template-columns: 1fr;
  }

  .person-pill,
  .product-card,
  .detail-hero {
    grid-template-columns: 1fr;
    border-radius: 18px;
  }

  .product-media,
  .detail-hero .el-image,
  .image-empty {
    width: 100%;
    height: 220px;
  }

  .stage-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .toolbar-panel .el-input,
  .toolbar-panel .el-select {
    width: 100%;
    max-width: none;
  }
}
</style>
