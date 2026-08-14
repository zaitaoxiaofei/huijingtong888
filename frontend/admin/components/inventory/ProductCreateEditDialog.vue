<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { uploadListingMedia } from "../../api/tools/imageCropper";
import { currentEffectiveLogisticsRules, resolveCurrentLogisticsRule } from "../../utils/effective-logistics-rules";
import { buildShortInventoryName, scoreInventorySimilarity } from "../../utils/inventory-similarity";
import { useAuthStore } from "../../stores/auth";
import ProductImagePreview from "../ProductImagePreview.vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  mode: { type: String, default: "create" },
  target: { type: String, default: "selection" },
  people: { type: Array, default: () => [] },
  suppliers: { type: Array, default: () => [] },
  logisticsRules: { type: Array, default: () => [] },
  value: { type: Object, default: null },
  editProductId: { type: [Number, String], default: null },
  createEndpoint: { type: String, default: "/api/products" },
  createContext: { type: Object, default: () => ({}) }
});

const emit = defineEmits(["update:visible", "saved", "existing-selected", "quick-create-component", "manage-components"]);
const authStore = useAuthStore();

const formRef = ref();
const imageUploadLoading = ref(false);
const submitting = ref(false);
const manualLogisticsRule = ref(false);
const manualPackagingFee = ref(false);
const componentQuery = ref("");
const componentSelectId = ref("");
const componentRole = ref("included");
const componentLoading = ref(false);
const componentOptions = ref([]);
const componentDirectoryRows = ref([]);
const componentPage = ref(1);
const componentPageSize = 12;
const componentDirectory = reactive({
  category: "",
  brand: "",
  fitment_type: "",
  vehicle_model: "",
  accessory: "",
  color: "",
  quantity: ""
});
const namingOptions = reactive({ category: [], accessory: [], color: [], material: [], process: [], quantity: [] });
const vehicleCatalog = ref([]);
const similarProducts = ref([]);
const similarProductsLoading = ref(false);
const fallbackLogisticsRules = ref([]);
let similarProductsTimer = null;

const STOCK_UNIT_OPTIONS = ["个", "件", "套", "对", "双", "条", "米", "卷", "包", "片", "张", "盒"];

const formRules = {
  name: [{ required: true, message: "请输入商品名称", trigger: "blur" }],
  owner_person_id: [{ required: true, message: "请选择负责人", trigger: "change" }],
  purchase_quantity: [{ required: true, message: "请输入采购数量", trigger: "blur" }]
};

const form = reactive(createDefaultForm());

const isInventoryTarget = computed(() => props.target === "inventory");
const isEditMode = computed(() => props.mode === "edit");
const canMaintainNamingOptions = computed(() => String(authStore.user?.name || "").trim() === "核动力牛马");
const vehicleBrandOptions = computed(() => vehicleCatalog.value.map((brand) => ({ value: brand.name, label: brand.label || [brand.nameZh, brand.name].filter(Boolean).join(" ") })));
const vehicleModelOptions = computed(() => {
  const brand = vehicleCatalog.value.find((item) => item.name === form.structured_naming.vehicle_brand);
  return Array.isArray(brand?.models) ? brand.models : [];
});
const dialogTitle = computed(() => {
  if (isEditMode.value) return isInventoryTarget.value ? "编辑库存商品" : "编辑选品";
  return isInventoryTarget.value ? "新增库存商品" : "新增选品";
});

const availableLogisticsRules = computed(() => props.logisticsRules?.length ? props.logisticsRules : fallbackLogisticsRules.value);
const logisticsRuleOptions = computed(() => currentEffectiveLogisticsRules(availableLogisticsRules.value).sort((a, b) => {
  const heat = Number(b.usage_count || 0) - Number(a.usage_count || 0);
  if (heat) return heat;
  const celA = String(a.carrier || "").toUpperCase() === "CEL" ? 1 : 0;
  const celB = String(b.carrier || "").toUpperCase() === "CEL" ? 1 : 0;
  if (celA !== celB) return celB - celA;
  const airA = isAirLandLogisticsRule(a) ? 1 : 0;
  const airB = isAirLandLogisticsRule(b) ? 1 : 0;
  if (airA !== airB) return airB - airA;
  return Number(a.min_weight_g || 0) - Number(b.min_weight_g || 0) || Number(a.id || 0) - Number(b.id || 0);
}));

const selectedLogisticsRule = computed(() => resolveSelectedLogisticsRule(form));
const previewNumbers = computed(() => buildSelectionPreview(form, selectedLogisticsRule.value));
const selectionPreviewCards = computed(() => [
  { label: "当前售价", value: `¥${money(previewNumbers.value.saleRmb)}`, hint: "手动填写优先" },
  { label: "净利润率", value: percentText(previewNumbers.value.margin, 1), hint: "按当前售价计算" },
  { label: "净利润", value: `¥${money(previewNumbers.value.profit)}`, hint: "扣除全部费用后" },
  { label: "建议售价", value: `¥${money(previewNumbers.value.suggestedSaleRmb)}`, hint: previewNumbers.value.targetMode === "margin" ? "按利润率反推" : "按利润额反推" },
  { label: "目标利润率", value: percentText(previewNumbers.value.targetMargin, 1), hint: "模型目标值" },
  { label: "目标利润额", value: `¥${money(previewNumbers.value.targetProfit)}`, hint: "按当前售价换算" }
]);

function createDefaultForm() {
  return {
    id: null,
    selection_id: "",
    code: "",
    updated_at: "",
    name: "",
    image_url: "",
    purchase_url: "",
    source_platform: "1688",
    supplier_id: "",
    supplier_note: "",
    owner_person_id: "",
    shipping_method: "air_land",
    logistics_rule_id: "",
    purchase_cost: 0,
    domestic_shipping: 0,
    handling_fee: 0.3,
    purchase_quantity: 1,
    package_weight_g: 0,
    length_cm: 30,
    width_cm: 20,
    height_cm: 10,
    sale_price_rmb: 0,
    listing_price_rub: 0,
    air_sale_price_rmb: 0,
    exchange_rate: 11.32,
    advertising_rate: 0,
    desired_profit_mode: "margin",
    desired_profit_value: 20,
    return_rate: 5,
    stock_unit: "个",
    is_accessory: 0,
    composition_items: [],
    product_type: "selection",
    selection_status: "draft"
    ,structured_naming: {
      category: "",
      fitment_type: "universal",
      vehicle_brand: "",
      vehicle_model: "",
      vehicle_models: [],
      accessory: "普通款",
      colors: [],
      materials: [],
      process: "",
      quantity: 1,
      stock_unit: "个",
      package_mode: "single",
      package_contents: "",
      included_accessories: "",
      gift_contents: ""
    }
  };
}

function resetForm() {
  Object.assign(form, createDefaultForm());
  form.owner_person_id = props.people[0]?.id ? String(props.people[0].id) : "";
  form.product_type = isInventoryTarget.value ? "main" : "selection";
  form.selection_status = isInventoryTarget.value ? "listed" : "draft";
  const nextRule = resolveSelectedLogisticsRule(form);
  form.logistics_rule_id = nextRule?.id || "";
  form.shipping_method = nextRule?.channel || "air_land";
  manualLogisticsRule.value = false;
  manualPackagingFee.value = false;
  componentQuery.value = "";
  componentSelectId.value = "";
  componentRole.value = "included";
  componentOptions.value = [];
  componentDirectoryRows.value = [];
  componentPage.value = 1;
  Object.assign(componentDirectory, { category: "", brand: "", fitment_type: "", vehicle_model: "", accessory: "", color: "", quantity: "" });
  syncPackagingFee(form);
}

function fillFormFromValue(value = {}) {
  resetForm();
  Object.assign(form, {
    ...createDefaultForm(),
    ...value,
    supplier_id: value.supplier_id || "",
    owner_person_id: (value.owner_person_id || props.people[0]?.id)
      ? String(value.owner_person_id || props.people[0]?.id)
      : "",
    shipping_method: value.shipping_method || "air_land",
    logistics_rule_id: value.logistics_rule_id || "",
    purchase_cost: Number(value.purchase_cost || 0),
    domestic_shipping: Number(value.domestic_shipping || 0),
    handling_fee: Number(value.handling_fee ?? 0.3),
    purchase_quantity: Number(value.purchase_quantity || 1),
    package_weight_g: Number(value.package_weight_g || 0),
    length_cm: Number(value.length_cm || 30),
    width_cm: Number(value.width_cm || 20),
    height_cm: Number(value.height_cm || 10),
    sale_price_rmb: Number(value.sale_price_rmb || value.air_sale_price_rmb || 0),
    listing_price_rub: Number(value.listing_price_rub || 0),
    air_sale_price_rmb: Number(value.air_sale_price_rmb || 0),
    exchange_rate: Number(value.exchange_rate || 11.32),
    advertising_rate: Number(value.advertising_rate || 0),
    desired_profit_mode: value.desired_profit_mode || "margin",
    desired_profit_value: Number(value.desired_profit_value || 20),
    return_rate: roundMoney(resolvedReturnRate(value) * 100),
    stock_unit: value.stock_unit || "个",
    is_accessory: Number(value.is_accessory || 0) ? 1 : 0,
    composition_items: Array.isArray(value.composition_items) ? value.composition_items.map(normalizeComponentItem) : [],
    product_type: value.product_type || (isInventoryTarget.value ? "main" : "selection"),
    selection_status: value.selection_status || (isInventoryTarget.value ? "listed" : "draft")
  });
  const savedNaming = value.structured_naming || {};
  Object.assign(form.structured_naming, {
    ...createDefaultForm().structured_naming,
    ...savedNaming,
    category: savedNaming.category || value.inventory_category || "",
    vehicle_brand: savedNaming.vehicle_brand || value.vehicle_brand?.replace(/^无品牌$/u, "") || "",
    fitment_type: savedNaming.fitment_type || value.fitment_type || (value.vehicle_model ? "specific" : "universal"),
    vehicle_model: savedNaming.vehicle_model || value.vehicle_model || "",
    vehicle_models: Array.isArray(savedNaming.vehicle_models) ? savedNaming.vehicle_models : String(savedNaming.vehicle_model || value.vehicle_model || "").split("/").filter(Boolean),
    accessory: savedNaming.accessory || value.accessory_name || "普通款",
    colors: Array.isArray(savedNaming.colors) ? savedNaming.colors : String(value.color || "").split(",").filter(Boolean),
    materials: Array.isArray(savedNaming.materials)
      ? savedNaming.materials
      : String(savedNaming.material || value.material || "").split(/[，,/]+/u).map((item) => item.trim()).filter(Boolean),
    process: savedNaming.process || value.surface_process || "",
    quantity: Number(savedNaming.quantity || value.product_quantity || 1),
    stock_unit: savedNaming.stock_unit || value.stock_unit || "个",
    package_mode: savedNaming.package_mode || value.package_mode || "single",
    package_contents: savedNaming.package_contents || value.package_contents || "",
    included_accessories: savedNaming.included_accessories || value.included_accessories || "",
    gift_contents: savedNaming.gift_contents || value.gift_contents || ""
  });
  manualLogisticsRule.value = Boolean(value.logistics_rule_id);
  if (manualLogisticsRule.value) {
    const currentRule = resolveCurrentLogisticsRule(availableLogisticsRules.value, value.logistics_rule_id);
    form.logistics_rule_id = currentRule?.id || form.logistics_rule_id;
    form.shipping_method = currentRule?.channel || form.shipping_method;
  }
  manualPackagingFee.value = true;
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      if (props.value) fillFormFromValue(props.value);
      else resetForm();
      return;
    }
    formRef.value?.clearValidate?.();
  }
);

watch(() => props.visible, async (visible) => {
  if (visible) {
    await Promise.all([loadNamingOptions(), loadVehicleCatalog(), loadFallbackLogisticsRules()]);
    await hydrateLegacyStructuredNaming();
  }
}, { immediate: true });

async function loadFallbackLogisticsRules() {
  if (props.logisticsRules?.length || fallbackLogisticsRules.value.length) return;
  try {
    const rows = await apiClient.get("/api/logistics-rules", { noCache: true });
    fallbackLogisticsRules.value = Array.isArray(rows) ? rows.filter((item) => Number(item.enabled) !== 0) : [];
  } catch {
    fallbackLogisticsRules.value = [];
  }
}

const generatedProductName = computed(() => {
  const item = form.structured_naming;
  if ((!String(item.category || "").trim() || !String(item.accessory || "").trim()) && String(form.name || "").trim()) {
    return String(form.name || "").trim();
  }
  return buildShortInventoryName({
    ...item,
    coreName: item.category,
    feature: item.accessory,
    fitmentType: item.fitment_type,
    vehicleBrand: item.vehicle_brand,
    vehicleModels: item.vehicle_models,
    materials: item.materials,
    process: item.process,
    stockUnit: item.stock_unit,
    packageMode: item.package_mode,
    packageContents: item.package_contents,
    includedAccessories: item.included_accessories,
    giftContents: item.gift_contents
  });
});

function componentNamingText(role) {
  return form.composition_items
    .filter((item) => (item.component_role || "included") === role)
    .map((item) => {
      const name = componentLabel(item);
      const quantity = Number(item.quantity || 1);
      return quantity > 1 ? `${name}×${quantity}` : name;
    })
    .filter(Boolean)
    .join(" + ");
}

watch(
  () => form.composition_items.map((item) => [
    item.component_product_id,
    item.component_name,
    item.quantity,
    item.component_role
  ]),
  () => {
    form.structured_naming.included_accessories = componentNamingText("included");
    form.structured_naming.gift_contents = componentNamingText("gift");
    const hasComponents = form.composition_items.some((item) => Number(item.component_product_id || 0) > 0);
    form.structured_naming.package_mode = hasComponents ? "set" : "single";
    form.structured_naming.package_contents = hasComponents
      ? [form.structured_naming.included_accessories, form.structured_naming.gift_contents].filter(Boolean).join(" + ")
      : "";
  },
  { deep: true }
);

const similarProductQuery = computed(() => {
  const item = form.structured_naming;
  return [item.category, item.vehicle_brand, ...(item.vehicle_models || []), item.accessory, ...(item.materials || []), item.process, ...(item.colors || [])]
    .map((value) => String(value || "").trim())
    .filter((value) => value && value !== "无品牌")
    .join(" ");
});

function similarityResult(row = {}) {
  const item = form.structured_naming;
  return scoreInventorySimilarity(row, {
    coreName: item.category,
    brand: item.vehicle_brand,
    vehicleModel: (item.vehicle_models || []).join("/"),
    colors: item.colors,
    feature: item.accessory,
    quantity: item.quantity,
    packageMode: item.package_mode,
    includedAccessories: item.included_accessories,
    giftContents: item.gift_contents
  });
}

async function loadSimilarProducts() {
  if (!props.visible) return;
  const query = similarProductQuery.value;
  if (!query || !String(form.structured_naming.category || "").trim()) {
    similarProducts.value = [];
    return;
  }
  similarProductsLoading.value = true;
  try {
    const exactParams = new URLSearchParams({ paged: "1", page: "1", pageSize: "20", query });
    const broadParams = new URLSearchParams({ paged: "1", page: "1", pageSize: "30", query, matchMode: "any" });
    const coreParams = new URLSearchParams({ paged: "1", page: "1", pageSize: "30", query: form.structured_naming.category });
    const [coreResult, exactResult, broadResult] = await Promise.all([
      apiClient.get(`/api/products?${coreParams.toString()}`, { noCache: true }),
      apiClient.get(`/api/products?${exactParams.toString()}`, { noCache: true }),
      apiClient.get(`/api/products?${broadParams.toString()}`, { noCache: true })
    ]);
    const candidates = [...(coreResult?.rows || []), ...(exactResult?.rows || []), ...(broadResult?.rows || [])]
      .filter((row) => Number(row.id) !== Number(form.id || 0))
      .filter((row) => Number(row.active ?? 1) !== 0 && String(row.selection_status || "") !== "merged")
      .filter((row) => Number(row.parent_product_id || 0) === 0)
      .filter((row, index, rows) => rows.findIndex((item) => Number(item.id) === Number(row.id)) === index);
    similarProducts.value = candidates
      .map((row) => ({ ...row, similarity: similarityResult(row) }))
      .filter((row) => row.similarity && row.similarity.score >= 45)
      .sort((left, right) => right.similarity.score - left.similarity.score)
      .slice(0, 5);
  } catch {
    similarProducts.value = [];
  } finally {
    similarProductsLoading.value = false;
  }
}

function scheduleSimilarProducts() {
  if (similarProductsTimer) window.clearTimeout(similarProductsTimer);
  similarProductsTimer = window.setTimeout(loadSimilarProducts, 320);
}

function selectExistingProduct(row) {
  emit("existing-selected", row);
  emit("update:visible", false);
}

watch(similarProductQuery, scheduleSimilarProducts);

onBeforeUnmount(() => {
  if (similarProductsTimer) window.clearTimeout(similarProductsTimer);
});

async function loadNamingOptions() {
  try {
    await Promise.all(Object.keys(namingOptions).map((type) => loadNamingOption(type)));
  } catch (error) {
    ElMessage.error(error.message || "加载标准选项失败");
  }
}

function longestMatchingOption(rows, name) {
  const normalizedName = String(name || "").toLowerCase();
  return [...(rows || [])]
    .filter((row) => {
      const value = String(row.value || "").trim().toLowerCase();
      const label = String(row.label || "").trim().toLowerCase();
      return (value && normalizedName.includes(value)) || (label && normalizedName.includes(label));
    })
    .sort((left, right) => Math.max(String(right.value || "").length, String(right.label || "").length)
      - Math.max(String(left.value || "").length, String(left.label || "").length))[0];
}

function matchingOptionValues(rows, name) {
  const normalizedName = String(name || "").toLowerCase();
  return [...new Set((rows || [])
    .map((row) => String(row.value || row.label || "").trim())
    .filter((value) => value && normalizedName.includes(value.toLowerCase())))]
    .filter((value, index, values) => !values.some((other, otherIndex) => otherIndex !== index && other.includes(value)));
}

function namingValueAppearsInName(value, name) {
  const normalizedName = String(name || "").replace(/\s+/g, "").toLowerCase();
  return String(value || "")
    .split(/[，,/]+/u)
    .map((item) => item.replace(/\s+/g, "").toLowerCase())
    .filter(Boolean)
    .every((item) => normalizedName.includes(item));
}

async function hydrateLegacyStructuredNaming() {
  if (!isEditMode.value && !props.value) return;
  const item = form.structured_naming;
  const originalName = String(form.name || "").trim();
  if (!originalName) return;

  if (!item.category) {
    const matchedCategory = longestMatchingOption(namingOptions.category, originalName);
    item.category = matchedCategory?.value || "";
  }
  if (!item.vehicle_brand) {
    const matchedBrand = vehicleCatalog.value.find((brand) => originalName.toLowerCase().includes(String(brand.name || "").toLowerCase()));
    item.vehicle_brand = matchedBrand?.name || "";
  }
  if (item.vehicle_brand && !(item.vehicle_models || []).length) {
    const brand = vehicleCatalog.value.find((row) => row.name === item.vehicle_brand);
    item.vehicle_models = (brand?.models || [])
      .filter((model) => originalName.toLowerCase().includes(String(model.name || "").toLowerCase()))
      .map((model) => model.name);
    item.vehicle_model = item.vehicle_models.join("/");
  }
  item.fitment_type = item.vehicle_brand ? "specific" : "universal";
  const packageMatch = originalName.match(/(\d+)\s*(个|件|套|对|双|条|片|张|盒)(?:装|套)?/);
  if (packageMatch && Number(item.quantity || 1) <= 1) {
    item.quantity = Number(packageMatch[1]);
    item.stock_unit = packageMatch[2] === "件" && /件套/.test(packageMatch[0]) ? "个" : packageMatch[2];
    if (/套/.test(packageMatch[0])) item.package_mode = "set";
  }

  const dimensionAccessory = originalName.match(/(?:通用)?\s*\d+(?:\.\d+)?\s*(?:mm|毫米)/i)?.[0]?.replace(/\s+/g, "");
  if (!item.accessory || !namingValueAppearsInName(item.accessory, originalName)) {
    const matchedAccessory = longestMatchingOption(namingOptions.accessory, originalName);
    item.accessory = dimensionAccessory || matchedAccessory?.value || item.accessory || "普通款";
  }
  if (!Array.isArray(item.colors) || !item.colors.length || !item.colors.every((color) => namingValueAppearsInName(color, originalName))) {
    const optionColors = matchingOptionValues(namingOptions.color, originalName);
    const commonColors = ["黑色", "白色", "灰色", "银色", "红色", "蓝色", "绿色", "黄色", "橙色", "棕色", "米色", "紫色", "透明", "黑", "白", "灰", "银", "红", "蓝", "绿", "黄", "橙", "棕", "米", "紫"];
    const inferredColors = optionColors.length
      ? optionColors
      : commonColors.filter((color) => originalName.includes(color));
    item.colors = inferredColors.filter((color, index, rows) => (
      !rows.some((other, otherIndex) => otherIndex !== index && other.includes(color))
    ));
  }

  const inferredMaterials = matchingOptionValues(namingOptions.material, originalName);
  if (inferredMaterials.length && (!Array.isArray(item.materials) || !item.materials.length
    || !item.materials.every((material) => namingValueAppearsInName(material, originalName)))) {
    item.materials = inferredMaterials;
  }

  const inferredProcess = longestMatchingOption(namingOptions.process, originalName)?.value || "";
  if (inferredProcess && !namingValueAppearsInName(item.process, originalName)) item.process = inferredProcess;

  if (isEditMode.value && (!item.category || !item.accessory)) {
    const ignored = new Set([
      "通用",
      "专用",
      item.vehicle_brand,
      item.vehicle_model,
      ...(item.colors || [])
    ].map((value) => String(value || "").trim()).filter(Boolean));
    const candidates = originalName
      .replace(/\+.*$/, "")
      .replace(/赠.*$/, "")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token && !ignored.has(token) && !/^\d+(个|件|套|对|双|条|片|张|盒)(装|套)?$/.test(token));
    if (!item.category && candidates[0]) item.category = candidates[0];
    if (!item.accessory && candidates[1]) item.accessory = candidates[1];
  }

  await Promise.all(["accessory", "color", "material", "process", "quantity"].map(loadNamingOption));
}

async function loadNamingOption(type) {
  const item = form.structured_naming;
  const params = new URLSearchParams({ type });
  if (item.category) params.set("category", item.category);
  const brand = item.vehicle_brand || "";
  if (brand) params.set("brand", brand);
  if (item.fitment_type) params.set("fitment_type", item.fitment_type);
  if (item.vehicle_model) params.set("vehicle_model", item.vehicle_model);
  const result = await apiClient.get(`/api/inventory-product-naming/options?${params.toString()}`, { noCache: true });
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const currentValue = type === "accessory"
        ? item.accessory
        : type === "material"
          ? ""
          : type === "process"
            ? item.process
        : "";
  const currentValues = type === "color"
    ? (Array.isArray(item.colors) ? item.colors : [])
    : type === "material"
      ? (Array.isArray(item.materials) ? item.materials : [])
    : type === "quantity"
      ? [Number(item.quantity || 1)]
      : [currentValue].filter(Boolean);
  for (const value of currentValues.reverse()) {
    if (!rows.some((row) => String(row.value) === String(value))) {
      rows.unshift({ id: `current-${type}-${value}`, value, label: String(value).replace("|", " ").trim(), status: "current" });
    }
  }
  namingOptions[type] = rows;
}

async function loadVehicleCatalog() {
  const result = await apiClient.get("/api/ai-variant-lab/vehicle-catalog", { noCache: true });
  vehicleCatalog.value = Array.isArray(result?.brands) ? result.brands : [];
}

async function handleCategoryChange(value) {
  if (Array.from(String(value || "").trim()).length > 7) {
    form.structured_naming.category = "";
    ElMessage.warning("核心品名最多 7 个字，请缩短后再输入");
    return;
  }
  form.structured_naming.vehicle_model = "";
  form.structured_naming.vehicle_models = [];
  form.structured_naming.accessory = "普通款";
  await createNamingOption("category", value);
  await Promise.all(["accessory", "color", "material", "process", "quantity"].map(loadNamingOption));
}

async function handleVehicleBrandChange() {
  form.structured_naming.vehicle_model = "";
  form.structured_naming.vehicle_models = [];
  form.structured_naming.fitment_type = form.structured_naming.vehicle_brand ? "specific" : "universal";
}

function handleVehicleModelsChange(values) {
  form.structured_naming.vehicle_models = Array.isArray(values) ? values : [];
  form.structured_naming.vehicle_model = form.structured_naming.vehicle_models.join("/");
  form.structured_naming.fitment_type = form.structured_naming.vehicle_brand ? "specific" : "universal";
}

async function handleColorsChange(values) {
  form.structured_naming.colors = Array.isArray(values) ? values : [];
  if (canMaintainNamingOptions.value) {
    for (const value of form.structured_naming.colors) await createNamingOption("color", value);
    await loadNamingOption("color");
  }
}

async function handleControlledOptionChange(type, value) {
  if (!value || !canMaintainNamingOptions.value) return;
  await createNamingOption(type, value);
  await loadNamingOption(type);
}

async function handleMaterialsChange(values) {
  form.structured_naming.materials = Array.isArray(values) ? values : [];
  if (canMaintainNamingOptions.value) {
    for (const value of form.structured_naming.materials) await createNamingOption("material", value);
    await loadNamingOption("material");
  }
}

async function createNamingOption(type, value) {
  const text = String(value || "").trim();
  if (!text) return;
  if (namingOptions[type]?.some((item) => String(item.value) === text)) return;
  const label = type === "brand"
    ? text.split("|").filter((part) => part && part !== "无品牌").join(" ")
    : text;
  try {
    await apiClient.post("/api/inventory-product-naming/options", { option_type: type, value: text, label: label || "无品牌" });
    await loadNamingOption(type);
  } catch (error) {
    ElMessage.error(error.message || "新增选项失败");
  }
}

async function applyCoreName() {
  let result;
  try {
    result = await ElMessageBox.prompt(
      "核心品名只写商品本身，最多7个字。提交后由核动力牛马审核，通过后才会进入正式下拉。",
      "申请核心品名",
      {
        inputPlaceholder: "例如：钥匙壳、门槛条贴纸",
        confirmButtonText: "提交申请",
        cancelButtonText: "取消",
        inputValidator: (value) => {
          const text = String(value || "").trim();
          if (!text) return "请输入核心品名";
          return Array.from(text).length <= 7 || "核心品名最多7个字";
        }
      }
    );
  } catch { return; }
  try {
    const response = await apiClient.post("/api/inventory-product-naming/options", { option_type: "category", value: result.value, label: result.value });
    ElMessage.success(response.status === "active" ? "核心品名已创建" : "申请已提交，审核通过后可使用");
    await loadNamingOption("category");
  } catch (error) {
    ElMessage.error(error.message || "核心品名申请失败");
  }
}

async function editCoreNameOption(option) {
  if (!option?.id) return;
  let result;
  try {
    result = await ElMessageBox.prompt(
      `修改后将同步更新 ${Number(option.linked_product_count || 0)} 个已绑定商品的标准名称。`,
      "编辑核心品名",
      {
        inputValue: option.value,
        inputPlaceholder: "请输入统一后的核心品名",
        confirmButtonText: "保存并同步",
        cancelButtonText: "取消",
        inputValidator: (value) => {
          const text = String(value || "").trim();
          if (!text) return "核心品名不能为空";
          return Array.from(text).length <= 7 || "核心品名最多 7 个字";
        }
      }
    );
  } catch {
    return;
  }
  try {
    const response = await apiClient.put(`/api/inventory-product-naming/options/${option.id}`, { value: result.value });
    if (form.structured_naming.category === option.value) form.structured_naming.category = response.value;
    await loadNamingOptions();
    scheduleSimilarProducts();
    ElMessage.success(`核心品名已更新，同步影响 ${Number(response.affected_products || 0)} 个商品`);
  } catch (error) {
    ElMessage.error(error.message || "核心品名更新失败");
  }
}

async function deleteCoreNameOption(option) {
  if (!option?.id) return;
  const linkedCount = Number(option.linked_product_count || 0);
  if (linkedCount > 0) {
    ElMessage.warning(`“${option.value}”已绑定 ${linkedCount} 个商品，请先编辑合并，不能直接删除`);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认删除核心品名“${option.value}”？删除后不会再出现在建品选项中。`,
      "删除核心品名",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    await apiClient.delete(`/api/inventory-product-naming/options/${option.id}`);
    if (form.structured_naming.category === option.value) form.structured_naming.category = "";
    await loadNamingOptions();
    ElMessage.success("核心品名已删除");
  } catch (error) {
    ElMessage.error(error.message || "核心品名删除失败");
  }
}

watch(
  () => [form.package_weight_g, form.listing_price_rub, form.sale_price_rmb, form.air_sale_price_rmb],
  () => {
    if (props.visible && !manualLogisticsRule.value) {
      const nextRule = resolveSelectedLogisticsRule(form);
      form.logistics_rule_id = nextRule?.id || form.logistics_rule_id || "";
      form.shipping_method = nextRule?.channel || form.shipping_method || "air_land";
    }
    if (!Number(form.sale_price_rmb || 0) && Number(form.air_sale_price_rmb || 0)) {
      form.sale_price_rmb = Number(form.air_sale_price_rmb || 0);
    }
    syncPackagingFee(form);
  }
);

watch(
  () => [form.sale_price_rmb, form.exchange_rate],
  () => {
    syncListingPriceFromSale();
    syncPackagingFee(form);
  }
);

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isAirLandLogisticsRule(rule) {
  const text = normalizeText(`${rule?.name || ""} ${rule?.channel || ""} ${rule?.filter_keywords || ""}`);
  return text.includes("陆空") || text.includes("air") || text.includes("standard") || text.includes("express");
}

function money(value) {
  return Number(value || 0).toFixed(1);
}

function numberText(value, digits = 0) {
  return Number(value || 0).toFixed(digits);
}

function normalizeComponentItem(item = {}) {
  return {
    component_product_id: Number(item.component_product_id || item.product_id || item.id || 0),
    component_name: item.component_name || item.product_name || item.name || "",
    inventory_id: item.inventory_id || item.code || "",
    code: item.code || "",
    image_url: item.image_url || item.product_image_url || "",
    stock_unit: item.stock_unit || "个",
    local_stock: Number(item.local_stock || item.stock || 0),
    quantity: Number(item.quantity || 1) || 1,
    component_role: item.component_role === "gift" ? "gift" : "included",
    inventory_category: item.inventory_category || "",
    vehicle_brand: item.vehicle_brand || "",
    fitment_type: item.fitment_type === "specific" ? "specific" : "universal",
    vehicle_model: item.vehicle_model || "",
    accessory_name: item.accessory_name || "",
    color: item.color || "",
    product_quantity: Number(item.product_quantity || 1),
    package_mode: item.package_mode === "set" ? "set" : "single",
    package_contents: item.package_contents || ""
  };
}

function namingOptionValues(type) {
  return (namingOptions[type] || []).flatMap((row) => {
    const value = String(row.value || row.label || "").trim();
    if (!value) return [];
    if (type === "brand") return value.split("|").map((item) => item.trim()).filter(Boolean);
    return [value];
  });
}

function uniqueDirectoryValues(field, predicate = () => true, fallbackType = "") {
  const counts = new Map();
  const rows = componentDirectoryRows.value.filter(predicate);
  for (const row of rows) {
    const raw = field === "color" ? String(row[field] || "").split(",") : [String(row[field] || "")];
    for (const item of raw) {
      const value = item.trim();
      if (value) counts.set(value, Number(counts.get(value) || 0) + 1);
    }
  }
  if (fallbackType) {
    for (const value of namingOptionValues(fallbackType)) {
      const matchedCount = rows.filter((row) => String(row.name || "").toLowerCase().includes(value.toLowerCase())).length;
      if (matchedCount && !counts.has(value)) counts.set(value, matchedCount);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN")).map(([value]) => value);
}

const componentDirectoryBrands = computed(() => uniqueDirectoryValues("vehicle_brand", undefined, "brand"));
const componentDirectoryFitments = computed(() => uniqueDirectoryValues("fitment_type"));
const componentDirectoryModels = computed(() => uniqueDirectoryValues("vehicle_model", undefined, "vehicle_model"));
const componentDirectoryAccessories = computed(() => uniqueDirectoryValues("accessory_name", undefined, "accessory"));
const componentDirectoryColors = computed(() => uniqueDirectoryValues("color", undefined, "color"));
const componentDirectoryQuantities = computed(() => uniqueDirectoryValues("product_quantity", undefined, "quantity"));
const pagedComponentOptions = computed(() => componentOptions.value.slice(
  (componentPage.value - 1) * componentPageSize,
  componentPage.value * componentPageSize
));
const componentSearchActive = computed(() => Boolean(String(componentQuery.value || "").trim() || componentDirectoryRows.value.length));

function componentFieldMatches(row, field, expected) {
  if (expected === "" || expected === null || expected === undefined) return true;
  const target = String(expected).trim().toLowerCase();
  const name = String(row.name || "").toLowerCase();
  if (field === "color") {
    const colors = String(row.color || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    return colors.includes(target) || (!colors.length && name.includes(target));
  }
  if (field === "quantity") {
    const quantity = Number(row.product_quantity || 0);
    return quantity === Number(expected) || (!quantity && new RegExp(`${Number(expected)}\\s*(个|件|套|对|双|条|片|张|盒)`).test(name));
  }
  const value = String(row[field] || "").trim().toLowerCase();
  if (value) return value.includes(target);
  const fallback = field === "fitment_type"
    ? (target === "specific" ? "专用" : "通用")
    : target;
  return name.includes(fallback);
}

function componentMatchReasons(row) {
  const fields = [
    ["brand", "vehicle_brand", "品牌"],
    ["fitment_type", "fitment_type", "适配"],
    ["vehicle_model", "vehicle_model", "车型"],
    ["accessory", "accessory_name", "款式"],
    ["color", "color", "颜色"],
    ["quantity", "quantity", "包装"]
  ];
  return fields
    .filter(([key, field]) => componentDirectory[key] !== "" && componentFieldMatches(row, field, componentDirectory[key]))
    .map(([, , label]) => label);
}

function componentLabel(row = {}) {
  return row.component_name || row.name || row.inventory_id || row.code || `#${row.component_product_id || row.id || "-"}`;
}

function componentCode(row = {}) {
  return row.inventory_id || row.code || `#${row.component_product_id || row.id || "-"}`;
}

function componentAvailable(row = {}) {
  const quantity = Number(row.quantity || 0);
  if (!quantity) return 0;
  return Math.floor(Number(row.local_stock || 0) / quantity);
}

function compositionAvailable() {
  const values = form.composition_items.map(componentAvailable);
  return values.length ? Math.min(...values) : null;
}

async function searchComponentProducts() {
  const query = String(componentQuery.value || "").trim();
  if (!query) {
    componentOptions.value = [];
    return;
  }
  componentLoading.value = true;
  try {
    const matchedCategory = namingOptions.category.find((item) => (
      String(item.value || "").toLowerCase().includes(query.toLowerCase())
      || String(item.label || "").toLowerCase().includes(query.toLowerCase())
    ));
    componentDirectory.category = matchedCategory?.value || query;
    Object.assign(componentDirectory, {
      category: componentDirectory.category,
      brand: "",
      fitment_type: "",
      vehicle_model: "",
      accessory: "",
      color: "",
      quantity: ""
    });
    const rows = [];
    let page = 1;
    let total = 0;
    do {
      const params = new URLSearchParams({
        paged: "1",
        page: String(page),
        pageSize: "100",
        query: componentDirectory.category,
        matchMode: "any"
      });
      const result = await apiClient.get(`/api/products?${params.toString()}`);
      const pageRows = Array.isArray(result?.rows) ? result.rows : [];
      rows.push(...pageRows);
      total = Number(result?.total || rows.length);
      page += 1;
      if (!pageRows.length) break;
    } while (rows.length < total);
    componentDirectoryRows.value = rows
      .filter((item) => {
        const category = String(item.inventory_category || "").trim();
        if (category) return category === componentDirectory.category;
        return String(item.name || "").toLowerCase().includes(componentDirectory.category.toLowerCase());
      })
      .filter((item) => Number(item.id) !== Number(form.id || 0));
    filterComponentDirectoryProducts();
  } catch (error) {
    ElMessage.error(error.message || "加载组件商品失败");
  } finally {
    componentLoading.value = false;
  }
}

function filterComponentDirectoryProducts() {
  componentOptions.value = componentDirectoryRows.value
    .filter((row) => componentFieldMatches(row, "vehicle_brand", componentDirectory.brand))
    .filter((row) => componentFieldMatches(row, "fitment_type", componentDirectory.fitment_type))
    .filter((row) => componentFieldMatches(row, "vehicle_model", componentDirectory.vehicle_model))
    .filter((row) => componentFieldMatches(row, "accessory_name", componentDirectory.accessory))
    .filter((row) => componentFieldMatches(row, "color", componentDirectory.color))
    .filter((row) => componentFieldMatches(row, "quantity", componentDirectory.quantity))
    .sort((left, right) => (
      componentMatchReasons(right).length - componentMatchReasons(left).length
      || Number(right.stock || 0) - Number(left.stock || 0)
    ));
  componentPage.value = 1;
}

function handleComponentFilterChange() {
  componentSelectId.value = "";
  filterComponentDirectoryProducts();
}

function addComponentProduct(row) {
  const item = normalizeComponentItem(row);
  item.component_role = componentRole.value === "gift" ? "gift" : "included";
  if (!item.component_product_id) return;
  if (Number(item.component_product_id) === Number(form.id || 0)) {
    ElMessage.warning("组成部分不能选择当前商品自己");
    return;
  }
  const existing = form.composition_items.find((component) => Number(component.component_product_id) === Number(item.component_product_id));
  if (existing) {
    existing.quantity = Number(existing.quantity || 0) + 1;
    existing.component_role = item.component_role;
    return;
  }
  form.composition_items.push(item);
  componentSelectId.value = "";
  componentQuery.value = "";
}

function addExternalComponentProduct(row, role = "included") {
  componentRole.value = role === "gift" ? "gift" : "included";
  addComponentProduct(row);
}

defineExpose({ addExternalComponentProduct });

function handleComponentSelect(productId) {
  const row = componentOptions.value.find((item) => Number(item.id) === Number(productId));
  if (row) addComponentProduct(row);
}

function removeComponentProduct(productId) {
  form.composition_items = form.composition_items.filter((item) => Number(item.component_product_id) !== Number(productId));
}

function productAutoTypeLabel() {
  return form.composition_items.length ? "组合产品" : "单品产品";
}

function requestQuickCreateComponent() {
  emit("quick-create-component", {
    role: componentRole.value,
    query: String(componentQuery.value || "").trim()
  });
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function percentText(value, digits = 1) {
  return `${numberText(value, digits)}%`;
}

function toNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseCommissionList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.commissions)) return parsed.commissions;
    return parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

function normalizeSchemaHint(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("rfbs")) return "rfbs";
  if (text.includes("fbs")) return "fbs";
  if (text.includes("fbo")) return "fbo";
  if (text.includes("fbp")) return "fbp";
  return text;
}

function selectCommissionEntry(list, row) {
  const schemaHints = [
    row?.sale_schema,
    row?.schema,
    row?.delivery_schema,
    row?.stock_type,
    row?.shipping_method
  ].map(normalizeSchemaHint).filter(Boolean);
  for (const hint of schemaHints) {
    const exact = list.find((item) => normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type) === hint);
    if (exact) return exact;
  }
  if (schemaHints.some((hint) => hint.includes("fbo") || hint.includes("fbp"))) {
    return list.find((item) => {
      const normalized = normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type);
      return normalized.includes("fbo") || normalized.includes("fbp");
    });
  }
  return list.find((item) => normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type).includes("fbs"));
}

function getOzonCommissionRate(row) {
  const raw = row?.commissions_json || row?.ozon_commissions_json || row?.commission_json;
  const list = parseCommissionList(raw);
  if (!list.length) return null;
  const preferred = selectCommissionEntry(list, row) || list[0];
  const value = [
    preferred?.percent,
    preferred?.commission,
    preferred?.rate,
    preferred?.value
  ].map(toNumberOrNull).find((item) => item !== null && item > 0);
  if (value === undefined || value === null) return null;
  return value > 1 ? value / 100 : value;
}

function profitModeLabel(mode) {
  return mode === "profit" ? "利润额" : "净利率";
}

function getPurchaseCostPerUnit(product) {
  const quantity = Math.max(Number(product?.purchase_quantity || 1), 1);
  return Number(product?.purchase_cost || 0) + Number(product?.domestic_shipping || 0) / quantity + Number(product?.handling_fee || 0);
}

function getSalePriceRmb(product) {
  return Number(product?.sale_price_rmb || product?.air_sale_price_rmb || 0);
}

function resolvedAdvertisingRate(row) {
  const value = Number(row?.advertising_rate || 0);
  return value > 1 ? value / 100 : value;
}

function resolvedReturnRate(row) {
  const value = Number(row?.return_rate ?? 0.05);
  return value > 1 ? value / 100 : value;
}

function resolvePackagingAmount(row) {
  const sale = Number(row?.sale_price_rmb || row?.air_sale_price_rmb || 0);
  if (sale > 0) return sale;
  const listed = Number(row?.listing_price_rub || 0);
  const exchangeRate = Number(row?.exchange_rate || 0);
  if (listed > 0 && exchangeRate > 0) return listed / exchangeRate;
  return Number(row?.purchase_cost || 0);
}

function getDefaultPackagingFee(row) {
  const weight = Number(row?.package_weight_g || 0);
  const amount = resolvePackagingAmount(row);
  if (weight < 100 && amount < 50) return 0.3;
  if (weight < 500 && amount < 100) return 0.5;
  return 1.0;
}

function syncPackagingFee(row = form) {
  if (manualPackagingFee.value) return;
  form.handling_fee = getDefaultPackagingFee(row);
}

function getCommissionRate(listingPriceRub) {
  return Number(listingPriceRub || 0) <= 1500 ? 0.12 : 0.17;
}

function getResolvedCommissionRate(row, listingPriceRub) {
  const ozonRate = getOzonCommissionRate(row);
  if (ozonRate !== null) return ozonRate;
  const low = Number(row?.commission_low ?? 0.12);
  const high = Number(row?.commission_high ?? 0.17);
  return Number(listingPriceRub || 0) <= 1500 ? low : high;
}

function getTransportEstimate(row, logisticsRule) {
  const rule = logisticsRule || {};
  const weight = Number(row?.package_weight_g || 0);
  const quantity = Math.max(Number(row?.purchase_quantity || 1), 1);
  const purchaseUnit = getPurchaseCostPerUnit(row);
  const base = Number(rule.base_fee_cny || 0);
  const perGram = Number(rule.per_gram_cny || 0);
  const perTicket = Number(rule.per_ticket_cny || 0);
  const amount = roundMoney(base + weight * perGram + perTicket);
  return {
    rule,
    totalRmb: amount,
    totalCny: amount,
    unitPurchase: roundMoney(purchaseUnit),
    unitDomestic: roundMoney(Number(row?.domestic_shipping || 0) / quantity)
  };
}

function estimateCurrentSaleRow(row, logisticsRule) {
  const purchaseUnit = getPurchaseCostPerUnit(row);
  const transport = getTransportEstimate(row, logisticsRule);
  const targetMode = String(row?.desired_profit_mode || "margin");
  const targetValue = Number(row?.desired_profit_value || 0);
  const returnRate = resolvedReturnRate(row);
  const exchangeRate = Number(row?.exchange_rate || 11.32);
  const saleForRate = Number(row?.sale_price_rmb || row?.air_sale_price_rmb || 0);
  const listingPriceRub = Number(row?.listing_price_rub || 0) || roundMoney(saleForRate * exchangeRate);
  const commissionRate = getResolvedCommissionRate(row, listingPriceRub);
  const adRate = resolvedAdvertisingRate(row);
  const finalMileRate = 0.014;
  const withdrawalRate = Number(row?.withdrawal_fee_rate ?? 0.012);
  const finalMile = (saleRmb) => saleRmb * finalMileRate + (saleRmb < 50 ? 1 : saleRmb >= 750 ? 15 : saleRmb * 0.02);
  const returnLoss = (purchaseUnit + transport.totalRmb) * returnRate;
  const totalCostExceptSale = purchaseUnit + transport.totalRmb + returnLoss;
  if (targetMode === "profit") {
    const targetProfit = targetValue;
    const saleRmb = roundMoney((totalCostExceptSale + targetProfit) / Math.max(0.01, 1 - commissionRate - adRate - returnRate - withdrawalRate - finalMileRate));
    return { saleRmb, listingPriceRub: roundMoney(saleRmb * exchangeRate) };
  }
  const targetMargin = targetValue > 1 ? targetValue / 100 : targetValue;
  const saleRmb = roundMoney(totalCostExceptSale / Math.max(0.01, 1 - commissionRate - adRate - returnRate - withdrawalRate - finalMileRate - targetMargin));
  return { saleRmb, listingPriceRub: roundMoney(saleRmb * exchangeRate) };
}

function resolveSelectedLogisticsRule(row) {
  if (manualLogisticsRule.value && row?.logistics_rule_id) {
    return resolveCurrentLogisticsRule(availableLogisticsRules.value, row.logistics_rule_id);
  }
  const weight = Number(row?.package_weight_g || 0);
  const saleRmb = Number(row?.sale_price_rmb || row?.air_sale_price_rmb || 0) || (Number(row?.listing_price_rub || 0) / Number(row?.exchange_rate || 11.32));
  const matched = logisticsRuleOptions.value.find((rule) => {
    const minWeight = Number(rule.min_weight_g || 0);
    const maxWeight = Number(rule.max_weight_g || Infinity);
    const minPrice = Number(rule.min_price_rub || 0);
    const maxPrice = Number(rule.max_price_rub || Infinity);
    return weight >= minWeight && weight <= maxWeight && saleRmb * Number(row?.exchange_rate || 11.32) >= minPrice && saleRmb * Number(row?.exchange_rate || 11.32) <= maxPrice;
  });
  return matched || logisticsRuleOptions.value[0] || null;
}

function buildSelectionPreview(row, logisticsRule) {
  if (!row) return { saleRmb: 0, listingPriceRub: 0, profit: 0, margin: 0, suggestedSaleRmb: 0, totalCost: 0, targetMode: "margin", targetMargin: 0, targetProfit: 0, transport: { totalRmb: 0 }, commission: 0, finalMile: 0, withdrawal: 0, advertising: 0, returnLoss: 0 };
  const sale = getSalePriceRmb(row);
  const targetMode = String(row.desired_profit_mode || "margin");
  const adRate = resolvedAdvertisingRate(row);
  const purchaseUnit = getPurchaseCostPerUnit(row);
  const transport = getTransportEstimate(row, logisticsRule);
  const suggested = estimateCurrentSaleRow(row, logisticsRule);
  const saleResolved = sale > 0 ? sale : suggested.saleRmb;
  const listingPriceRub = Number(row.listing_price_rub || suggested.listingPriceRub || saleResolved * Number(row.exchange_rate || 11.32));
  const commission = saleResolved * getResolvedCommissionRate(row, listingPriceRub);
  const finalMile = saleResolved * 0.014 + (saleResolved < 50 ? 1 : saleResolved >= 750 ? 15 : saleResolved * 0.02);
  const withdrawal = Math.max(0, saleResolved - finalMile - transport.totalRmb - saleResolved * 0.2) * Number(row.withdrawal_fee_rate || 0.012);
  const advertising = saleResolved * adRate;
  const returnLoss = (purchaseUnit + transport.totalRmb) * resolvedReturnRate(row);
  const profit = roundMoney(saleResolved - purchaseUnit - transport.totalRmb - commission - finalMile - withdrawal - advertising - returnLoss);
  const margin = saleResolved > 0 ? roundMoney((profit / saleResolved) * 100) : 0;
  const targetMargin = targetMode === "margin"
    ? (Number(row.desired_profit_value || 0) > 1 ? Number(row.desired_profit_value || 0) : Number(row.desired_profit_value || 0) * 100)
    : (saleResolved > 0 ? (Number(row.desired_profit_value || 0) / saleResolved) * 100 : 0);
  const targetProfit = targetMode === "profit" ? Number(row.desired_profit_value || 0) : saleResolved * (targetMargin / 100);
  return {
    saleRmb: roundMoney(saleResolved),
    listingPriceRub: roundMoney(Number(row.listing_price_rub || suggested.listingPriceRub || 0)),
    profit,
    margin,
    suggestedSaleRmb: suggested.saleRmb,
    totalCost: roundMoney(saleResolved - profit),
    targetMode,
    targetMargin: roundMoney(targetMargin),
    targetProfit: roundMoney(targetProfit),
    transport,
    commission,
    finalMile,
    withdrawal,
    advertising,
    returnLoss
  };
}

function syncListingPriceFromSale() {
  const salePrice = Number(form.sale_price_rmb || 0);
  form.listing_price_rub = roundMoney(salePrice * Number(form.exchange_rate || 11.32));
  form.air_sale_price_rmb = salePrice;
}

async function handleImageUpload(file) {
  const rawFile = file;
  if (!rawFile) return false;
  imageUploadLoading.value = true;
  try {
    const result = await uploadListingMedia(rawFile, {
      source_module: "inventory_product",
      role: "inventory_product_image"
    });
    const imageUrl = result.publishUrl || result.url || result.previewUrl || "";
    if (!imageUrl) throw new Error("图片上传成功，但未返回可保存的 OSS 地址");
    form.image_url = imageUrl;
    ElMessage.success("图片已导入");
    return false;
  } catch (error) {
    ElMessage.error(error.message || "图片导入失败");
    return false;
  } finally {
    imageUploadLoading.value = false;
  }
}

function handleImageUploadChange(uploadFile) {
  return handleImageUpload(uploadFile?.raw || uploadFile);
}

function clearUploadedImage() {
  form.image_url = "";
}

function closeDialog() {
  emit("update:visible", false);
}

async function submitDialog() {
  if (!formRef.value) return;
  form.name = generatedProductName.value || form.name;
  await formRef.value.validate();
  submitting.value = true;
  try {
    const editProductId = Number(props.editProductId || form.id || 0);
    if (isEditMode.value && editProductId <= 0) {
      throw new Error("缺少要编辑的库存产品 ID，已阻止误创建，请关闭后重新打开");
    }
    const effectiveLogisticsRule = resolveSelectedLogisticsRule(form);
    const payload = {
      ...form,
      name: generatedProductName.value || form.name,
      structured_naming: { ...form.structured_naming, stock_unit: form.structured_naming.stock_unit || form.stock_unit },
      supplier_id: form.supplier_id || null,
      owner_person_id: Number(form.owner_person_id || 0) || null,
      logistics_rule_id: Number(effectiveLogisticsRule?.id || form.logistics_rule_id || 0) || null,
      shipping_method: form.shipping_method || "air_land",
      purchase_cost: Number(form.purchase_cost || 0),
      domestic_shipping: Number(form.domestic_shipping || 0),
      handling_fee: Number(form.handling_fee || 0),
      purchase_quantity: Number(form.purchase_quantity || 1),
      package_weight_g: Number(form.package_weight_g || 0),
      length_cm: Number(form.length_cm || 30),
      width_cm: Number(form.width_cm || 20),
      height_cm: Number(form.height_cm || 10),
      sale_price_rmb: Number(form.sale_price_rmb || 0),
      listing_price_rub: Number(form.listing_price_rub || 0),
      air_sale_price_rmb: Number(form.air_sale_price_rmb || 0),
      exchange_rate: Number(form.exchange_rate || 11.32),
      advertising_rate: Number(form.advertising_rate || 0),
      desired_profit_value: Number(form.desired_profit_value || 20),
      return_rate: resolvedReturnRate(form),
      stock_unit: form.structured_naming.stock_unit || form.stock_unit || "个",
      is_accessory: Number(form.is_accessory || 0) ? 1 : 0,
      composition_items: form.composition_items.map((item) => ({
        component_product_id: Number(item.component_product_id || 0),
        quantity: Number(item.quantity || 1),
        component_role: item.component_role === "gift" ? "gift" : "included"
      })).filter((item) => item.component_product_id > 0),
      selection_status: isInventoryTarget.value ? "listed" : (isEditMode.value ? form.selection_status || "draft" : "draft"),
      product_type: isInventoryTarget.value ? "main" : (isEditMode.value ? form.product_type || "selection" : "selection")
    };
    const savedProduct = isEditMode.value
      ? await apiClient.put(`/api/products/${editProductId}`, payload)
      : await apiClient.post(props.createEndpoint || "/api/products", { ...payload, ...(props.createContext || {}) });
    emit("saved", { mode: props.mode, target: props.target, product: savedProduct || null });
    emit("update:visible", false);
  } catch (error) {
    const message = String(error?.message || "");
    if (/Duplicate entry .*uk_products_selection_id/i.test(message)) {
      ElMessage.error("当前选品编号已被其他库存商品使用，请关闭弹窗后重新新增；系统将自动生成新编号");
    } else if (/Duplicate entry .*uk_products_code/i.test(message)) {
      ElMessage.error("当前库存编码已被其他商品使用，请关闭弹窗后重新新增；系统将自动生成新编码");
    } else {
      ElMessage.error(message || "保存失败");
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="dialogTitle"
    width="min(1880px, 99vw)"
    align-center
    append-to-body
    destroy-on-close
    class="selection-form-dialog erp-centered-dialog"
    @closed="formRef?.clearValidate?.()"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-form ref="formRef" :model="form" :rules="formRules" label-width="96px">
      <div class="selection-workbench has-similar-products">
        <div class="selection-workbench-main">
          <div class="form-section standard-naming-section">
            <div class="form-section-head naming-section-head">
              <div>
                <div class="form-section-title">标准库存建品</div>
                <span class="form-section-subtitle">按产品身份、规格属性和库存计量填写，系统自动生成统一库存名称。</span>
              </div>
            </div>
            <div class="standard-name-preview standard-name-preview--top">
              <span>最终标准名称</span>
              <strong>{{ generatedProductName || '选择核心品名后自动生成' }}</strong>
            </div>
            <div class="naming-workspace">
              <el-row :gutter="10" class="naming-fields-grid">
              <el-col :span="24" class="naming-step-heading">
                <strong>1. 产品身份</strong>
                <span>核心品名只写商品本身；汽车品牌和车型不填时按通用处理。</span>
              </el-col>
              <el-col :span="8" class="naming-field naming-field--identity">
                <el-form-item label="核心品名" required>
                  <el-select v-model="form.structured_naming.category" filterable :allow-create="canMaintainNamingOptions" default-first-option placeholder="请选择核心品名（最多7个字）" @change="handleCategoryChange">
                    <el-option v-for="item in namingOptions.category" :key="item.id || item.value" :label="item.label" :value="item.value">
                      <div class="core-name-option">
                        <span>{{ item.label }}</span>
                        <small v-if="Number(item.linked_product_count || 0)">{{ item.linked_product_count }} 个商品</small>
                        <div v-if="canMaintainNamingOptions" class="core-name-option-actions">
                          <el-button link type="primary" @click.stop.prevent="editCoreNameOption(item)">编辑</el-button>
                          <el-button link type="danger" title="删除" @click.stop.prevent="deleteCoreNameOption(item)">－</el-button>
                        </div>
                      </div>
                    </el-option>
                  </el-select>
                  <el-button class="core-name-apply-button" link type="primary" @click="applyCoreName">申请核心品名</el-button>
                </el-form-item>
              </el-col>
              <el-col :span="8" class="naming-field naming-field--identity">
                <el-form-item label="汽车品牌">
                  <el-select v-model="form.structured_naming.vehicle_brand" filterable clearable placeholder="不选择则为通用" @change="handleVehicleBrandChange">
                    <el-option v-for="brand in vehicleBrandOptions" :key="brand.value" :label="brand.label" :value="brand.value" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8" class="naming-field naming-field--identity">
                <el-form-item label="车型">
                  <el-select v-model="form.structured_naming.vehicle_models" multiple filterable clearable collapse-tags :disabled="!form.structured_naming.vehicle_brand" placeholder="可多选；不选择为品牌全系" @change="handleVehicleModelsChange">
                    <el-option v-for="model in vehicleModelOptions" :key="model.id || model.name" :label="model.label || model.name" :value="model.name" />
                  </el-select>
                </el-form-item>
              </el-col>

              <el-col :span="24" class="naming-step-heading">
                <strong>2. 规格属性</strong>
                <span>颜色、材质和工艺从标准选项选择；款式可自由填写，不填时使用“普通”。</span>
              </el-col>
              <el-col :span="6" class="naming-field naming-field--spec">
                <el-form-item label="颜色">
                  <el-select v-model="form.structured_naming.colors" multiple filterable clearable :allow-create="canMaintainNamingOptions" default-first-option placeholder="请选择颜色（可不填）" @change="handleColorsChange">
                    <el-option v-for="item in namingOptions.color" :key="item.value" :label="item.label" :value="item.value" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="6" class="naming-field naming-field--spec">
                <el-form-item label="款式">
                  <el-select v-model="form.structured_naming.accessory" filterable allow-create default-first-option placeholder="请选择或输入款式">
                    <el-option v-for="(item, index) in namingOptions.accessory" :key="item.value" :label="item.label" :value="item.value">
                      <div class="ranked-naming-option"><span>{{ item.label }}</span><small v-if="Number(item.usage_count || 0)">{{ index < 3 ? '热门 · ' : '' }}{{ item.usage_count }} 次</small></div>
                    </el-option>
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="6" class="naming-field naming-field--spec">
                <el-form-item label="材质">
                  <el-select v-model="form.structured_naming.materials" multiple filterable clearable collapse-tags :allow-create="canMaintainNamingOptions" default-first-option placeholder="请选择材质（可多选）" @change="handleMaterialsChange">
                    <el-option v-for="(item, index) in namingOptions.material" :key="item.value" :label="item.label" :value="item.value">
                      <div class="ranked-naming-option"><span>{{ item.label }}</span><small v-if="Number(item.usage_count || 0)">{{ index < 3 ? '热门 · ' : '' }}{{ item.usage_count }} 次</small></div>
                    </el-option>
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="6" class="naming-field naming-field--spec">
                <el-form-item label="工艺">
                  <el-select v-model="form.structured_naming.process" filterable clearable :allow-create="canMaintainNamingOptions" default-first-option placeholder="请选择工艺（可不填）" @change="handleControlledOptionChange('process', $event)">
                    <el-option v-for="(item, index) in namingOptions.process" :key="item.value" :label="item.label" :value="item.value">
                      <div class="ranked-naming-option"><span>{{ item.label }}</span><small v-if="Number(item.usage_count || 0)">{{ index < 3 ? '热门 · ' : '' }}{{ item.usage_count }} 次</small></div>
                    </el-option>
                  </el-select>
                </el-form-item>
              </el-col>

              <el-col :span="24" class="naming-step-heading">
                <strong>3. 库存计量与履约</strong>
                <span>数量和单位用于库存计数；添加子产品后系统自动按套装处理。</span>
              </el-col>
              <el-col :span="8" class="naming-field naming-field--measure">
                <el-form-item label="数量" required>
                  <div class="naming-quantity-row">
                    <el-select v-model="form.structured_naming.quantity" filterable allow-create default-first-option placeholder="数量" @change="createNamingOption('quantity', form.structured_naming.quantity)">
                      <el-option v-for="item in namingOptions.quantity" :key="item.value" :label="item.label" :value="Number(item.value)" />
                    </el-select>
                  </div>
                </el-form-item>
              </el-col>
              <el-col :span="8" class="naming-field naming-field--measure">
                <el-form-item label="单位" required>
                  <el-select v-model="form.structured_naming.stock_unit" placeholder="请选择单位">
                    <el-option v-for="unit in STOCK_UNIT_OPTIONS" :key="unit" :label="unit" :value="unit" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8" class="naming-field naming-field--measure">
                <el-form-item label="产品角色">
                  <el-checkbox :model-value="true" disabled>可作为单品</el-checkbox>
                  <el-checkbox v-model="form.is_accessory" :true-value="1" :false-value="0">可作为配件</el-checkbox>
                </el-form-item>
              </el-col>
            </el-row>
              <div class="naming-main-image">
                <strong>商品主图</strong>
                <ProductImagePreview :src="form.image_url" size="portrait" fit="cover" />
                <div class="naming-main-image__actions">
                  <el-upload :show-file-list="false" :auto-upload="false" accept="image/*" :on-change="handleImageUploadChange">
                    <el-button class="erp-btn erp-btn-secondary" :loading="imageUploadLoading">上传主图</el-button>
                  </el-upload>
                  <el-button v-if="form.image_url" link type="danger" @click="clearUploadedImage">清除</el-button>
                </div>
              </div>
            </div>
          </div>
          <div class="form-section basic-info-section">
            <div class="form-section-title">基础信息</div>
            <el-row :gutter="18">
              <el-col :span="12">
                <el-form-item label="负责人" prop="owner_person_id">
                  <el-select v-model="form.owner_person_id" placeholder="请选择负责人">
                    <el-option v-for="person in people" :key="person.id" :label="person.name" :value="String(person.id)" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="来源平台">
                  <el-select v-model="form.source_platform">
                    <el-option label="1688" value="1688" />
                    <el-option label="淘宝" value="taobao" />
                    <el-option label="拼多多" value="pinduoduo" />
                    <el-option label="供应商" value="supplier" />
                    <el-option label="其他" value="other" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="供应商">
                  <el-select v-model="form.supplier_id" clearable placeholder="请选择供应商">
                    <el-option v-for="supplier in suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="采购链接">
                  <el-input v-model="form.purchase_url" placeholder="https://detail.1688.com/..." />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="产品类型">
                  <el-radio-group v-model="form.is_accessory">
                    <el-radio-button :value="0">普通商品</el-radio-button>
                    <el-radio-button :value="1">配件商品</el-radio-button>
                  </el-radio-group>
                </el-form-item>
              </el-col>
            </el-row>
          </div>

          <div class="form-section procurement-section">
            <div class="form-section-title">采购与物流</div>
            <el-row :gutter="18">
              <el-col :span="8">
                <el-form-item label="采购成本">
                  <el-input-number v-model="form.purchase_cost" :min="0" :precision="1" :step="0.1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="国内运费">
                  <el-input-number v-model="form.domestic_shipping" :min="0" :precision="1" :step="0.1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="打包费">
                  <el-input-number v-model="form.handling_fee" :min="0" :precision="1" :step="0.1" controls-position="right" @change="manualPackagingFee = true" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="采购数量" prop="purchase_quantity">
                  <el-input-number v-model="form.purchase_quantity" :min="1" :precision="0" :step="1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="重量(g)">
                  <el-input-number v-model="form.package_weight_g" :min="0" :precision="0" :step="10" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="物流规则">
                  <el-select v-model="form.logistics_rule_id" filterable placeholder="优先热度高的规则" @change="manualLogisticsRule = true">
                    <el-option
                      v-for="rule in logisticsRuleOptions"
                      :key="rule.id"
                      :label="`${rule.name} · ${rule.carrier}/${rule.channel} · ${numberText(rule.min_weight_g, 1)}-${numberText(rule.max_weight_g, 1)}g`"
                      :value="rule.id"
                    />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="长(cm)">
                  <el-input-number v-model="form.length_cm" :min="0" :precision="0" :step="1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="宽(cm)">
                  <el-input-number v-model="form.width_cm" :min="0" :precision="0" :step="1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="高(cm)">
                  <el-input-number v-model="form.height_cm" :min="0" :precision="0" :step="1" controls-position="right" />
                </el-form-item>
              </el-col>
            </el-row>
          </div>

          <div class="form-section pricing-section">
            <div class="form-section-title">定价与利润</div>
            <el-row :gutter="18">
              <el-col :span="8">
                <el-form-item label="售价(RMB)">
                  <el-input-number v-model="form.sale_price_rmb" :min="0" :precision="1" :step="0.1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="标价(RUB)">
                  <el-input-number :model-value="Number(form.listing_price_rub || 0)" :min="0" :precision="1" controls-position="right" disabled />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="汇率">
                  <el-input-number v-model="form.exchange_rate" :min="0" :precision="1" :step="0.1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="利润模式">
                  <el-select v-model="form.desired_profit_mode">
                    <el-option label="净利率" value="margin" />
                    <el-option label="利润额" value="profit" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="利润目标">
                  <el-input-number v-model="form.desired_profit_value" :min="0" :precision="1" :step="0.1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="广告预算(%)">
                  <el-input-number v-model="form.advertising_rate" :min="0" :max="100" :precision="1" :step="0.1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="退货率(%)">
                  <el-input-number v-model="form.return_rate" :min="0" :max="100" :precision="1" :step="0.1" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="24">
                <el-form-item label="供应商备注">
                  <el-input v-model="form.supplier_note" type="textarea" :rows="3" placeholder="记录采购渠道、MOQ、打样或谈价说明" />
                </el-form-item>
              </el-col>
            </el-row>
          </div>

          <div class="form-section composition-section">
            <div class="form-section-title">添加子产品</div>
            <div class="composition-help">
              <span>建品时即可从已有库存选择子产品；固定组成和固定赠品会随主商品一起保存，并参与出库扣减。</span>
              <strong>{{ form.composition_items.length ? `可组 ${compositionAvailable() ?? 0} 件` : productAutoTypeLabel() }}</strong>
            </div>
            <div class="component-picker-row">
              <el-select v-model="componentRole" class="component-role-select">
                <el-option label="固定组成" value="included" />
                <el-option label="固定赠品" value="gift" />
              </el-select>
              <el-input
                v-model="componentQuery"
                clearable
                placeholder="输入核心品名，例如：雨刷、钥匙壳"
                @keyup.enter="searchComponentProducts"
                @clear="componentOptions = []; componentDirectoryRows = []; componentPage = 1; Object.assign(componentDirectory, { category: '', brand: '', fitment_type: '', vehicle_model: '', accessory: '', color: '', quantity: '' })"
              >
                <template #append>
                  <el-button :loading="componentLoading" @click="searchComponentProducts">搜索</el-button>
                </template>
              </el-input>
              <el-button @click="requestQuickCreateComponent">快速创建配件</el-button>
            </div>
            <div v-if="componentDirectoryRows.length" class="component-directory">
              <div class="component-directory-path">
                <strong>{{ componentDirectory.category }}</strong>
                <span>条件可按任意顺序输入或选择，组合条件实时筛选</span>
              </div>
              <div class="component-directory-selects">
                <el-select v-model="componentDirectory.brand" filterable allow-create default-first-option clearable placeholder="品牌" @change="handleComponentFilterChange">
                  <el-option v-for="value in componentDirectoryBrands" :key="value" :label="value" :value="value" />
                </el-select>
                <el-select v-model="componentDirectory.fitment_type" filterable allow-create default-first-option clearable placeholder="适配" @change="handleComponentFilterChange">
                  <el-option v-for="value in componentDirectoryFitments" :key="value" :label="value === 'specific' ? '专用' : '通用'" :value="value" />
                </el-select>
                <el-select v-model="componentDirectory.vehicle_model" filterable allow-create default-first-option clearable placeholder="车型" @change="handleComponentFilterChange">
                  <el-option v-for="value in componentDirectoryModels" :key="value" :label="value" :value="value" />
                </el-select>
                <el-select v-model="componentDirectory.accessory" filterable allow-create default-first-option clearable placeholder="款式/特征" @change="handleComponentFilterChange">
                  <el-option v-for="value in componentDirectoryAccessories" :key="value" :label="value" :value="value" />
                </el-select>
                <el-select v-model="componentDirectory.color" filterable allow-create default-first-option clearable placeholder="颜色" @change="handleComponentFilterChange">
                  <el-option v-for="value in componentDirectoryColors" :key="value" :label="value" :value="value" />
                </el-select>
                <el-select v-model="componentDirectory.quantity" filterable allow-create default-first-option clearable placeholder="包装" @change="handleComponentFilterChange">
                  <el-option v-for="value in componentDirectoryQuantities" :key="value" :label="`${value}件`" :value="value" />
                </el-select>
              </div>
              <el-select
                v-model="componentSelectId"
                filterable
                clearable
                class="component-select"
                placeholder="选择搜索结果添加"
                @change="handleComponentSelect"
              >
                <el-option
                  v-for="item in componentOptions"
                  :key="item.id"
                  :label="`${item.name || item.code || `#${item.id}`} · ${item.code || item.id}`"
                  :value="item.id"
                />
              </el-select>
            </div>
            <el-table
              v-if="form.composition_items.length"
              :data="form.composition_items"
              border
              class="erp-data-table product-composition-table"
              max-height="260"
            >
              <el-table-column label="组成产品" min-width="260">
                <template #default="{ row }">
                  <div class="component-product-with-image">
                    <ProductImagePreview :src="row.image_url" size="small" fit="cover" />
                    <div class="component-product-cell">
                      <strong>{{ row.component_name || row.name || row.code || `#${row.component_product_id}` }}</strong>
                      <span>
                        {{ [
                          row.inventory_category,
                          row.vehicle_brand,
                          row.fitment_type === "specific" ? row.vehicle_model : "通用",
                          row.accessory_name,
                          row.color
                        ].filter(Boolean).join(" / ") }}
                      </span>
                      <span>{{ row.code || row.inventory_id || `#${row.component_product_id}` }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="类型" width="130">
                <template #default="{ row }">
                  <el-select v-model="row.component_role">
                    <el-option label="固定组成" value="included" />
                    <el-option label="固定赠品" value="gift" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="数量" width="150">
                <template #default="{ row }">
                  <div class="component-qty-cell">
                    <el-input-number v-model="row.quantity" :min="0.0001" :precision="4" :step="1" controls-position="right" />
                    <span>{{ row.stock_unit || "个" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="可组成" width="110" align="right">
                <template #default="{ row }">{{ componentAvailable(row) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90" align="center">
                <template #default="{ row }">
                  <el-button link type="danger" @click="removeComponentProduct(row.component_product_id)">移除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div v-else class="composition-empty">未添加组成或赠品，当前按单品库存处理</div>
          </div>

          <div class="form-section preview-section">
            <div class="selection-preview-head">
              <div>
                <div class="form-section-title">预估模型</div>
                <span class="selection-preview-subtitle">当前填写内容会实时反推利润结果和费用拆解。</span>
              </div>
              <el-tag effect="plain">{{ previewNumbers.targetMode === "margin" ? "按利润率定价" : "按利润额定价" }}</el-tag>
            </div>

            <div class="selection-preview-compare">
              <div class="selection-preview-row">
                <div v-for="card in selectionPreviewCards" :key="card.label" class="selection-preview-card">
                  <span>{{ card.label }}</span>
                  <strong>{{ card.value }}</strong>
                  <small>{{ card.hint }}</small>
                </div>
              </div>
            </div>

          </div>
        </div>
        <aside class="similar-products-panel" v-loading="componentSearchActive ? componentLoading : similarProductsLoading">
          <div class="similar-products-head">
            <strong>{{ componentSearchActive ? '高匹配子产品' : '已有相似库存' }}</strong>
            <span>{{ componentSearchActive ? '随并列条件实时筛选，可直接添加为当前组成或赠品。' : '随建品字段实时检索，发现已有商品可直接使用。' }}</span>
          </div>
          <template v-if="componentSearchActive">
            <el-empty
              v-if="!componentOptions.length"
              description="当前条件下没有匹配的库存商品"
              :image-size="72"
            />
            <div v-else class="similar-product-list">
              <article v-for="row in pagedComponentOptions" :key="`component-${row.id}`" class="similar-product-card">
                <ProductImagePreview :src="row.image_url" size="square" />
                <div class="similar-product-body">
                  <strong>{{ row.name }}</strong>
                  <span>{{ row.inventory_id || row.code || `#${row.id}` }}</span>
                  <div class="similar-product-reasons">
                    <el-tag size="small" type="success" effect="light">核心品名匹配</el-tag>
                    <el-tag v-for="reason in componentMatchReasons(row)" :key="reason" size="small" effect="light">{{ reason }}匹配</el-tag>
                    <el-tag size="small" effect="plain">库存 {{ Number(row.stock || 0) }}</el-tag>
                  </div>
                  <el-button type="primary" plain size="small" @click="addComponentProduct(row)">
                    添加为{{ componentRole === 'gift' ? '固定赠品' : '固定组成' }}
                  </el-button>
                </div>
              </article>
            </div>
            <el-pagination
              v-if="componentOptions.length > componentPageSize"
              v-model:current-page="componentPage"
              class="component-result-pagination"
              background
              small
              layout="prev, pager, next, total"
              :page-size="componentPageSize"
              :total="componentOptions.length"
            />
          </template>
          <template v-else>
          <el-empty
            v-if="!similarProducts.length"
            :description="similarProductQuery ? '暂未发现相似库存' : '填写核心品名后开始检索'"
            :image-size="72"
          />
          <div v-else class="similar-product-list">
            <article v-for="row in similarProducts" :key="row.id" class="similar-product-card">
              <ProductImagePreview :src="row.image_url" size="square" />
              <div class="similar-product-body">
                <div class="similar-product-title">
                  <el-tag :type="row.similarity.level === 'duplicate' ? 'danger' : 'warning'" size="small" effect="light">
                    {{ row.similarity.levelLabel }} {{ row.similarity.score }}分
                  </el-tag>
                  <strong>{{ row.name }}</strong>
                </div>
                <span>{{ row.inventory_id || row.code || `#${row.id}` }}</span>
                <div class="similar-product-reasons">
                  <el-tag v-for="reason in row.similarity.matches" :key="reason" size="small" type="success" effect="light">{{ reason }}相同</el-tag>
                  <el-tag size="small" effect="plain">库存 {{ Number(row.stock || 0) }}</el-tag>
                </div>
                <span v-if="row.similarity.differences.length" class="similar-product-differences">
                  差异：{{ row.similarity.differences.join("、") }}
                </span>
                <el-button type="primary" plain size="small" @click="selectExistingProduct(row)">使用已有商品</el-button>
              </div>
            </article>
          </div>
          </template>
        </aside>
      </div>
    </el-form>

    <template #footer>
      <div class="erp-dialog-footer">
        <el-button class="erp-btn erp-btn-secondary" @click="closeDialog">取消</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" :loading="submitting" @click="submitDialog">保存</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.selection-form-dialog) {
  display: flex;
  flex-direction: column;
  height: 88vh;
  margin: 0 auto;
}

:global(.selection-form-dialog .el-dialog__header),
:global(.selection-form-dialog .el-dialog__footer) {
  flex: 0 0 auto;
}

:global(.selection-form-dialog .el-dialog__body) {
  flex: 1 1 auto;
  min-height: 0;
  padding-top: 10px;
  overflow: auto;
}

.standard-naming-section {
  border-color: #b8d3ee;
  background: #f8fbff;
}

.naming-section-head {
  align-items: flex-start;
  margin-bottom: 14px;
}

.naming-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 18px;
  align-items: stretch;
}

.naming-main-image {
  display: grid;
  grid-template-rows: auto 1fr auto;
  align-items: center;
  gap: 10px;
  min-height: 236px;
  padding: 12px;
  border: 1px solid #cfe0f2;
  border-radius: 10px;
  background: #fff;
}

.naming-main-image > strong {
  color: var(--erp-text);
  font-size: 13px;
}

.naming-main-image :deep(.erp-image-preview) {
  width: 168px;
  min-width: 168px;
  max-width: 168px;
  height: 224px;
  min-height: 224px;
  max-height: 224px;
  flex: 0 0 168px;
  justify-self: center;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
}

.naming-main-image :deep(.erp-image-preview__image),
.naming-main-image :deep(.erp-image-preview__empty) {
  width: 100%;
  height: 100%;
}

.naming-main-image__actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.naming-main-image__actions .el-button {
  margin-left: 0;
}

.form-section-subtitle {
  display: block;
  margin-top: -7px;
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.procurement-section :deep(.el-form-item) {
  display: block;
}

.procurement-section :deep(.el-form-item__label) {
  width: auto !important;
  height: 24px;
  padding: 0;
  line-height: 24px;
  justify-content: flex-start;
}

.procurement-section :deep(.el-form-item__content) {
  margin-left: 0 !important;
}

.procurement-section :deep(.el-input-number),
.procurement-section :deep(.el-select) {
  width: 100%;
}

.naming-fields-grid {
  display: grid;
  grid-template-columns: repeat(15, minmax(0, 1fr));
  gap: 12px 10px;
  align-content: start;
  margin: 0 !important;
}

.naming-fields-grid > .el-col {
  width: auto;
  max-width: none;
  padding: 0 !important;
}

.naming-field--primary {
  grid-column: span 5;
}

.naming-step-heading {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding-top: 8px !important;
  border-top: 1px solid var(--el-border-color-lighter);
}

.naming-step-heading:first-child { padding-top: 0 !important; border-top: 0; }
.naming-step-heading strong { color: var(--erp-text-primary); font-size: 14px; }
.naming-step-heading span { color: var(--erp-text-secondary); font-size: 12px; }
.ranked-naming-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ranked-naming-option small { color: var(--el-text-color-secondary); font-size: 11px; }
.naming-field--identity { grid-column: span 5; }
.naming-field--spec { grid-column: span 3; }
.naming-field--measure { grid-column: span 5; }
.standard-name-preview--top { margin: 0 0 14px; }

.naming-field--secondary {
  grid-column: span 3;
}

.naming-field--full {
  grid-column: 1 / -1;
}

.naming-fields-grid :deep(.el-form-item) {
  display: block;
  margin-bottom: 0;
}

.naming-fields-grid :deep(.el-form-item__label) {
  width: auto !important;
  height: 24px;
  padding: 0;
  line-height: 24px;
  justify-content: flex-start;
}

.naming-fields-grid :deep(.el-form-item__content) {
  margin-left: 0 !important;
}

.naming-fields-grid :deep(.el-select),
.naming-fields-grid :deep(.el-input),
.naming-fields-grid :deep(.el-radio-group) {
  width: 100%;
}

.vehicle-model-field {
  justify-self: stretch;
  width: auto !important;
}

.naming-quantity-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 68px;
  gap: 6px;
  width: 100%;
}

.core-name-option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.core-name-option > span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.core-name-option > small {
  color: var(--erp-text-secondary);
  font-size: 11px;
}

.core-name-option-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.core-name-option-actions .el-button {
  min-height: 22px;
  margin-left: 0;
  padding: 0 2px;
}

.standard-name-preview {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #cfe0f2;
  border-radius: 6px;
  background: #fff;
}

.standard-name-preview span {
  color: #64748b;
  font-size: 12px;
}

.standard-name-preview strong {
  color: #0f172a;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.selection-workbench.has-similar-products {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(340px, 1fr);
  gap: 16px;
  align-items: start;
}

.selection-workbench-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.standard-naming-section {
  order: 1;
  grid-column: 1 / -1;
}

.composition-section {
  order: 2;
  grid-column: 1 / -1;
}

.composition-launch-section {
  order: 2;
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.composition-launch-section > div {
  display: grid;
  gap: 4px;
}

.composition-launch-section span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.color-editor {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(150px, 0.85fr);
  gap: 8px;
  width: 100%;
}

.basic-info-section {
  order: 3;
}

.procurement-section {
  order: 3;
}

.pricing-section {
  order: 4;
  grid-column: 1 / -1;
}

.preview-section {
  order: 5;
  grid-column: 1 / -1;
}

.similar-products-panel {
  position: sticky;
  top: 0;
  max-height: calc(88vh - 138px);
  padding: 14px;
  overflow: auto;
  border: 1px solid var(--erp-border);
  border-radius: 12px;
  background: var(--erp-surface-alt);
}

.similar-products-head,
.similar-product-body {
  display: grid;
  gap: 5px;
}

.similar-products-head {
  margin-bottom: 12px;
}

.similar-products-head span,
.similar-product-body > span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.similar-product-list {
  display: grid;
  gap: 10px;
}

.component-result-pagination {
  position: sticky;
  bottom: -14px;
  z-index: 2;
  justify-content: center;
  margin: 12px -14px -14px;
  padding: 10px 6px;
  border-top: 1px solid var(--erp-border);
  background: var(--erp-surface-alt);
}

.similar-product-card {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--erp-border);
  border-radius: 10px;
  background: var(--erp-surface);
}

.similar-product-body > strong {
  font-size: 13px;
  line-height: 1.4;
}

.similar-product-title {
  display: grid;
  gap: 5px;
}

.similar-product-title > strong {
  font-size: 13px;
  line-height: 1.4;
}

.similar-product-reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.similar-product-differences {
  color: var(--erp-warning);
  line-height: 1.4;
}

@media (max-width: 1100px) {
  .selection-workbench.has-similar-products {
    grid-template-columns: 1fr;
  }

  .similar-products-panel {
    position: static;
    max-height: 420px;
  }
}

.form-section {
  padding: 12px 14px 2px;
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

.selection-image-preview-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: 12px;
  background: var(--erp-surface);
}

.selection-image-preview-meta {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.selection-image-preview-meta strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--erp-text);
}

.selection-image-preview-meta span {
  font-size: 12px;
  color: var(--erp-text-secondary);
}

.form-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.form-section-head .form-section-title {
  margin-bottom: 12px;
}

.product-type-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
}

.composition-help {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -4px 0 12px;
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.composition-empty {
  padding: 10px 12px;
  border: 1px dashed var(--erp-border);
  border-radius: 8px;
  color: var(--erp-text-secondary);
  font-size: 12px;
  text-align: center;
}

.composition-help strong {
  color: var(--erp-success);
  white-space: nowrap;
}

.component-picker-row {
  margin-bottom: 12px;
}

.component-picker-row {
  display: grid;
  grid-template-columns: 130px minmax(280px, 1fr) auto;
  gap: 10px;
}

.component-directory {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px;
  border: 1px solid #cfe0f2;
  border-radius: 10px;
  background: #f8fbff;
}

.component-directory-path {
  display: flex;
  align-items: center;
  gap: 10px;
}

.component-directory-path span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.component-directory-selects {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

@media (max-width: 760px) {
  .component-picker-row {
    grid-template-columns: 1fr;
  }
}

.component-product-cell {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.component-product-cell > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.component-product-cell strong,
.component-product-cell span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.component-product-cell span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.component-qty-cell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.component-qty-cell span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.product-composition-table {
  margin-bottom: 10px;
}

.component-product-with-image {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.component-product-with-image :deep(.product-image-preview) {
  flex: 0 0 auto;
}

.selection-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.selection-preview-subtitle {
  display: block;
  margin-top: -4px;
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.selection-preview-compare {
  display: grid;
  gap: 12px;
  margin-bottom: 12px;
}

.selection-preview-row {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}

.selection-preview-compare {
  grid-template-columns: 1fr;
}

.selection-preview-card {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: 12px;
  background: var(--erp-surface);
}

.selection-preview-card span,
.selection-preview-card small {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.selection-preview-card strong {
  color: var(--erp-text);
  font-size: 20px;
  line-height: 1.2;
}

.selection-detail-title {
  margin-bottom: 10px;
  font-size: 13px;
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

@media (max-width: 960px) {
  .selection-preview-row {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
