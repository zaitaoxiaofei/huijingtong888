<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const loading = ref(false);
const dialogVisible = ref(false);
const dialogSubmitting = ref(false);
const importDialogVisible = ref(false);
const importLoading = ref(false);
const importSubmitting = ref(false);
const profitDialogVisible = ref(false);
const selectedRows = ref([]);
const formRef = ref();

const state = reactive({
  rows: [],
  people: [],
  suppliers: [],
  filters: {
    query: "",
    ownerPersonId: "all",
    quoteStatus: "all",
    page: 1,
    pageSize: 30
  }
});

const importState = reactive({
  fileName: "",
  rows: [],
  total: 0,
  valid: 0,
  invalid: 0
});

const dialog = reactive({
  mode: "create",
  currentRow: null,
  form: createDefaultForm()
});

const profitDialog = reactive({
  row: null,
  channelKey: "air",
  quote: null
});

const formRules = {
  name: [{ required: true, message: "请输入商品名称", trigger: "blur" }],
  owner_person_id: [{ required: true, message: "请选择负责人", trigger: "change" }],
  purchase_quantity: [{ required: true, message: "请输入采购数量", trigger: "blur" }]
};

function createDefaultForm() {
  return {
    id: null,
    updated_at: "",
    name: "",
    image_url: "",
    purchase_url: "",
    source_platform: "1688",
    supplier_id: "",
    supplier_note: "",
    owner_person_id: "",
    shipping_method: "air",
    purchase_cost: 0,
    domestic_shipping: 0,
    handling_fee: 0,
    purchase_quantity: 1,
    package_weight_g: 0,
    length_cm: 30,
    width_cm: 20,
    height_cm: 10,
    listing_price_rub: 0,
    air_sale_price_rmb: 0,
    exchange_rate: 11.32,
    desired_profit_mode: "margin",
    desired_profit_value: 20,
    return_rate: 0.05,
    product_type: "main"
  };
}

const filteredRows = computed(() => {
  const query = normalizeText(state.filters.query);
  const ownerPersonId = String(state.filters.ownerPersonId || "all");
  const quoteStatus = String(state.filters.quoteStatus || "all");

  return state.rows.filter((row) => {
    if (ownerPersonId !== "all" && String(row.owner_person_id || "") !== ownerPersonId) return false;
    if (quoteStatus === "missing" && (getQuote(row, "air") || getQuote(row, "land"))) return false;
    if (quoteStatus === "quoted" && !getQuote(row, "air") && !getQuote(row, "land")) return false;
    if (!query) return true;

    const haystack = normalizeText([
      row.name,
      row.inventory_id,
      row.code,
      row.selection_id,
      row.purchase_url,
      row.owner_name,
      row.creator_name,
      getSupplierName(row.supplier_id)
    ].join(" "));
    return haystack.includes(query);
  });
});

const sortedRows = computed(() => {
  return [...filteredRows.value].sort((a, b) => {
    return String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
      || Number(b.id || 0) - Number(a.id || 0);
  });
});

const total = computed(() => sortedRows.value.length);

const pagedRows = computed(() => {
  const start = (state.filters.page - 1) * state.filters.pageSize;
  return sortedRows.value.slice(start, start + state.filters.pageSize);
});

const summary = computed(() => {
  const rows = filteredRows.value;
  const quotedRows = rows.filter((row) => getQuote(row, "air") || getQuote(row, "land"));
  const missingQuoteRows = rows.length - quotedRows.length;
  const avgPurchaseCost = rows.length
    ? rows.reduce((sum, row) => sum + Number(row.purchase_cost || 0), 0) / rows.length
    : 0;

  return {
    products: rows.length,
    quotedRows: quotedRows.length,
    missingQuoteRows,
    avgPurchaseCost
  };
});

const dialogTitle = computed(() => (dialog.mode === "create" ? "新增选品" : "编辑选品"));
const importPreviewRows = computed(() => importState.rows.slice(0, 12));
const importCommitRows = computed(() => importState.rows.filter((row) => row.ok).map((row) => row.data));
const profitDetailRows = computed(() => buildProfitDetailRows(profitDialog.row, profitDialog.quote, profitDialog.channelKey));
const profitFormulaText = "净利润 = 售价 - 均摊采购成本 - 国际运费 - 佣金 - 尾程+银行 - 提现费 - 广告预算 - 退货损失";

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function numberText(value, digits = 0) {
  return Number(value || 0).toFixed(digits);
}

function percentText(value, digits = 2) {
  return `${numberText(value, digits)}%`;
}

function dateText(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function getSupplierName(supplierId) {
  const matched = state.suppliers.find((item) => Number(item.id) === Number(supplierId));
  return matched?.name || "-";
}

function personName(id) {
  return state.people.find((person) => Number(person.id) === Number(id))?.name || "";
}

function importStatusText(row) {
  return [...(row.errors || []), ...(row.warnings || [])].join("；");
}

function getPricing(row) {
  return row?.pricing && typeof row.pricing === "object" ? row.pricing : null;
}

function getQuote(row, channelKey) {
  const pricing = getPricing(row);
  return pricing?.[channelKey] || null;
}

function getSuggestedRub(row, channelKey) {
  const pricing = getPricing(row);
  return pricing?.[channelKey === "air" ? "suggestedRub_air" : "suggestedRub_land"] ?? null;
}

function getSaleRmb(product) {
  const listed = Number(product?.listing_price_rub || 0);
  const exchangeRate = Number(product?.exchange_rate || 11.32);
  return Number(product?.air_sale_price_rmb || 0) || (exchangeRate > 0 ? listed / exchangeRate : 0);
}

function getPurchaseCostPerUnit(product) {
  const quantity = Math.max(Number(product?.purchase_quantity || 1), 1);
  return Number(product?.purchase_cost || 0) + Number(product?.domestic_shipping || 0) / quantity + Number(product?.handling_fee || 0);
}

function methodName(method) {
  if (method === "land") return "陆运";
  if (method === "air" || method === "air_land") return "陆空";
  if (method === "sea") return "海运";
  return "未标明";
}

function sourceName(source) {
  const map = {
    "1688": "1688",
    taobao: "淘宝",
    pinduoduo: "拼多多",
    pdd: "拼多多",
    supplier: "供应商",
    other: "其他"
  };
  return map[source] || source || "-";
}

function shippingFormulaText(channelKey, row, quote) {
  if (!quote) return "当前没有可用报价";
  const weight = numberText(row?.package_weight_g || 0);
  const dimensions = `${numberText(row?.length_cm || 0)} x ${numberText(row?.width_cm || 0)} x ${numberText(row?.height_cm || 0)}`;
  const days = quote.days ? `，时效 ${quote.days}` : "";
  return `${methodName(channelKey)} / ${quote.channel || "-"}，计费重 ${numberText(getPricing(row)?.chargeableWeightKg || 0, 2)} kg，实重 ${weight} g，尺寸 ${dimensions} cm${days}`;
}

function buildProfitDetailRows(row, quote, channelKey) {
  if (!row || !quote) return [];

  const sale = getSaleRmb(row);
  const purchaseUnit = getPurchaseCostPerUnit(row);
  const purchaseQty = Math.max(Number(row.purchase_quantity || 1), 1);
  const domesticShare = Number(row.domestic_shipping || 0) / purchaseQty;
  const commissionRate = sale ? Number(quote.commission || 0) / sale : 0;
  const finalMile = Number(quote.finalMileBankFee ?? quote.paymentFee ?? 0);
  const advertisingCost = Number(quote.advertisingCost || 0);
  const totalCost =
    purchaseUnit +
    Number(quote.amount || 0) +
    Number(quote.commission || 0) +
    finalMile +
    Number(quote.withdrawalFee || 0) +
    advertisingCost +
    Number(quote.expectedReturnLoss || 0);

  return [
    { label: "售价", value: money(sale), note: "选品表售价 RMB" },
    { label: "采购单价", value: money(row.purchase_cost), note: "库存产品录入的单件采购价" },
    { label: "国内运费均摊", value: money(domesticShare), note: `${money(row.domestic_shipping)} / ${purchaseQty} 件` },
    { label: "均摊采购成本", value: money(purchaseUnit), note: "采购单价 + 国内运费均摊 + 处理费" },
    { label: "运送方式", value: methodName(channelKey), note: shippingFormulaText(channelKey, row, quote) },
    { label: "国际运费", value: money(quote.amount), note: shippingFormulaText(channelKey, row, quote) },
    { label: "Ozon 佣金", value: money(quote.commission), note: `售价 x ${percentText(commissionRate * 100)}` },
    { label: "末公里+银行", value: money(finalMile), note: "售价 x 1.4% + 阶梯末公里费" },
    { label: "提现费", value: money(quote.withdrawalFee), note: "(售价 - 末公里+银行 - 运费 - 售价 x 20%) x 1.2%" },
    { label: "广告预算", value: money(advertisingCost), note: "当前默认 0，后续可接真实广告预算率" },
    { label: "退货损失", value: money(quote.expectedReturnLoss), note: `(均摊采购成本 + 运费) x ${percentText(Number(row.return_rate ?? 0.05) * 100)}` },
    { label: "成本合计", value: money(totalCost), note: "除售价外所有扣减项合计" },
    { label: "净利润", value: money(quote.profit), note: `售价 - 成本合计，净利率 ${percentText(quote.margin)}`, total: true }
  ];
}

function openProfitDialog(row, channelKey) {
  const quote = getQuote(row, channelKey);
  if (!quote) {
    ElMessage.warning(`当前商品没有${methodName(channelKey)}报价`);
    return;
  }
  profitDialog.row = row;
  profitDialog.channelKey = channelKey;
  profitDialog.quote = quote;
  profitDialogVisible.value = true;
}

function closeProfitDialog() {
  profitDialogVisible.value = false;
  profitDialog.row = null;
  profitDialog.channelKey = "air";
  profitDialog.quote = null;
}

async function loadPageData() {
  loading.value = true;
  try {
    const [products, people, suppliers] = await Promise.all([
      apiClient.get("/api/products/selection"),
      apiClient.get("/api/people"),
      apiClient.get("/api/suppliers")
    ]);
    state.rows = Array.isArray(products) ? products : [];
    state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
    state.suppliers = Array.isArray(suppliers) ? suppliers : [];
  } catch (error) {
    ElMessage.error(error.message || "选品计价表加载失败");
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  state.filters.page = 1;
}

function handleReset() {
  state.filters.query = "";
  state.filters.ownerPersonId = "all";
  state.filters.quoteStatus = "all";
  state.filters.page = 1;
}

function handlePageChange(page) {
  state.filters.page = page;
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
}

function handleSelectionChange(rows) {
  selectedRows.value = rows;
}

function resetDialogForm() {
  dialog.form = createDefaultForm();
  dialog.currentRow = null;
}

function openCreateDialog() {
  dialog.mode = "create";
  resetDialogForm();
  dialog.form.owner_person_id = state.people[0]?.id || "";
  dialogVisible.value = true;
}

async function openEditDialog(row) {
  loading.value = true;
  try {
    const detail = await apiClient.get(`/api/products/${row.id}`);
    dialog.mode = "edit";
    dialog.currentRow = row;
    dialog.form = {
      ...createDefaultForm(),
      id: detail.id,
      updated_at: detail.updated_at || "",
      name: detail.name || "",
      image_url: detail.image_url || "",
      purchase_url: detail.purchase_url || "",
      source_platform: detail.source_platform || "1688",
      supplier_id: detail.supplier_id || "",
      supplier_note: detail.supplier_note || "",
      owner_person_id: detail.owner_person_id || state.people[0]?.id || "",
      shipping_method: detail.shipping_method || "air",
      purchase_cost: Number(detail.purchase_cost || 0),
      domestic_shipping: Number(detail.domestic_shipping || 0),
      handling_fee: Number(detail.handling_fee || 0),
      purchase_quantity: Number(detail.purchase_quantity || 1),
      package_weight_g: Number(detail.package_weight_g || 0),
      length_cm: Number(detail.length_cm || 30),
      width_cm: Number(detail.width_cm || 20),
      height_cm: Number(detail.height_cm || 10),
      listing_price_rub: Number(detail.listing_price_rub || 0),
      air_sale_price_rmb: Number(detail.air_sale_price_rmb || 0),
      exchange_rate: Number(detail.exchange_rate || 11.32),
      desired_profit_mode: detail.desired_profit_mode || "margin",
      desired_profit_value: Number(detail.desired_profit_value || 20),
      return_rate: Number(detail.return_rate || 0.05),
      product_type: detail.product_type || "main"
    };
    dialogVisible.value = true;
  } catch (error) {
    ElMessage.error(error.message || "选品详情加载失败");
  } finally {
    loading.value = false;
  }
}

function handleDialogClosed() {
  resetDialogForm();
  formRef.value?.clearValidate?.();
}

async function submitDialog() {
  if (!formRef.value) return;
  await formRef.value.validate();

  dialogSubmitting.value = true;
  try {
    const payload = {
      ...dialog.form,
      supplier_id: dialog.form.supplier_id || null,
      owner_person_id: Number(dialog.form.owner_person_id || 0) || null,
      purchase_cost: Number(dialog.form.purchase_cost || 0),
      domestic_shipping: Number(dialog.form.domestic_shipping || 0),
      handling_fee: Number(dialog.form.handling_fee || 0),
      purchase_quantity: Number(dialog.form.purchase_quantity || 1),
      package_weight_g: Number(dialog.form.package_weight_g || 0),
      length_cm: Number(dialog.form.length_cm || 30),
      width_cm: Number(dialog.form.width_cm || 20),
      height_cm: Number(dialog.form.height_cm || 10),
      listing_price_rub: Number(dialog.form.listing_price_rub || 0),
      air_sale_price_rmb: Number(dialog.form.air_sale_price_rmb || 0),
      exchange_rate: Number(dialog.form.exchange_rate || 11.32),
      desired_profit_value: Number(dialog.form.desired_profit_value || 20),
      return_rate: Number(dialog.form.return_rate || 0.05)
    };

    if (dialog.mode === "create") {
      await apiClient.post("/api/products", payload);
      ElMessage.success("选品已新增");
    } else {
      await apiClient.put(`/api/products/${dialog.form.id}`, payload);
      ElMessage.success("选品已更新");
    }

    dialogVisible.value = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "保存失败");
  } finally {
    dialogSubmitting.value = false;
  }
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确认删除选品“${row.name || row.inventory_id || row.code || row.id}”吗？删除后将从当前有效列表中移除。`,
      "删除确认",
      { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" }
    );
    await apiClient.delete(`/api/products/${row.id}`);
    ElMessage.success("选品已删除");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除失败");
  }
}

function resetImportState() {
  importState.fileName = "";
  importState.rows = [];
  importState.total = 0;
  importState.valid = 0;
  importState.invalid = 0;
}

function openImportDialog() {
  resetImportState();
  importDialogVisible.value = true;
}

async function handleImportFileChange(uploadFile) {
  const rawFile = uploadFile?.raw;
  if (!rawFile) return;

  importLoading.value = true;
  importState.fileName = rawFile.name || "";
  try {
    const csv = await rawFile.text();
    const result = await apiClient.post("/api/products/import-preview", { csv });
    importState.rows = Array.isArray(result.rows) ? result.rows : [];
    importState.total = Number(result.total || 0);
    importState.valid = Number(result.valid || 0);
    importState.invalid = Number(result.invalid || 0);
    ElMessage.success("CSV 预解析完成");
  } catch (error) {
    resetImportState();
    ElMessage.error(error.message || "CSV 解析失败");
  } finally {
    importLoading.value = false;
  }
}

async function commitImport() {
  if (!importCommitRows.value.length) {
    ElMessage.warning("当前没有可导入的数据");
    return;
  }

  importSubmitting.value = true;
  try {
    const result = await apiClient.post("/api/products/import-commit", { rows: importCommitRows.value });
    ElMessage.success(`导入完成：成功 ${result.inserted || 0} 条，跳过 ${result.skipped || 0} 条`);
    importDialogVisible.value = false;
    resetImportState();
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "导入失败");
  } finally {
    importSubmitting.value = false;
  }
}

function handleBatchAction() {
  if (!selectedRows.value.length) {
    ElMessage.warning("请先选择需要处理的选品");
    return;
  }
  ElMessage.info("批量操作会在后续迁移中接入统一动作中心。");
}

onMounted(loadPageData);
</script>

<template>
  <div class="page-stack selection-page">
    <section class="page-hero selection-hero">
      <div>
        <h2>选品计价表</h2>
        <p>面向跨境电商选品、采购成本、物流计价和利润试算的统一工作台。</p>
      </div>
      <div class="page-card-actions">
        <el-button @click="openImportDialog">批量导入</el-button>
        <el-button type="primary" @click="openCreateDialog">新增选品</el-button>
      </div>
    </section>

    <el-row :gutter="16">
      <el-col :xs="24" :sm="12" :xl="6">
        <el-card shadow="never" class="metric-card">
          <span class="metric-label">当前选品</span>
          <strong class="metric-value">{{ summary.products }}</strong>
          <span class="metric-suffix">筛选范围内有效数据</span>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :xl="6">
        <el-card shadow="never" class="metric-card">
          <span class="metric-label">已命中报价</span>
          <strong class="metric-value">{{ summary.quotedRows }}</strong>
          <span class="metric-suffix">至少存在一个物流报价</span>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :xl="6">
        <el-card shadow="never" class="metric-card">
          <span class="metric-label">待补规则</span>
          <strong class="metric-value">{{ summary.missingQuoteRows }}</strong>
          <span class="metric-suffix">未命中陆空或陆运报价</span>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :xl="6">
        <el-card shadow="never" class="metric-card">
          <span class="metric-label">平均采购成本</span>
          <strong class="metric-value">{{ money(summary.avgPurchaseCost) }}</strong>
          <span class="metric-suffix">RMB / 件</span>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="page-card selection-table-card">
      <template #header>
        <div class="page-card-header">
          <div>
            <strong>选品列表</strong>
            <span>按统一后台规范组织筛选、操作、表格和分页，原有接口保持不变。</span>
          </div>
          <el-tag effect="plain">Vue 3 + Element Plus</el-tag>
        </div>
      </template>

      <div class="filter-panel selection-filter-panel">
        <el-form inline>
          <el-form-item label="关键词">
            <el-input
              v-model="state.filters.query"
              placeholder="商品名称 / 商品ID / 选品ID / 负责人"
              clearable
              style="width: 320px"
              @keyup.enter="handleSearch"
            />
          </el-form-item>
          <el-form-item label="负责人">
            <el-select v-model="state.filters.ownerPersonId" style="width: 180px">
              <el-option label="全部负责人" value="all" />
              <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="报价状态">
            <el-select v-model="state.filters.quoteStatus" style="width: 170px">
              <el-option label="全部状态" value="all" />
              <el-option label="已命中报价" value="quoted" />
              <el-option label="待补报价规则" value="missing" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="handleSearch">查询</el-button>
            <el-button @click="handleReset">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="toolbar-panel selection-toolbar-panel">
        <div class="toolbar-left">
          <el-button type="primary" @click="openCreateDialog">新增选品</el-button>
          <el-button @click="openImportDialog">批量导入</el-button>
          <el-button :disabled="!selectedRows.length" @click="handleBatchAction">
            批量操作
          </el-button>
        </div>
        <div class="toolbar-right">
          <span>已选 {{ selectedRows.length }} 项</span>
          <el-button @click="loadPageData">刷新</el-button>
        </div>
      </div>

      <div class="selection-table-wrap">
        <el-table
          v-loading="loading"
          :data="pagedRows"
          stripe
          border
          class="erp-data-table selection-table"
          row-key="id"
          @selection-change="handleSelectionChange"
        >
          <el-table-column type="selection" width="46" fixed="left" />
          <el-table-column label="商品信息" min-width="310" fixed="left">
            <template #default="{ row }">
              <div class="product-cell">
                <el-image
                  v-if="row.image_url"
                  :src="row.image_url"
                  fit="cover"
                  class="product-thumb"
                  :preview-src-list="[row.image_url]"
                  preview-teleported
                />
                <div v-else class="product-thumb product-thumb-empty">无图</div>
                <div class="cell-stack gap-sm">
                  <strong class="product-name">{{ row.name || "-" }}</strong>
                  <span class="muted-text">库存编码：{{ row.inventory_id || row.code || "-" }}</span>
                  <span class="muted-text">选品 ID：{{ row.selection_id || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="归属 / 渠道" min-width="170">
            <template #default="{ row }">
              <div class="cell-stack gap-sm">
                <span>{{ row.owner_name || "-" }}</span>
                <span class="muted-text">{{ getSupplierName(row.supplier_id) }}</span>
                <span class="muted-text">{{ sourceName(row.source_platform) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="采购成本" min-width="150" align="right">
            <template #default="{ row }">
              <div class="cell-stack align-end gap-sm">
                <strong>¥{{ money(row.purchase_cost) }}</strong>
                <span class="muted-text">均摊：¥{{ money(getPurchaseCostPerUnit(row)) }}</span>
                <span class="muted-text">数量：{{ numberText(row.purchase_quantity) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="售价" min-width="140" align="right">
            <template #default="{ row }">
              <div class="cell-stack align-end gap-sm">
                <strong>¥{{ money(getSaleRmb(row)) }}</strong>
                <span class="muted-text">{{ money(row.listing_price_rub) }} RUB</span>
                <span class="muted-text">汇率 {{ numberText(row.exchange_rate || 11.32, 4) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="重量 / 尺寸" min-width="160" align="center">
            <template #default="{ row }">
              <div class="cell-stack gap-sm">
                <span>{{ numberText(row.package_weight_g) }} g</span>
                <span class="muted-text">{{ numberText(row.length_cm) }} x {{ numberText(row.width_cm) }} x {{ numberText(row.height_cm) }} cm</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="利润报价" min-width="360">
            <template #default="{ row }">
              <div class="quote-grid">
                <div class="quote-card" :class="{ 'is-missing': !getQuote(row, 'air') }">
                  <div class="quote-card-head">
                    <strong>陆空</strong>
                    <el-tag v-if="getQuote(row, 'air')" size="small" type="success" effect="plain">
                      {{ percentText(getQuote(row, "air").margin) }}
                    </el-tag>
                    <el-tag v-else size="small" type="info" effect="plain">暂无</el-tag>
                  </div>
                  <template v-if="getQuote(row, 'air')">
                    <span>利润 ¥{{ money(getQuote(row, "air").profit) }}</span>
                    <span>运费 ¥{{ money(getQuote(row, "air").amount) }}</span>
                    <span>建议 {{ getSuggestedRub(row, "air") ? `${money(getSuggestedRub(row, "air"))} RUB` : "-" }}</span>
                    <el-button link type="primary" @click="openProfitDialog(row, 'air')">明细</el-button>
                  </template>
                  <span v-else class="muted-text">未命中陆空规则</span>
                </div>

                <div class="quote-card" :class="{ 'is-missing': !getQuote(row, 'land') }">
                  <div class="quote-card-head">
                    <strong>陆运</strong>
                    <el-tag v-if="getQuote(row, 'land')" size="small" type="success" effect="plain">
                      {{ percentText(getQuote(row, "land").margin) }}
                    </el-tag>
                    <el-tag v-else size="small" type="info" effect="plain">暂无</el-tag>
                  </div>
                  <template v-if="getQuote(row, 'land')">
                    <span>利润 ¥{{ money(getQuote(row, "land").profit) }}</span>
                    <span>运费 ¥{{ money(getQuote(row, "land").amount) }}</span>
                    <span>建议 {{ getSuggestedRub(row, "land") ? `${money(getSuggestedRub(row, "land"))} RUB` : "-" }}</span>
                    <el-button link type="primary" @click="openProfitDialog(row, 'land')">明细</el-button>
                  </template>
                  <span v-else class="muted-text">未命中陆运规则</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="目标" min-width="130" align="center">
            <template #default="{ row }">
              <div class="cell-stack gap-sm">
                <el-tag effect="plain">{{ row.desired_profit_mode === "margin" ? "净利率" : "利润额" }}</el-tag>
                <span>{{ numberText(row.desired_profit_value, 2) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="更新时间" min-width="155">
            <template #default="{ row }">{{ dateText(row.updated_at || row.created_at) }}</template>
          </el-table-column>

          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <div class="table-actions">
                <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="selection-footer"
        :total="total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :page-sizes="[30, 50, 100]"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="960px"
      align-center
      destroy-on-close
      class="selection-form-dialog erp-centered-dialog"
      @closed="handleDialogClosed"
    >
      <el-form ref="formRef" :model="dialog.form" :rules="formRules" label-width="112px">
        <div class="form-section">
          <div class="form-section-title">基础信息</div>
          <el-row :gutter="18">
            <el-col :span="12">
              <el-form-item label="商品名称" prop="name">
                <el-input v-model="dialog.form.name" placeholder="请输入商品名称" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="负责人" prop="owner_person_id">
                <el-select v-model="dialog.form.owner_person_id" placeholder="请选择负责人">
                  <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="供应商">
                <el-select v-model="dialog.form.supplier_id" clearable placeholder="请选择供应商">
                  <el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="来源平台">
                <el-select v-model="dialog.form.source_platform">
                  <el-option label="1688" value="1688" />
                  <el-option label="淘宝" value="taobao" />
                  <el-option label="拼多多" value="pinduoduo" />
                  <el-option label="供应商" value="supplier" />
                  <el-option label="其他" value="other" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="采购链接">
                <el-input v-model="dialog.form.purchase_url" placeholder="https://detail.1688.com/..." />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="图片链接">
                <el-input v-model="dialog.form.image_url" placeholder="图片 URL 或系统图片地址" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <div class="form-section">
          <div class="form-section-title">采购与包装</div>
          <el-row :gutter="18">
            <el-col :span="8">
              <el-form-item label="采购成本">
                <el-input-number v-model="dialog.form.purchase_cost" :min="0" :precision="2" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="国内运费">
                <el-input-number v-model="dialog.form.domestic_shipping" :min="0" :precision="2" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="处理费">
                <el-input-number v-model="dialog.form.handling_fee" :min="0" :precision="2" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="采购数量" prop="purchase_quantity">
                <el-input-number v-model="dialog.form.purchase_quantity" :min="1" :precision="0" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="重量(g)">
                <el-input-number v-model="dialog.form.package_weight_g" :min="0" :precision="0" :step="10" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="运输方式">
                <el-select v-model="dialog.form.shipping_method">
                  <el-option label="陆空" value="air" />
                  <el-option label="陆运" value="land" />
                  <el-option label="海运" value="sea" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="长(cm)">
                <el-input-number v-model="dialog.form.length_cm" :min="0" :precision="0" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="宽(cm)">
                <el-input-number v-model="dialog.form.width_cm" :min="0" :precision="0" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="高(cm)">
                <el-input-number v-model="dialog.form.height_cm" :min="0" :precision="0" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <div class="form-section">
          <div class="form-section-title">定价与利润</div>
          <el-row :gutter="18">
            <el-col :span="8">
              <el-form-item label="标价(RUB)">
                <el-input-number v-model="dialog.form.listing_price_rub" :min="0" :precision="2" :step="10" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="售价(RMB)">
                <el-input-number v-model="dialog.form.air_sale_price_rmb" :min="0" :precision="2" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="汇率">
                <el-input-number v-model="dialog.form.exchange_rate" :min="0" :precision="4" :step="0.01" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="利润模式">
                <el-select v-model="dialog.form.desired_profit_mode">
                  <el-option label="净利率" value="margin" />
                  <el-option label="利润额" value="profit" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="利润目标">
                <el-input-number v-model="dialog.form.desired_profit_value" :min="0" :precision="2" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="退货率">
                <el-input-number v-model="dialog.form.return_rate" :min="0" :max="1" :precision="2" :step="0.01" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="24">
              <el-form-item label="供应商备注">
                <el-input
                  v-model="dialog.form.supplier_note"
                  type="textarea"
                  :rows="3"
                  placeholder="记录采购渠道、MOQ、打样或谈价说明"
                />
              </el-form-item>
            </el-col>
          </el-row>
        </div>
      </el-form>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="dialogSubmitting" @click="submitDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="profitDialogVisible" title="净利计算明细" width="980px" align-center class="erp-centered-dialog" @closed="closeProfitDialog">
      <div v-if="profitDialog.row && profitDialog.quote" class="page-stack">
        <div class="profit-dialog-title">
          <div class="product-cell">
            <el-image
              v-if="profitDialog.row.image_url"
              :src="profitDialog.row.image_url"
              fit="cover"
              class="profit-thumb"
              :preview-src-list="[profitDialog.row.image_url]"
              preview-teleported
            />
            <div class="cell-stack gap-sm">
              <strong>{{ profitDialog.row.name || "-" }}</strong>
              <span class="muted-text">{{ profitDialog.row.selection_id || profitDialog.row.code || "-" }} / {{ methodName(profitDialog.channelKey) }}</span>
              <span class="muted-text">物流分类：{{ getPricing(profitDialog.row)?.categoryLabel || "-" }}</span>
            </div>
          </div>
          <div class="profit-summary-cards">
            <div class="profit-summary-card">
              <span class="muted-text">净利润</span>
              <strong>{{ money(profitDialog.quote.profit) }}</strong>
            </div>
            <div class="profit-summary-card">
              <span class="muted-text">净利率</span>
              <strong>{{ percentText(profitDialog.quote.margin) }}</strong>
            </div>
            <div class="profit-summary-card">
              <span class="muted-text">建议售价</span>
              <strong>{{ getSuggestedRub(profitDialog.row, profitDialog.channelKey) ? `${money(getSuggestedRub(profitDialog.row, profitDialog.channelKey))} RUB` : "-" }}</strong>
            </div>
          </div>
        </div>

        <el-alert type="info" :closable="false" show-icon>
          <template #title>{{ profitFormulaText }}</template>
        </el-alert>

        <el-table :data="profitDetailRows" border stripe class="erp-data-table profit-detail-table">
          <el-table-column prop="label" label="项目" width="160" />
          <el-table-column prop="value" label="金额" width="160" align="right">
            <template #default="{ row }">
              <strong :class="{ 'profit-total-text': row.total }">{{ row.value }}</strong>
            </template>
          </el-table-column>
          <el-table-column prop="note" label="计算说明" min-width="420" />
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="importDialogVisible" title="批量导入选品" width="980px" align-center class="erp-centered-dialog">
      <div class="page-stack">
        <el-upload
          drag
          :auto-upload="false"
          :show-file-list="false"
          accept=".csv,text/csv"
          :on-change="handleImportFileChange"
        >
          <div class="import-dropzone">
            <strong>{{ importState.fileName || "拖拽或点击上传 CSV 文件" }}</strong>
            <span>请选择从飞书导出的 CSV 文件，系统会先做预解析。</span>
          </div>
        </el-upload>

        <div v-if="importLoading" class="import-empty">正在解析 CSV...</div>

        <template v-else-if="importState.total > 0">
          <div class="import-summary">
            <span>共 {{ importState.total }} 行</span>
            <el-tag type="success">可导入 {{ importState.valid }}</el-tag>
            <el-tag :type="importState.invalid ? 'danger' : 'info'">异常 {{ importState.invalid }}</el-tag>
          </div>

          <div class="import-table-wrap">
            <el-table :data="importPreviewRows" stripe border class="erp-data-table">
              <el-table-column prop="index" label="行号" width="80" />
              <el-table-column label="商品" min-width="240">
                <template #default="{ row }">
                  <div class="cell-stack gap-sm">
                    <strong>{{ row.data?.name || "-" }}</strong>
                    <span class="muted-text">{{ row.data?.supplier_note || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="人员" min-width="120">
                <template #default="{ row }">{{ personName(row.data?.owner_person_id) || "-" }}</template>
              </el-table-column>
              <el-table-column label="采购 / 售价" min-width="150" align="right">
                <template #default="{ row }">{{ money(row.data?.purchase_cost) }} / {{ money(row.data?.air_sale_price_rmb) }}</template>
              </el-table-column>
              <el-table-column label="状态" min-width="220">
                <template #default="{ row }">
                  <div class="cell-stack gap-sm">
                    <el-tag :type="row.ok ? 'success' : 'danger'">{{ row.ok ? "可导入" : "异常" }}</el-tag>
                    <span class="muted-text">{{ importStatusText(row) || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div v-if="importState.rows.length > importPreviewRows.length" class="table-footer-meta">
            只预览前 {{ importPreviewRows.length }} 行，确认后会导入全部可用行。
          </div>
        </template>

        <div v-else class="import-empty">请选择从飞书导出的 CSV 文件。</div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="importDialogVisible = false">取消</el-button>
          <el-button type="primary" :disabled="!importCommitRows.length" :loading="importSubmitting" @click="commitImport">
            确认导入
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.selection-page {
  min-height: 100%;
}

.selection-hero p {
  max-width: 760px;
}

.selection-table-card {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 286px);
}

.selection-filter-panel {
  margin-bottom: 12px;
}

.selection-toolbar-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.toolbar-right {
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.selection-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.selection-table {
  min-width: 1740px;
}

.selection-table :deep(.el-table__cell) {
  padding: 8px 0;
}

.selection-footer {
  margin-top: auto;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gap-sm {
  gap: 4px;
}

.align-end {
  align-items: flex-end;
}

.muted-text {
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.product-cell {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.product-name {
  line-height: 1.35;
}

.product-thumb,
.profit-thumb {
  width: 50px;
  height: 50px;
  border-radius: 10px;
  border: 1px solid var(--erp-border);
  background: #fff;
  flex-shrink: 0;
}

.product-thumb-empty {
  display: grid;
  place-items: center;
  color: var(--erp-text-secondary);
  font-size: 12px;
  background: var(--erp-surface-alt);
}

.quote-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.quote-card {
  display: grid;
  gap: 5px;
  padding: 10px;
  border: 1px solid var(--erp-border);
  border-radius: 12px;
  background: #f9fbfd;
  font-size: 12px;
}

.quote-card.is-missing {
  background: #fcfcfc;
  border-style: dashed;
}

.quote-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.table-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 10px;
}

.form-section {
  padding: 14px 16px 4px;
  border: 1px solid var(--erp-border);
  border-radius: 14px;
  background: var(--erp-surface-alt);
}

.form-section + .form-section {
  margin-top: 14px;
}

.form-section-title {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--erp-text);
}

.selection-form-dialog :deep(.el-input-number) {
  width: 100%;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.profit-dialog-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.profit-summary-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(120px, 1fr));
  gap: 12px;
  min-width: 360px;
}

.profit-summary-card {
  display: grid;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--erp-border);
  border-radius: 14px;
  background: #f8fafc;
}

.profit-summary-card strong {
  font-size: 18px;
  line-height: 1.2;
}

.profit-total-text {
  color: #0f766e;
}

.profit-detail-table :deep(.el-table__row:last-child td) {
  background: rgba(15, 118, 110, 0.08);
}

.import-dropzone {
  display: grid;
  gap: 6px;
  padding: 16px;
  text-align: center;
}

.import-dropzone strong {
  font-size: 15px;
}

.import-dropzone span,
.import-empty {
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.import-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.import-table-wrap {
  max-height: 420px;
  overflow: auto;
}

@media (max-width: 1360px) {
  .quote-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 960px) {
  .selection-toolbar-panel {
    flex-direction: column;
    align-items: stretch;
  }

  .profit-summary-cards {
    grid-template-columns: 1fr;
    min-width: 0;
    width: 100%;
  }
}
</style>
