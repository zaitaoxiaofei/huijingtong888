<script setup>
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import ProductImagePreview from "../ProductImagePreview.vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  mode: { type: String, default: "create" },
  target: { type: String, default: "selection" },
  people: { type: Array, default: () => [] },
  suppliers: { type: Array, default: () => [] },
  logisticsRules: { type: Array, default: () => [] },
  value: { type: Object, default: null }
});

const emit = defineEmits(["update:visible", "saved"]);

const formRef = ref();
const imageUploadLoading = ref(false);
const submitting = ref(false);
const manualLogisticsRule = ref(false);
const manualPackagingFee = ref(false);

const formRules = {
  name: [{ required: true, message: "请输入商品名称", trigger: "blur" }],
  owner_person_id: [{ required: true, message: "请选择负责人", trigger: "change" }],
  purchase_quantity: [{ required: true, message: "请输入采购数量", trigger: "blur" }]
};

const form = reactive(createDefaultForm());

const isInventoryTarget = computed(() => props.target === "inventory");
const isEditMode = computed(() => props.mode === "edit");
const dialogTitle = computed(() => {
  if (isEditMode.value) return isInventoryTarget.value ? "编辑库存商品" : "编辑选品";
  return isInventoryTarget.value ? "新增库存商品" : "新增选品";
});

const logisticsRuleOptions = computed(() => [...(props.logisticsRules || [])].sort((a, b) => {
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
const selectionPreviewRows = computed(() => [
  { label: "采购均摊成本", value: money(getPurchaseCostPerUnit(form)), note: "已含采购单价、国内运费均摊和处理费" },
  { label: "物流费用", value: money(previewNumbers.value.transport.totalRmb), note: selectedLogisticsRule.value?.name || "-" },
  { label: "佣金", value: money(previewNumbers.value.commission), note: `${percentText(getCommissionRate(previewNumbers.value.listingPriceRub || 0) * 100, 1)}` },
  { label: "末公里+银行", value: money(previewNumbers.value.finalMile), note: "按当前售价计算" },
  { label: "提现费", value: money(previewNumbers.value.withdrawal), note: "按当前售价与运费计算" },
  { label: "广告预算", value: money(previewNumbers.value.advertising), note: percentText(Number(form.advertising_rate || 0), 1) },
  { label: "退货损失", value: money(previewNumbers.value.returnLoss), note: `退货率 ${percentText(Number(form.return_rate || 0), 1)}` },
  { label: "净利润", value: money(previewNumbers.value.profit), note: `净利率 ${percentText(previewNumbers.value.margin, 1)}` }
]);
const selectionPreviewCards = computed(() => [
  { label: "当前售价", value: `¥${money(previewNumbers.value.saleRmb)}`, hint: "手动填写优先" },
  { label: "净利润率", value: percentText(previewNumbers.value.margin, 1), hint: "按当前售价计算" },
  { label: "净利润", value: `¥${money(previewNumbers.value.profit)}`, hint: "扣除全部费用后" },
  { label: "建议售价", value: `¥${money(previewNumbers.value.suggestedSaleRmb)}`, hint: previewNumbers.value.targetMode === "margin" ? "按利润率反推" : "按利润额反推" },
  { label: "目标利润率", value: percentText(previewNumbers.value.targetMargin, 1), hint: "模型目标值" },
  { label: "目标利润额", value: `¥${money(previewNumbers.value.targetProfit)}`, hint: "按当前售价换算" }
]);
const selectionPreviewCurrentRow = computed(() => selectionPreviewCards.value.slice(0, 3));
const selectionPreviewSuggestedRow = computed(() => selectionPreviewCards.value.slice(3, 6));

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
    product_type: "selection",
    selection_status: "draft"
  };
}

function resetForm() {
  Object.assign(form, createDefaultForm());
  form.owner_person_id = props.people[0]?.id || "";
  form.product_type = isInventoryTarget.value ? "main" : "selection";
  form.selection_status = isInventoryTarget.value ? "listed" : "draft";
  const nextRule = resolveSelectedLogisticsRule(form);
  form.logistics_rule_id = nextRule?.id || "";
  form.shipping_method = nextRule?.channel || "air_land";
  manualLogisticsRule.value = false;
  manualPackagingFee.value = false;
  syncPackagingFee(form);
}

function fillFormFromValue(value = {}) {
  resetForm();
  Object.assign(form, {
    ...createDefaultForm(),
    ...value,
    supplier_id: value.supplier_id || "",
    owner_person_id: value.owner_person_id || props.people[0]?.id || "",
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
    product_type: value.product_type || (isInventoryTarget.value ? "main" : "selection"),
    selection_status: value.selection_status || (isInventoryTarget.value ? "listed" : "draft")
  });
  manualLogisticsRule.value = Boolean(value.logistics_rule_id);
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
    return props.logisticsRules.find((item) => Number(item.id) === Number(row.logistics_rule_id)) || null;
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

async function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function handleImageUpload(file) {
  const rawFile = file;
  if (!rawFile) return false;
  imageUploadLoading.value = true;
  try {
    const dataUrl = await readImageAsDataUrl(rawFile);
    form.image_url = dataUrl;
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
  await formRef.value.validate();
  submitting.value = true;
  try {
    const payload = {
      ...form,
      supplier_id: form.supplier_id || null,
      owner_person_id: Number(form.owner_person_id || 0) || null,
      logistics_rule_id: Number(form.logistics_rule_id || 0) || null,
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
      selection_status: isEditMode.value ? form.selection_status || "draft" : (isInventoryTarget.value ? "listed" : "draft"),
      product_type: isEditMode.value ? form.product_type || "selection" : (isInventoryTarget.value ? "main" : "selection")
    };
    if (isEditMode.value) {
      await apiClient.put(`/api/products/${form.id}`, payload);
    } else {
      await apiClient.post("/api/products", payload);
    }
    emit("saved", { mode: props.mode, target: props.target });
    emit("update:visible", false);
  } catch (error) {
    ElMessage.error(error.message || "保存失败");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="dialogTitle"
    width="1180px"
    align-center
    destroy-on-close
    class="selection-form-dialog erp-centered-dialog"
    @closed="formRef?.clearValidate?.()"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-form ref="formRef" :model="form" :rules="formRules" label-width="112px">
      <div class="selection-workbench">
        <div class="selection-workbench-main">
          <div class="form-section">
            <div class="form-section-title">基础信息</div>
            <el-row :gutter="18">
              <el-col :span="12">
                <el-form-item label="商品名称" prop="name">
                  <el-input v-model="form.name" placeholder="请输入商品名称" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="负责人" prop="owner_person_id">
                  <el-select v-model="form.owner_person_id" placeholder="请选择负责人">
                    <el-option v-for="person in people" :key="person.id" :label="person.name" :value="person.id" />
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
                <el-form-item label="图片上传">
                  <el-upload :show-file-list="false" :auto-upload="false" accept="image/*" :on-change="handleImageUploadChange">
                    <el-button class="erp-btn erp-btn-secondary" :loading="imageUploadLoading">上传本地图片</el-button>
                  </el-upload>
                  <el-button class="erp-btn-link-danger" v-if="form.image_url" link type="danger" @click="clearUploadedImage">清除</el-button>
                </el-form-item>
              </el-col>
              <el-col :span="24">
                <div class="selection-image-preview-row">
                  <ProductImagePreview :src="form.image_url" size="square" />
                  <div class="selection-image-preview-meta">
                    <strong>商品主图</strong>
                    <span>{{ form.image_url ? "点击缩略图可预览" : "未上传图片" }}</span>
                  </div>
                </div>
              </el-col>
            </el-row>
          </div>

          <div class="form-section">
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

          <div class="form-section">
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

          <div class="form-section">
            <div class="selection-preview-head">
              <div>
                <div class="form-section-title">预估模型</div>
                <span class="selection-preview-subtitle">当前填写内容会实时反推利润结果和费用拆解。</span>
              </div>
              <el-tag effect="plain">{{ previewNumbers.targetMode === "margin" ? "按利润率定价" : "按利润额定价" }}</el-tag>
            </div>

            <div class="selection-preview-compare">
              <div class="selection-preview-row">
                <div v-for="card in selectionPreviewCurrentRow" :key="card.label" class="selection-preview-card">
                  <span>{{ card.label }}</span>
                  <strong>{{ card.value }}</strong>
                  <small>{{ card.hint }}</small>
                </div>
              </div>
              <div class="selection-preview-row selection-preview-row--suggested">
                <div v-for="card in selectionPreviewSuggestedRow" :key="card.label" class="selection-preview-card">
                  <span>{{ card.label }}</span>
                  <strong>{{ card.value }}</strong>
                  <small>{{ card.hint }}</small>
                </div>
              </div>
            </div>

            <div class="selection-detail-title">费用明细</div>
            <el-table :data="selectionPreviewRows" border class="erp-data-table selection-preview-table" max-height="320">
              <el-table-column prop="label" label="项目" width="140" />
              <el-table-column prop="value" label="金额" width="120" align="right" />
              <el-table-column prop="note" label="说明" min-width="180" />
            </el-table>
          </div>
        </div>
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.selection-preview-row--suggested {
  padding-top: 2px;
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
