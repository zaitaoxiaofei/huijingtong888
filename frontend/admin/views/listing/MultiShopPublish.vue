<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { CircleCheck, Refresh, Search, Tickets, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { withImageToken } from "../../api/tools/imageCropper";
import WatermarkPreview from "../../components/listing/WatermarkPreview.vue";

const loading = ref(false);
const generating = ref(false);
const creatingTask = ref(false);
const exportingPackage = ref(false);
const previewDrawerVisible = ref(false);
const imagePreviewVisible = ref(false);
const imagePreviewRow = ref(null);
const selectedProductId = ref("");
const selectedShopIds = ref([]);
const tableRef = ref(null);

const bulkForm = reactive({
  price: null,
  stock: null,
  titlePrefix: "",
  titleSuffix: ""
});

const state = reactive({
  products: [],
  shops: [],
  watermarkTemplates: [],
  shopRows: [],
  generatedVersions: [],
  taskDraft: null
});

const selectedProduct = computed(() => {
  return state.products.find((item) => Number(item.id) === Number(selectedProductId.value)) || null;
});

const selectedRows = computed(() => {
  const selected = new Set(selectedShopIds.value.map(Number));
  return state.shopRows.filter((row) => selected.has(Number(row.shopId)));
});

const canGenerate = computed(() => Boolean(selectedProduct.value && selectedRows.value.length));

const summary = computed(() => {
  const rows = selectedRows.value;
  const blocked = rows.filter((row) => validateRow(row).errors.length).length;
  return {
    selected: rows.length,
    activeShops: state.shops.filter((shop) => shop.status === "active").length,
    generated: state.generatedVersions.length,
    blocked
  };
});

const previewPayload = computed(() => {
  return state.generatedVersions.map((version) => ({
    shop_id: version.shopId,
    shop_name: version.shopName,
    offer_id: version.offerId,
    title: version.title,
    price: version.price,
    stock: version.stock,
    images: version.images,
    description: version.description,
    watermark_template_id: version.watermarkTemplateId
  }));
});

const generatedVersionMap = computed(() => {
  return new Map(state.generatedVersions.map((version) => [Number(version.shopId), version]));
});

async function loadBootstrap() {
  loading.value = true;
  try {
    const bootstrap = await apiClient.get("/api/multi-shop-publish/bootstrap", { noCache: true }).catch(loadFallbackBootstrap);
    state.products = normalizeProducts(bootstrap.products || []);
    state.shops = normalizeShops(bootstrap.shops || []);
    state.watermarkTemplates = normalizeWatermarks(bootstrap.watermarkTemplates || bootstrap.watermark_templates || []);
    if (!selectedProductId.value && state.products[0]) selectedProductId.value = state.products[0].id;
    rebuildShopRows();
  } finally {
    loading.value = false;
  }
}

async function loadFallbackBootstrap(error) {
  if (error?.status && error.status !== 404) throw error;
  const shops = await apiClient.get("/api/shops", { noCache: true }).catch(() => []);
  return {
    products: demoProducts(),
    shops: shops.length ? shops : demoShops(),
    watermarkTemplates: demoWatermarks(shops)
  };
}

function normalizeProducts(products) {
  const list = Array.isArray(products) ? products : [];
  return list.map((item) => ({
    id: item.id,
    name: item.name || item.product_name || "未命名商品",
    category: item.category || item.product_category || "",
    vehicleModels: item.vehicle_models || item.vehicleModels || item.shipping_method || "",
    brand: item.brand || "",
    material: item.material || "",
    costPrice: Number(item.cost_price || item.purchase_cost || 0),
    defaultSalePrice: Number(item.default_sale_price || item.sale_price_rmb || item.listing_price_rub || 0),
    stock: Number(item.stock_quantity || item.available_stock || 0),
    description: item.description || item.supplier_note || "",
    status: item.status || (item.active === 0 ? "paused" : "active"),
    assets: normalizeAssets(item.assets || item.images || item.source_images || item.image_url)
  }));
}

function normalizeAssets(rawAssets) {
  if (!rawAssets) return [];
  const assets = Array.isArray(rawAssets) ? rawAssets : [rawAssets];
  return assets.map((asset, index) => {
    if (typeof asset === "string") {
      return { id: `asset-${index}`, url: normalizeUrl(asset), type: index === 0 ? "main" : "detail", sortOrder: index + 1 };
    }
    return {
      id: asset.id || `asset-${index}`,
      url: normalizeUrl(asset.url || asset.image_url || asset.path || ""),
      type: asset.asset_type || asset.type || (index === 0 ? "main" : "detail"),
      sortOrder: Number(asset.sort_order || index + 1)
    };
  }).filter((asset) => asset.url);
}

function normalizeShops(shops) {
  return (Array.isArray(shops) ? shops : []).filter((shop) => shop.status !== "deleted").map((shop) => ({
    id: shop.id,
    name: shop.shop_name || shop.name || `店铺 ${shop.id}`,
    platform: shop.platform || "ozon",
    logoUrl: normalizeUrl(shop.logo_url || shop.logo || ""),
    watermarkTemplateId: shop.watermark_template_id || shop.watermarkTemplateId || "",
    watermarkPath: normalizeUrl(shop.watermark_path || ""),
    status: shop.status || "active"
  }));
}

function normalizeWatermarks(templates) {
  const normalized = (Array.isArray(templates) ? templates : []).map((item) => ({
    id: item.id,
    name: item.name || item.template_name || `水印 ${item.id}`,
    logoUrl: normalizeUrl(item.logo_url || item.watermark_url || item.watermark_path || ""),
    position: normalizePosition(item.position || "bottom-right"),
    opacity: Number(item.opacity ?? 0.82),
    sizePercent: Number(item.size_percent || item.sizePercent || item.scale_percent || 22),
    margin: Number(item.margin_px || item.margin || 24),
    status: item.status || "active"
  }));

  const fromShop = state.shops
    .filter((shop) => shop.watermarkPath && !normalized.some((item) => item.logoUrl === shop.watermarkPath))
    .map((shop) => ({
      id: `shop-${shop.id}`,
      name: `${shop.name} 默认水印`,
      logoUrl: shop.watermarkPath,
      position: "bottom-right",
      opacity: 0.82,
      sizePercent: 22,
      margin: 24,
      status: "active"
    }));

  return [...normalized, ...fromShop];
}

function normalizePosition(position) {
  const map = {
    "left-top": "top-left",
    "right-top": "top-right",
    "left-bottom": "bottom-left",
    "right-bottom": "bottom-right",
    "bottom_center": "bottom-center",
    "bottom-centre": "bottom-center"
  };
  return map[position] || position || "bottom-right";
}

function normalizeUrl(url) {
  if (!url) return "";
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (url.startsWith("/")) return url;
  return `/${url.replace(/^public[\\/]/, "").replace(/\\/g, "/")}`;
}

function rebuildShopRows() {
  const product = selectedProduct.value;
  state.generatedVersions = [];
  selectedShopIds.value = [];
  state.shopRows = state.shops.map((shop) => {
    const watermark = defaultWatermarkForShop(shop);
    return {
      shopId: shop.id,
      shopName: shop.name,
      platform: shop.platform,
      status: shop.status,
      title: product ? buildDefaultTitle(product, shop) : "",
      price: product?.defaultSalePrice || 0,
      stock: product?.stock || 0,
      imagePlan: "use_master_main",
      mainImageUrl: productMainImage(product),
      watermarkTemplateId: watermark?.id || "",
      description: product?.description || "",
      offerId: product ? buildOfferId(product, shop) : "",
      generatedImageUrl: "",
      previewUrl: "",
      previewStatus: "pending",
      previewError: ""
    };
  });
}

function defaultWatermarkForShop(shop) {
  if (shop.watermarkTemplateId) {
    const template = state.watermarkTemplates.find((item) => String(item.id) === String(shop.watermarkTemplateId));
    if (template) return template;
  }
  if (shop.watermarkPath) {
    return state.watermarkTemplates.find((item) => item.logoUrl === shop.watermarkPath) || null;
  }
  return state.watermarkTemplates[0] || null;
}

function productMainImage(product = selectedProduct.value) {
  if (!product) return placeholderImage();
  const main = product.assets.find((asset) => asset.type === "main") || product.assets[0];
  return main?.url || placeholderImage(product.name);
}

function productDetailImages(product = selectedProduct.value) {
  if (!product) return [];
  return product.assets.filter((asset) => asset.type !== "main").slice(0, 6);
}

function buildDefaultTitle(product, shop) {
  return `${product.name}${product.brand ? ` ${product.brand}` : ""}${product.vehicleModels ? ` 适用于${product.vehicleModels}` : ""}`.slice(0, 480);
}

function buildOfferId(product, shop) {
  const productPart = String(product.product_code || product.id || "P").replace(/[^a-z0-9_-]/gi, "").slice(0, 24);
  const shopPart = String(shop.name || shop.id).replace(/[^a-z0-9]/gi, "").slice(0, 12).toUpperCase();
  return `${shopPart}-${productPart}-${Date.now().toString(36).toUpperCase()}`.slice(0, 64);
}

function placeholderImage(label = "Product") {
  const text = encodeURIComponent(String(label || "Product").slice(0, 18));
  return `data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='900' height='900' viewBox='0 0 900 900'%3E%3Crect width='900' height='900' fill='%23f5f7fa'/%3E%3Crect x='90' y='90' width='720' height='720' rx='24' fill='%23ffffff' stroke='%23dcdfe6'/%3E%3Ctext x='450' y='450' font-family='Arial' font-size='46' text-anchor='middle' dominant-baseline='middle' fill='%23606770'%3E${text}%3C/text%3E%3C/svg%3E`;
}

function demoProducts() {
  return [
    {
      id: 1,
      name: "汽车钥匙保护壳",
      category: "汽车配件",
      vehicle_models: "Toyota / Honda / Mazda",
      brand: "OEM",
      material: "TPU",
      cost_price: 18,
      default_sale_price: 690,
      stock_quantity: 120,
      description: "耐磨防摔，贴合原车钥匙，适合多车型销售。",
      assets: [placeholderImage("汽车钥匙壳")]
    }
  ];
}

function demoShops() {
  return [
    { id: 1, name: "Ozon 一号店", platform: "ozon", status: "active" },
    { id: 2, name: "Ozon 二号店", platform: "ozon", status: "active" },
    { id: 3, name: "Ozon 测试店", platform: "ozon", status: "paused" }
  ];
}

function demoWatermarks(shops = []) {
  const existing = (Array.isArray(shops) ? shops : []).filter((shop) => shop.watermark_path).map((shop) => ({
    id: `shop-${shop.id}`,
    name: `${shop.name || shop.shop_name} 默认水印`,
    watermark_path: shop.watermark_path,
    position: "bottom-right"
  }));
  if (existing.length) return existing;
  return [
    {
      id: "demo-watermark",
      name: "默认水印",
      logo_url: `data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='360' height='120' viewBox='0 0 360 120'%3E%3Crect width='360' height='120' rx='18' fill='%231f6feb'/%3E%3Ctext x='180' y='68' font-family='Arial' font-size='42' font-weight='700' text-anchor='middle' fill='white'%3EOZON%3C/text%3E%3C/svg%3E`,
      position: "bottom-right",
      opacity: 0.82,
      size_percent: 22,
      margin_px: 24
    }
  ];
}

function onProductChange() {
  rebuildShopRows();
}

function onSelectionChange(rows) {
  selectedShopIds.value = rows.map((row) => row.shopId);
}

function toggleAllActiveShops() {
  const activeRows = state.shopRows.filter((row) => row.status === "active");
  tableRef.value?.clearSelection();
  activeRows.forEach((row) => tableRef.value?.toggleRowSelection(row, true));
}

function clearShopSelection() {
  tableRef.value?.clearSelection();
  selectedShopIds.value = [];
}

function watermarkById(id) {
  return state.watermarkTemplates.find((item) => String(item.id) === String(id)) || null;
}

function validateRow(row) {
  const errors = [];
  const warnings = [];
  if (!row.title) errors.push("标题为空");
  if (!Number(row.price)) errors.push("价格为空");
  if (!Number.isFinite(Number(row.stock))) errors.push("库存无效");
  if (!row.mainImageUrl) errors.push("主图为空");
  if (!row.watermarkTemplateId) warnings.push("未绑定水印");
  if (row.status !== "active") warnings.push("店铺未启用");
  return { errors, warnings };
}

function rowStatus(row) {
  if (generatedVersionMap.value.has(Number(row.shopId)) || row.versionStatus === "generated") {
    return { type: "success", text: "已生成" };
  }
  const result = validateRow(row);
  if (result.errors.length) return { type: "danger", text: "阻塞" };
  if (result.warnings.length) return { type: "warning", text: "可优化" };
  return { type: "success", text: "可生成" };
}

function rowPreviewImage(row) {
  return row.previewUrl || generatedVersionMap.value.get(Number(row.shopId))?.mainImageUrl || row.generatedImageUrl || "";
}

function openImagePreview(row) {
  if (!rowPreviewImage(row)) return;
  imagePreviewRow.value = row;
  imagePreviewVisible.value = true;
}

async function generateRowPreview(row) {
  if (!selectedProduct.value?.id) {
    ElMessage.warning("请先选择母商品");
    return;
  }
  row.previewStatus = "generating";
  row.previewError = "";
  try {
    const result = await apiClient.post("/api/multi-shop-publish/generate-preview-images", {
      productId: selectedProduct.value.id,
      shopIds: [row.shopId]
    });
    const preview = Array.isArray(result.previews) ? result.previews.find((item) => Number(item.shopId) === Number(row.shopId)) : null;
    if (!preview || preview.status === "failed") {
      throw new Error(preview?.error || "预览生成失败");
    }
    row.previewUrl = withImageToken(preview.previewUrl);
    row.generatedImageUrl = withImageToken(preview.previewUrl);
    row.previewStatus = "generated";
    ElMessage.success(`${row.shopName} 预览图已生成`);
  } catch (error) {
    row.previewStatus = "failed";
    row.previewError = error.message || "预览生成失败";
  }
}

function versionMissingItems(version) {
  const missing = [];
  if (!version.mainImageUrl) missing.push("主图");
  if (!version.watermarkTemplateId) missing.push("水印");
  if (!version.title) missing.push("标题");
  if (!Number(version.price)) missing.push("价格");
  return missing;
}

function applyBulkPrice() {
  if (bulkForm.price === null || bulkForm.price === "") {
    ElMessage.warning("请先填写批量价格");
    return;
  }
  selectedRows.value.forEach((row) => {
    row.price = Number(bulkForm.price || 0);
  });
}

function applyBulkStock() {
  if (bulkForm.stock === null || bulkForm.stock === "") {
    ElMessage.warning("请先填写批量库存");
    return;
  }
  selectedRows.value.forEach((row) => {
    row.stock = Number(bulkForm.stock || 0);
  });
}

function applyBulkTitle() {
  selectedRows.value.forEach((row) => {
    row.title = `${bulkForm.titlePrefix || ""}${row.title}${bulkForm.titleSuffix || ""}`.slice(0, 480);
  });
}

async function generateVersions() {
  if (!canGenerate.value) {
    ElMessage.warning("请先选择母商品和需要发布的店铺");
    return;
  }
  const blocked = selectedRows.value.filter((row) => validateRow(row).errors.length);
  if (blocked.length) {
    ElMessage.error(`有 ${blocked.length} 个店铺配置未通过校验，请先处理`);
    return;
  }

  generating.value = true;
  try {
    const payload = {
      masterProductId: selectedProduct.value.id,
      shops: selectedRows.value.map((row) => ({
        shopId: row.shopId,
        title: row.title,
        price: Number(row.price || 0),
        stock: Number(row.stock || 0),
        offerId: row.offerId,
        imagePlan: row.imagePlan,
        mainImageUrl: row.mainImageUrl,
        watermarkTemplateId: row.watermarkTemplateId,
        description: row.description
      }))
    };
    const result = await apiClient.post("/api/multi-shop-publish/generate-versions", payload)
      .catch((error) => {
        if (error?.status && error.status !== 404) throw error;
        return generateVersionsLocally(payload);
      });
    state.generatedVersions = normalizeGeneratedVersions(result.versions || result.items || result);
    state.shopRows.forEach((row) => {
      const version = state.generatedVersions.find((item) => Number(item.shopId) === Number(row.shopId));
      if (version) {
        row.versionStatus = "generated";
        row.generatedVersionId = version.id;
        row.generatedImageUrl = version.mainImageUrl;
      }
    });
    state.taskDraft = null;
    ElMessage.success(`已生成 ${state.generatedVersions.length} 个店铺版本`);
  } finally {
    generating.value = false;
  }
}

async function exportListingPackage() {
  if (!state.generatedVersions.length) {
    ElMessage.warning("请先生成店铺版本");
    return;
  }
  exportingPackage.value = true;
  try {
    const result = await apiClient.post("/api/multi-shop-publish/export-package", {
      masterProductId: selectedProduct.value?.id,
      versions: state.generatedVersions
    });
    ElMessage.success(`上架包已生成：${result.packageDir || result.packageId}`);
  } finally {
    exportingPackage.value = false;
  }
}

function generateVersionsLocally(payload) {
  return {
    versions: payload.shops.map((item) => {
      const row = state.shopRows.find((shopRow) => Number(shopRow.shopId) === Number(item.shopId));
      const watermark = watermarkById(item.watermarkTemplateId);
      return {
        id: `local-${item.shopId}`,
        shopId: item.shopId,
        shopName: row?.shopName || `店铺 ${item.shopId}`,
        platform: row?.platform || "ozon",
        offerId: item.offerId,
        title: item.title,
        price: item.price,
        stock: item.stock,
        description: item.description,
        mainImageUrl: item.mainImageUrl,
        watermarkTemplateId: item.watermarkTemplateId,
        watermark,
        images: [
          {
            type: "main",
            sourceUrl: item.mainImageUrl,
            generatedUrl: item.mainImageUrl,
            watermarkTemplateId: item.watermarkTemplateId
          },
          ...productDetailImages().map((asset) => ({
            type: asset.type,
            sourceUrl: asset.url,
            generatedUrl: asset.url,
            watermarkTemplateId: item.watermarkTemplateId
          }))
        ],
        validation: validateRow(row)
      };
    })
  };
}

function normalizeGeneratedVersions(raw) {
  const versions = Array.isArray(raw) ? raw : [];
  return versions.map((item) => {
    const row = state.shopRows.find((shopRow) => Number(shopRow.shopId) === Number(item.shop_id || item.shopId));
    const watermark = watermarkById(item.watermark_template_id || item.watermarkTemplateId || row?.watermarkTemplateId);
    return {
      id: item.id || item.version_id || `version-${item.shop_id || item.shopId}`,
      shopId: item.shop_id || item.shopId || row?.shopId,
      shopName: item.shop_name || item.shopName || row?.shopName || "",
      platform: item.platform || row?.platform || "ozon",
      offerId: item.offer_id || item.offerId || row?.offerId || "",
      title: item.title || row?.title || "",
      price: Number(item.price || row?.price || 0),
      stock: Number(item.stock_quantity || item.stock || row?.stock || 0),
      description: item.description || row?.description || "",
      mainImageUrl: normalizeUrl(item.main_image_url || item.mainImageUrl || row?.mainImageUrl || ""),
      watermarkTemplateId: item.watermark_template_id || item.watermarkTemplateId || row?.watermarkTemplateId || "",
      watermark,
      images: Array.isArray(item.images) ? item.images : [
        { type: "main", sourceUrl: row?.mainImageUrl || "", generatedUrl: item.generated_image_url || row?.mainImageUrl || "" }
      ],
      validation: item.validation || validateRow(row || {})
    };
  });
}

function openPreview() {
  if (!state.generatedVersions.length) {
    ElMessage.warning("请先生成店铺版本");
    return;
  }
  previewDrawerVisible.value = true;
}

async function createPublishTask() {
  if (!state.generatedVersions.length) {
    ElMessage.warning("请先生成店铺版本");
    return;
  }
  await ElMessageBox.confirm("确认创建发布任务？任务创建后将按店铺逐条发布，可在发布任务管理中重试失败项。", "创建发布任务", {
    type: "warning",
    confirmButtonText: "确认创建",
    cancelButtonText: "取消"
  });

  creatingTask.value = true;
  try {
    const payload = {
      masterProductId: selectedProduct.value.id,
      versions: state.generatedVersions.map((version) => ({
        versionId: version.id,
        shopId: version.shopId,
        offerId: version.offerId,
        payload: version
      }))
    };
    const result = await apiClient.post("/api/multi-shop-publish/tasks", payload)
      .catch((error) => {
        if (error?.status && error.status !== 404) throw error;
        return {
          id: `local-task-${Date.now()}`,
          taskNo: `LOCAL-${Date.now()}`,
          status: "pending",
          totalCount: state.generatedVersions.length
        };
      });
    state.taskDraft = result;
    ElMessage.success(`发布任务已创建：${result.taskNo || result.task_no || result.id}`);
  } finally {
    creatingTask.value = false;
  }
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function imagePlanText(plan) {
  const map = {
    use_master_main: "母商品主图",
    first_raw: "第一张原图",
    shop_specific: "店铺专属图",
    manual: "手动选择"
  };
  return map[plan] || plan;
}

function statusType(status) {
  if (status === "active" || status === "success") return "success";
  if (status === "paused" || status === "pending") return "warning";
  if (status === "disabled" || status === "failed") return "danger";
  return "info";
}

onMounted(loadBootstrap);
</script>

<template>
  <div class="multi-shop-page" v-loading="loading">
    <header class="page-header">
      <div>
        <h1>多店铺商品发布中台</h1>
        <p>从一个母商品生成多个店铺版本，统一处理标题、价格、库存、主图和水印。</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="loadBootstrap">刷新</el-button>
        <el-button type="primary" :icon="Tickets" :disabled="!state.generatedVersions.length" @click="openPreview">发布预览</el-button>
      </div>
    </header>

    <section class="toolbar-section">
      <div class="product-picker">
        <el-select
          v-model="selectedProductId"
          filterable
          placeholder="选择母商品"
          class="product-select"
          @change="onProductChange"
        >
          <el-option
            v-for="product in state.products"
            :key="product.id"
            :label="`${product.name} / ${product.category || '未分类'}`"
            :value="product.id"
          />
        </el-select>
        <el-button :icon="Search">检索商品</el-button>
      </div>
      <div class="summary-strip">
        <div><strong>{{ summary.activeShops }}</strong><span>可用店铺</span></div>
        <div><strong>{{ summary.selected }}</strong><span>已选店铺</span></div>
        <div><strong>{{ summary.generated }}</strong><span>已生成版本</span></div>
        <div><strong>{{ summary.blocked }}</strong><span>阻塞项</span></div>
      </div>
    </section>

    <section v-if="selectedProduct" class="product-section">
      <div class="product-media">
        <img :src="productMainImage()" :alt="selectedProduct.name">
      </div>
      <div class="product-facts">
        <div class="section-title">
          <h2>{{ selectedProduct.name }}</h2>
          <el-tag :type="statusType(selectedProduct.status)" effect="plain">{{ selectedProduct.status }}</el-tag>
        </div>
        <el-descriptions :column="4" border>
          <el-descriptions-item label="分类">{{ selectedProduct.category || "-" }}</el-descriptions-item>
          <el-descriptions-item label="适配车型">{{ selectedProduct.vehicleModels || "-" }}</el-descriptions-item>
          <el-descriptions-item label="品牌">{{ selectedProduct.brand || "-" }}</el-descriptions-item>
          <el-descriptions-item label="材质">{{ selectedProduct.material || "-" }}</el-descriptions-item>
          <el-descriptions-item label="成本价">{{ formatMoney(selectedProduct.costPrice) }}</el-descriptions-item>
          <el-descriptions-item label="默认售价">{{ formatMoney(selectedProduct.defaultSalePrice) }}</el-descriptions-item>
          <el-descriptions-item label="库存">{{ selectedProduct.stock }}</el-descriptions-item>
          <el-descriptions-item label="素材数">{{ selectedProduct.assets.length }}</el-descriptions-item>
        </el-descriptions>
        <p class="product-description">{{ selectedProduct.description || "暂无产品描述" }}</p>
      </div>
    </section>

    <section class="batch-section">
      <div class="section-title">
        <div>
          <h2>店铺版本配置</h2>
          <p>勾选店铺后可批量设置价格、库存，也可以逐店铺微调标题、主图方案和水印模板。</p>
        </div>
        <div class="section-actions">
          <el-button @click="toggleAllActiveShops">选择启用店铺</el-button>
          <el-button @click="clearShopSelection">清空选择</el-button>
        </div>
      </div>

      <div class="bulk-bar">
        <el-input-number v-model="bulkForm.price" :min="0" :controls="false" placeholder="批量价格" />
        <el-button @click="applyBulkPrice">应用价格</el-button>
        <el-input-number v-model="bulkForm.stock" :min="0" :controls="false" placeholder="批量库存" />
        <el-button @click="applyBulkStock">应用库存</el-button>
        <el-input v-model="bulkForm.titlePrefix" placeholder="标题前缀" />
        <el-input v-model="bulkForm.titleSuffix" placeholder="标题后缀" />
        <el-button @click="applyBulkTitle">应用标题</el-button>
      </div>

      <el-table
        ref="tableRef"
        :data="state.shopRows"
        border
        row-key="shopId"
        class="shop-table"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column label="店铺" min-width="170" fixed>
          <template #default="{ row }">
            <div class="shop-cell">
              <strong>{{ row.shopName }}</strong>
              <span>{{ row.platform }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" effect="plain">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="主图预览" width="150">
          <template #default="{ row }">
            <div class="table-preview-cell">
              <button
                type="button"
                class="table-preview-button"
                :class="{ 'is-empty': !rowPreviewImage(row), 'is-failed': row.previewStatus === 'failed' }"
                @click="openImagePreview(row)"
              >
                <WatermarkPreview
                  v-if="rowPreviewImage(row)"
                  :image-url="rowPreviewImage(row)"
                  :watermark-url="''"
                  :height="96"
                  fit="cover"
                />
                <div v-else class="preview-placeholder">
                  <span v-if="row.previewStatus === 'generating'">生成中</span>
                  <span v-else>未生成</span>
                </div>
              </button>
              <el-button
                size="small"
                :loading="row.previewStatus === 'generating'"
                @click="generateRowPreview(row)"
              >
                生成预览
              </el-button>
              <el-tag v-if="row.previewStatus === 'failed'" type="danger" effect="plain">{{ row.previewError || "失败" }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="320">
          <template #default="{ row }">
            <el-input v-model="row.title" maxlength="480" show-word-limit />
          </template>
        </el-table-column>
        <el-table-column label="价格" width="140">
          <template #default="{ row }">
            <el-input-number v-model="row.price" :min="0" :controls="false" />
          </template>
        </el-table-column>
        <el-table-column label="库存" width="120">
          <template #default="{ row }">
            <el-input-number v-model="row.stock" :min="0" :controls="false" />
          </template>
        </el-table-column>
        <el-table-column label="主图方案" width="160">
          <template #default="{ row }">
            <el-select v-model="row.imagePlan">
              <el-option label="母商品主图" value="use_master_main" />
              <el-option label="第一张原图" value="first_raw" />
              <el-option label="店铺专属图" value="shop_specific" />
              <el-option label="手动选择" value="manual" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="水印模板" min-width="190">
          <template #default="{ row }">
            <el-select v-model="row.watermarkTemplateId" clearable filterable>
              <el-option
                v-for="template in state.watermarkTemplates"
                :key="template.id"
                :label="template.name"
                :value="template.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="Offer ID" min-width="190">
          <template #default="{ row }">
            <el-input v-model="row.offerId" />
          </template>
        </el-table-column>
        <el-table-column label="校验" width="100" fixed="right">
          <template #default="{ row }">
            <el-tag :type="rowStatus(row).type" effect="plain">{{ rowStatus(row).text }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="actions-section">
      <div>
        <strong>下一步</strong>
        <span>生成店铺版本后，系统会按每个店铺的水印模板生成最终图片并创建发布预览。</span>
      </div>
      <div class="footer-actions">
        <el-button :icon="View" :disabled="!state.generatedVersions.length" @click="openPreview">查看预览</el-button>
        <el-button type="primary" :icon="CircleCheck" :loading="generating" :disabled="!canGenerate" @click="generateVersions">
          生成店铺版本
        </el-button>
        <el-button type="warning" :loading="exportingPackage" :disabled="!state.generatedVersions.length" @click="exportListingPackage">
          导出上架包
        </el-button>
        <el-button type="success" :loading="creatingTask" :disabled="!state.generatedVersions.length" @click="createPublishTask">
          创建发布任务
        </el-button>
      </div>
    </section>

    <section v-if="state.generatedVersions.length" class="preview-section">
      <div class="section-title">
        <div>
          <h2>发布预览</h2>
          <p>以下为每个店铺的最终主图预览，确认无误后创建发布任务。</p>
        </div>
      </div>
      <div class="version-grid">
        <article v-for="version in state.generatedVersions" :key="version.id" class="version-card">
          <WatermarkPreview
            :image-url="version.mainImageUrl"
            :watermark-url="version.watermark?.logoUrl || ''"
            :position="version.watermark?.position || 'bottom-right'"
            :opacity="version.watermark?.opacity || 0.82"
            :size-percent="version.watermark?.sizePercent || 22"
            :margin="version.watermark?.margin || 24"
            :x-percent="version.watermark?.xPercent || version.watermark?.x_percent || 75"
            :y-percent="version.watermark?.yPercent || version.watermark?.y_percent || 75"
            :height="210"
          />
          <div class="version-meta">
            <div>
              <strong>{{ version.shopName }}</strong>
              <span>{{ imagePlanText(state.shopRows.find((row) => Number(row.shopId) === Number(version.shopId))?.imagePlan) }}</span>
            </div>
            <el-tag type="success" effect="plain">{{ formatMoney(version.price) }}</el-tag>
          </div>
          <p>{{ version.title }}</p>
        </article>
      </div>
    </section>

    <el-drawer v-model="previewDrawerVisible" title="发布 Payload 预览" size="720px">
      <div class="drawer-body">
        <el-alert
          type="info"
          :closable="false"
          title="这里展示的是中台生成的店铺版本数据，后续 OzonPayloadMapper 会将其转换为 Ozon product/import 请求体。"
        />
        <el-table :data="state.generatedVersions" border>
          <el-table-column label="店铺" min-width="140" prop="shopName" />
          <el-table-column label="Offer ID" min-width="160" prop="offerId" />
          <el-table-column label="缺失项" min-width="140">
            <template #default="{ row }">
              <div v-if="versionMissingItems(row).length" class="missing-tags">
                <el-tag v-for="item in versionMissingItems(row)" :key="item" type="danger" effect="plain">{{ item }}</el-tag>
              </div>
              <el-tag v-else type="success" effect="plain">完整</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="价格" width="110">
            <template #default="{ row }">{{ formatMoney(row.price) }}</template>
          </el-table-column>
          <el-table-column label="库存" width="90" prop="stock" />
        </el-table>
        <div class="drawer-preview-list">
          <article v-for="version in state.generatedVersions" :key="`drawer-${version.id}`" class="drawer-version">
            <WatermarkPreview
              :image-url="version.mainImageUrl"
              :watermark-url="version.watermark?.logoUrl || ''"
              :position="version.watermark?.position || 'bottom-right'"
              :opacity="version.watermark?.opacity || 0.82"
              :size-percent="version.watermark?.sizePercent || 22"
              :margin="version.watermark?.margin || 24"
              :x-percent="version.watermark?.xPercent || version.watermark?.x_percent || 75"
              :y-percent="version.watermark?.yPercent || version.watermark?.y_percent || 75"
              :height="260"
            />
            <div class="drawer-version-info">
              <h3>{{ version.shopName }}</h3>
              <p>{{ version.title || "缺失标题" }}</p>
              <el-descriptions :column="2" border>
                <el-descriptions-item label="价格">{{ Number(version.price) ? formatMoney(version.price) : "缺失价格" }}</el-descriptions-item>
                <el-descriptions-item label="库存">{{ version.stock }}</el-descriptions-item>
                <el-descriptions-item label="水印">{{ version.watermark?.name || "缺失水印" }}</el-descriptions-item>
                <el-descriptions-item label="详情图">{{ Math.max((version.images?.length || 1) - 1, 0) }} 张</el-descriptions-item>
              </el-descriptions>
              <div v-if="versionMissingItems(version).length" class="missing-tags">
                <el-tag v-for="item in versionMissingItems(version)" :key="`${version.id}-${item}`" type="danger" effect="plain">缺失{{ item }}</el-tag>
              </div>
            </div>
          </article>
        </div>
        <el-input :model-value="JSON.stringify(previewPayload, null, 2)" type="textarea" :rows="18" readonly />
      </div>
    </el-drawer>

    <el-dialog v-model="imagePreviewVisible" title="主图水印预览" width="560px">
      <WatermarkPreview
        v-if="imagePreviewRow"
        :image-url="rowPreviewImage(imagePreviewRow)"
        :watermark-url="''"
        :height="640"
      />
    </el-dialog>
  </div>
</template>

<style scoped>
.multi-shop-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header,
.toolbar-section,
.product-section,
.batch-section,
.actions-section,
.preview-section {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
  padding: 16px;
}

.page-header,
.toolbar-section,
.product-section,
.section-title,
.actions-section {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.page-header h1,
.section-title h2 {
  margin: 0;
  font-size: 20px;
}

.page-header p,
.section-title p,
.product-description,
.actions-section span {
  margin: 6px 0 0;
  color: var(--el-text-color-secondary);
}

.header-actions,
.section-actions,
.footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.product-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 420px;
}

.product-select {
  width: 360px;
}

.summary-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(90px, 1fr));
  gap: 8px;
}

.summary-strip div {
  min-height: 58px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 8px 12px;
  background: var(--el-fill-color-lighter);
}

.summary-strip strong,
.summary-strip span {
  display: block;
}

.summary-strip strong {
  font-size: 20px;
  line-height: 24px;
}

.summary-strip span {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.product-section {
  align-items: stretch;
}

.product-media {
  width: 168px;
  flex: 0 0 168px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-fill-color-light);
}

.product-media img {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
}

.product-facts {
  flex: 1;
  min-width: 0;
}

.batch-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bulk-bar {
  display: grid;
  grid-template-columns: 150px auto 150px auto minmax(120px, 1fr) minmax(120px, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 10px;
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.shop-table {
  width: 100%;
}

.table-preview-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.table-preview-button {
  display: block;
  width: 118px;
  min-height: 96px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}

.table-preview-button.is-empty {
  cursor: default;
}

.table-preview-button.is-failed {
  border: 1px solid var(--el-color-danger-light-5);
  border-radius: 8px;
}

.preview-placeholder {
  width: 118px;
  height: 96px;
  display: grid;
  place-items: center;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.shop-cell strong,
.shop-cell span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shop-cell span {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.actions-section {
  align-items: center;
}

.actions-section strong {
  display: block;
}

.version-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.version-card {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 10px;
  background: var(--el-bg-color);
}

.version-meta {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  margin-top: 10px;
}

.version-meta strong,
.version-meta span {
  display: block;
}

.version-meta span {
  margin-top: 3px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.version-card p {
  margin: 8px 0 0;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}

.drawer-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.drawer-preview-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.drawer-version {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 10px;
}

.drawer-version-info h3 {
  margin: 0 0 6px;
  font-size: 16px;
}

.drawer-version-info p {
  margin: 0 0 10px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}

.missing-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

@media (max-width: 1180px) {
  .toolbar-section,
  .product-section,
  .section-title,
  .actions-section {
    flex-direction: column;
  }

  .product-picker,
  .product-select {
    width: 100%;
    min-width: 0;
  }

  .bulk-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .drawer-version {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .page-header {
    flex-direction: column;
  }

  .summary-strip {
    width: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .product-media {
    width: 100%;
    flex-basis: auto;
  }

  .bulk-bar {
    grid-template-columns: 1fr;
  }
}
</style>
