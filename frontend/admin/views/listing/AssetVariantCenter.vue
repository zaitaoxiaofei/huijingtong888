<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  Delete,
  Download,
  Picture,
  Refresh,
  Switch,
  UploadFilled,
  VideoCamera,
  View,
  ZoomIn
} from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { uploadListingMedia, withImageToken } from "../../api/tools/imageCropper";

const VIDEO_DURATION = 8;
const VIDEO_GENERATE_CONCURRENCY = 4;
const loading = ref(false);
const generating = ref(false);
const videoGenerating = ref(false);
const importing = ref(false);
const syncingCategories = ref(false);
const mediaAssetLoading = ref(false);
const route = useRoute();
const router = useRouter();
const detailDragIndex = ref(null);
const detailDragOverIndex = ref(null);
const detailReplaceIndex = ref(-1);
const folderInputRef = ref(null);
const detailReplaceInputRef = ref(null);
const titleRegenerating = reactive({});
const videoStatus = reactive({ current: "", done: 0, total: 0 });
const autoGenerateStarted = ref(false);

const previewDialog = reactive({ visible: false, url: "", type: "image", title: "素材预览" });
const packageDialog = reactive({ visible: false, variant: null });
const tailTemplateDialog = reactive({
  visible: false,
  saving: false,
  shopId: "",
  category: "通用汽车用品",
  vehicleModel: "通用车型",
  name: "",
  image: "",
  imageName: "",
  isDefault: true
});

const state = reactive({
  shops: [],
  watermarkTemplates: [],
  tailCategories: [],
  vehicleModels: [],
  vehicleModelOptions: [],
  ozonCategories: [],
  tailTemplates: [],
  titleStyles: [],
  mainImagePlans: [],
  selectedShopIds: [],
  selectedShopId: "",
  rules: {},
  titlePreviews: {},
  variants: [],
  batchId: "",
  outputDir: "",
  localOutputDir: "",
  importedSets: [],
  mediaAssets: [],
  sourceProduct: null
});

const material = reactive({
  title: "",
  tags: "",
  description: "",
  quantity: "",
  color: "",
  material: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  weightG: "",
  mainImage: null,
  detailImages: []
});

const selectedShops = computed(() => state.shops.filter((shop) => state.selectedShopIds.includes(shop.id)));
const selectedShop = computed(() => state.shops.find((shop) => Number(shop.id) === Number(state.selectedShopId)) || selectedShops.value[0] || null);
const selectedRule = computed(() => selectedShop.value ? state.rules[selectedShop.value.id] : null);
const selectedVariant = computed(() => state.variants.find((variant) => Number(variant.shopId) === Number(selectedShop.value?.id)) || null);
const canGenerate = computed(() => Boolean(material.title && material.mainImage?.url && selectedShops.value.length));
const enabledShopCount = computed(() => state.selectedShopIds.length);
const detailStatusText = computed(() => `${material.detailImages.length} 张详情图`);
const mainUploadStatus = computed(() => (material.mainImage?.url ? "已上传" : "待上传"));

async function loadBootstrap() {
  loading.value = true;
  try {
    const data = await apiClient.get("/api/asset-variant-engine/bootstrap", { noCache: true });
    state.shops = (data.shops || []).map((shop) => ({
      id: Number(shop.id),
      name: shop.name,
      status: shop.status,
      watermarkPath: shop.watermark_path || shop.watermarkPath,
      rule: shop.rule || {}
    }));
    state.watermarkTemplates = data.watermarkTemplates || [];
    state.tailCategories = data.tailCategories?.length ? data.tailCategories : ["通用汽车用品"];
    state.vehicleModels = data.vehicleModels?.length ? data.vehicleModels : ["通用车型"];
    state.ozonCategories = data.ozonCategories || [];
    state.vehicleModelOptions = data.vehicleModelOptions || [];
    state.tailTemplates = (data.tailTemplates || []).map((item) => ({
      ...item,
      imageUrl: withImageToken(item.imageUrl)
    }));
    state.titleStyles = data.titleStyles?.length ? data.titleStyles : [
      { value: "traffic", label: "搜索流量型" },
      { value: "material", label: "材质卖点型" },
      { value: "scenario", label: "场景适配型" },
      { value: "value", label: "性价比型" },
      { value: "premium", label: "高端质感型" }
    ];
    state.mainImagePlans = data.mainImagePlans || [];
    state.selectedShopIds = state.shops.filter((shop) => shop.status !== "deleted").map((shop) => shop.id);
    if (!state.selectedShopId && state.selectedShopIds.length) state.selectedShopId = state.selectedShopIds[0];
    const initialRules = {};
    state.shops.forEach((shop, index) => {
      const defaultStyle = state.titleStyles[index % state.titleStyles.length]?.value || "traffic";
      initialRules[shop.id] = {
        titleStyle: shop.rule?.titleStyle || defaultStyle,
        watermarkTemplateId: shop.rule?.watermarkTemplateId || (shop.watermarkPath ? `shop-${shop.id}` : ""),
        tailCategory: shop.rule?.tailCategory || state.tailCategories[0] || "通用汽车用品",
        vehicleModel: shop.rule?.vehicleModel || state.vehicleModels[0] || "通用车型",
        tailTemplateId: shop.rule?.tailTemplateId || "",
        mainImagePlan: shop.rule?.mainImagePlan || "watermarked"
      };
    });
    const styles = Object.values(initialRules).map((rule) => rule.titleStyle);
    const shouldDistributeStyles = styles.length > 1 && styles.every((style) => style === styles[0]);
    for (const [index, shop] of state.shops.entries()) {
      state.rules[shop.id] = {
        ...initialRules[shop.id],
        titleStyle: shouldDistributeStyles
          ? state.titleStyles[index % state.titleStyles.length]?.value || initialRules[shop.id].titleStyle
          : initialRules[shop.id].titleStyle
      };
    }
    await loadMediaAssets();
  } catch (error) {
    ElMessage.error(error.message || "素材裂变配置加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadMediaAssets() {
  mediaAssetLoading.value = true;
  try {
    state.mediaAssets = await apiClient.get("/api/listing/media/assets?limit=120", { noCache: true });
  } catch (error) {
    console.warn("listing media assets load failed", error);
  } finally {
    mediaAssetLoading.value = false;
  }
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

async function imageMetaFromFile(file) {
  const url = await fileToDataUrl(file);
  const meta = await imageSize(url).catch(() => ({ width: 0, height: 0 }));
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    size: file.size,
    width: meta.width,
    height: meta.height,
    url,
    status: "已上传"
  };
}

function displayJoin(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" / ");
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).join(" / ");
  } catch {
    // Keep plain text values as-is.
  }
  return text;
}

function cleanMetricValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const number = Number(text);
  if (!Number.isFinite(number)) return text;
  return String(Math.round(number));
}

function normalizeSourceImageList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    // Fall through to delimiter parsing.
  }
  return text.split(/\r\n|[,，]+/).map((item) => item.trim()).filter(Boolean);
}

function previewUrlForSourceImage(url) {
  const text = String(url || "").trim();
  if (!text || /^data:/i.test(text) || /^blob:/i.test(text)) return text;
  return withImageToken(text);
}

async function imageMetaFromUrl(url, fallbackName) {
  const previewUrl = previewUrlForSourceImage(url);
  if (!previewUrl) return null;
  const meta = await imageSize(previewUrl).catch(() => ({ width: 0, height: 0 }));
  const filename = /^data:/i.test(String(url || ""))
     fallbackName
    : String(url).split(/[\\/]/).pop().split("")[0] || fallbackName;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: filename || fallbackName,
    size: 0,
    width: meta.width,
    height: meta.height,
    url: previewUrl,
    status: "已导入"
  };
}

function imageSize(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = url;
  });
}

async function onMainImageChange(file) {
  material.mainImage = await imageMetaFromFile(file.raw);
}

async function onDetailImagesChange(file) {
  material.detailImages.push(await imageMetaFromFile(file.raw));
}

function removeMainImage() {
  material.mainImage = null;
}

function removeDetailImage(index) {
  material.detailImages.splice(index, 1);
}

function requestDetailReplace(index) {
  detailReplaceIndex.value = index;
  detailReplaceInputRef.value?.click();
}

async function onDetailReplaceInput(event) {
  const file = event.target.files?.[0];
  if (file && detailReplaceIndex.value >= 0) {
    material.detailImages.splice(detailReplaceIndex.value, 1, await imageMetaFromFile(file));
  }
  event.target.value = "";
  detailReplaceIndex.value = -1;
}

function onDetailDragStart(index, event) {
  detailDragIndex.value = index;
  detailDragOverIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }
}

function onDetailDragEnter(index) {
  if (detailDragIndex.value === null) return;
  detailDragOverIndex.value = index;
}

function onDetailDrop(index, event) {
  event?.preventDefault?.();
  const from = detailDragIndex.value ?? Number(event?.dataTransfer?.getData("text/plain"));
  if (!Number.isInteger(from) || from < 0 || from >= material.detailImages.length) {
    resetDetailDrag();
    return;
  }
  if (from === index) {
    resetDetailDrag();
    return;
  }
  const [item] = material.detailImages.splice(from, 1);
  const targetIndex = from < index ? index - 1 : index;
  material.detailImages.splice(targetIndex, 0, item);
  resetDetailDrag();
}

function resetDetailDrag() {
  detailDragIndex.value = null;
  detailDragOverIndex.value = null;
}

function openFolderPicker() {
  folderInputRef.value?.click();
}

async function onFolderImport(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;
  const sets = await parseMaterialFolder(files);
  state.importedSets = sets;
  if (sets[0]) applyImportedSet(sets[0]);
  ElMessage.success(`已识别 ${sets.length} 套原始素材`);
}

async function parseMaterialFolder(files) {
  const groups = new Map();
  for (const file of files) {
    const relative = file.webkitRelativePath || file.name;
    const parts = relative.split("/").filter(Boolean);
    const numericIndex = parts.findIndex((part) => /^\d+$/.test(part));
    const key = numericIndex >= 0 ? parts.slice(0, numericIndex + 1).join("/") : parts.slice(0, -1).join("/") || "素材";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  const sets = [];
  for (const [key, groupFiles] of groups.entries()) {
    const imageFiles = groupFiles.filter((file) => file.type.startsWith("image/"));
    const textFiles = groupFiles.filter((file) => /\.(txt|md)$/i.test(file.name));
    const mainFile = imageFiles.find((file) => /(^|[-_])(main|cover|primary|主图)([-_.]|$)/i.test(file.name)) || imageFiles[0];
    const detailFiles = imageFiles.filter((file) => file !== mainFile).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    const titleFile = textFiles.find((file) => /title|标题/i.test(file.name));
    const tagsFile = textFiles.find((file) => /tags|标签/i.test(file.name));
    const descriptionFile = textFiles.find((file) => /description|desc|描述|详情文案/i.test(file.name));
    sets.push({
      key,
      title: titleFile ? (await titleFile.text()).trim() : "",
      tags: tagsFile ? (await tagsFile.text()).trim() : "",
      description: descriptionFile ? (await descriptionFile.text()).trim() : "",
      mainImage: mainFile ? await imageMetaFromFile(mainFile) : null,
      detailImages: await Promise.all(detailFiles.map(imageMetaFromFile))
    });
  }
  return sets.sort((a, b) => a.key.localeCompare(b.key, "zh-Hans-CN", { numeric: true }));
}

function applyImportedSet(set) {
  material.title = set.title || material.title;
  material.tags = set.tags || material.tags;
  material.description = set.description || material.description;
  material.quantity = set.quantity || material.quantity;
  material.color = set.color || material.color;
  material.material = set.material || material.material;
  material.lengthCm = set.lengthCm || material.lengthCm;
  material.widthCm = set.widthCm || material.widthCm;
  material.heightCm = set.heightCm || material.heightCm;
  material.weightG = set.weightG || material.weightG;
  material.mainImage = set.mainImage || material.mainImage;
  material.detailImages = set.detailImages || [];
}

function selectionProductMainImage(product) {
  return product.image_url || product.imageUrl || product.primary_image || (product.id ? `/api/products/${product.id}/image` : "");
}

async function applySelectionProduct(product) {
  if (!product.id) return;
  const mainImage = selectionProductMainImage(product);
  const detailImages = normalizeSourceImageList(product.detail_image_urls || product.detailImageUrls);

  material.title = product.name || product.product_name || material.title;
  material.color = displayJoin(product.color) || material.color;
  material.material = displayJoin(product.material) || material.material;
  material.quantity = product.purchase_quantity ? `${product.purchase_quantity} 件` : material.quantity;
  material.lengthCm = cleanMetricValue(product.length_cm ?? product.lengthCm ?? material.lengthCm);
  material.widthCm = cleanMetricValue(product.width_cm ?? product.widthCm ?? material.widthCm);
  material.heightCm = cleanMetricValue(product.height_cm ?? product.heightCm ?? material.heightCm);
  material.weightG = cleanMetricValue(product.package_weight_g ?? product.weight_g ?? product.weightG ?? material.weightG);
  material.description = product.selling_points || product.supplier_note || material.description;
  material.tags = material.tags || "";

  const nextMainImage = await imageMetaFromUrl(mainImage, "选品主图");
  if (nextMainImage) material.mainImage = nextMainImage;
  if (detailImages.length) {
    material.detailImages = (await Promise.all(
      detailImages.map((url, index) => imageMetaFromUrl(url, `详情图 ${index + 1}`))
    )).filter(Boolean);
  }

  state.sourceProduct = {
    id: product.id,
    code: product.code,
    selectionId: product.selection_id,
    name: product.name || product.product_name || ""
  };
}

async function loadSelectionSourceFromRoute() {
  const productId = Number(route.query.productId || 0);
  if (!productId || route.query.source !== "selection") return;
  try {
    const product = await apiClient.get(`/api/products/${productId}`, { noCache: true });
    await applySelectionProduct(product);
    ElMessage.success("已从选品计价表带入主图、详情图和产品信息");
    await nextTick();
    if (route.query.autoGenerate === "1" && !autoGenerateStarted.value) {
      autoGenerateStarted.value = true;
      await generateAllShops();
      await nextTick();
      document.querySelector(".step-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      document.querySelector(".rule-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    ElMessage.error(error.message || "从选品计价表带入失败");
  }
}

function buildGeneratePayload(shopIds = state.selectedShopIds) {
  const shops = state.shops.filter((shop) => shopIds.includes(shop.id));
  return {
    material: {
      title: material.title,
      tags: material.tags,
      description: material.description,
      quantity: material.quantity,
      color: material.color,
      material: material.material,
      lengthCm: material.lengthCm,
      widthCm: material.widthCm,
      heightCm: material.heightCm,
      weightG: material.weightG,
      mainImage: material.mainImage?.url || "",
      detailImages: material.detailImages.map((image) => image.url)
    },
    shopIds,
    rules: shops.map((shop) => ({ shopId: shop.id, ...state.rules[shop.id] }))
  };
}

async function generateVariants(shopIds = state.selectedShopIds) {
  if (!material.title || !material.mainImage?.url) {
    ElMessage.warning("请先填写标题并上传主图");
    return;
  }
  if (!shopIds.length) {
    ElMessage.warning("请至少启用一个店铺");
    return;
  }
  generating.value = true;
  try {
    const result = await apiClient.post("/api/asset-variant-engine/generate", buildGeneratePayload(shopIds));
    const nextVariants = (result.variants || []).map(normalizeVariant);
    const nextShopIds = new Set(nextVariants.map((variant) => Number(variant.shopId)));
    state.variants = [
      ...state.variants.filter((variant) => !nextShopIds.has(Number(variant.shopId))),
      ...nextVariants
    ];
    state.batchId = result.batchId || state.batchId;
    state.outputDir = result.outputDir || state.outputDir;
    state.localOutputDir = result.localOutputDir || state.localOutputDir;
    await loadMediaAssets();
    if (nextVariants[0]) state.selectedShopId = nextVariants[0].shopId;
    await generateVideosForVariants(nextVariants, { silent: true });
    ElMessage.success(`已生成 ${nextVariants.length} 个店铺素材包，并自动生成视频`);
  } finally {
    generating.value = false;
  }
}

function normalizeVariant(variant) {
  if (variant.shopId) {
    state.titlePreviews[variant.shopId] = {
      titleRu: variant.titleRu || variant.title || "",
      titleZh: variant.titleZh || variant.productInfo?.titleZh || ""
    };
  }
  return {
    ...variant,
    previewUrl: withImageToken(variant.previewUrl),
    listingUrl: withImageToken(variant.listingUrl),
    listingJsonUrl: withImageToken(variant.listingJsonUrl),
    productInfoUrl: withImageToken(variant.productInfoUrl),
    productInfoXlsxUrl: withImageToken(variant.productInfoXlsxUrl),
    images: (variant.images || []).map((image) => ({ ...image, previewUrl: withImageToken(image.previewUrl) })),
    videos: normalizeVariantVideos(variant.videos || variant.videoUrls || [])
  };
}

function normalizeVariantVideos(videos) {
  return (Array.isArray(videos) ? videos : []).map((video, index) => ({
    id: video.id || `video-${Date.now().toString(36)}-${index}`,
    name: video.name || `shop-video-${index + 1}.webm`,
    url: withImageToken(video.url || video.localUrl || video.previewUrl || ""),
    previewUrl: withImageToken(video.previewUrl || video.url || video.localUrl || ""),
    localUrl: video.localUrl || "",
    publishUrl: video.publishUrl || video.url || "",
    size: Number(video.size || 0),
    contentType: video.contentType || "video/webm"
  })).filter((video) => video.url || video.previewUrl);
}

function titlePreviewFor(shop) {
  const variant = state.variants.find((item) => Number(item.shopId) === Number(shop.id));
  if (variant) {
    return {
      titleRu: variant.titleRu || variant.title || "",
      titleZh: variant.titleZh || variant.productInfo?.titleZh || ""
    };
  }
  return state.titlePreviews[shop.id] || { titleRu: "", titleZh: "" };
}

async function regenerateTitle(shop) {
  if (!material.title) {
    ElMessage.warning("请先填写原始标题");
    return;
  }
  titleRegenerating[shop.id] = true;
  try {
    const result = await apiClient.post("/api/asset-variant-engine/title-preview", {
      material: {
        title: material.title,
        tags: material.tags,
        description: material.description,
        quantity: material.quantity,
        color: material.color,
        material: material.material,
        lengthCm: material.lengthCm,
        widthCm: material.widthCm,
        heightCm: material.heightCm,
        weightG: material.weightG
      },
      shopId: shop.id,
      rule: state.rules[shop.id]
    });
    state.titlePreviews[shop.id] = {
      titleRu: result.titleRu || result.title || "",
      titleZh: result.titleZh || ""
    };
    const variant = state.variants.find((item) => Number(item.shopId) === Number(shop.id));
    if (variant) {
      variant.title = result.title || result.titleRu || variant.title;
      variant.titleRu = result.titleRu || result.title || "";
      variant.titleZh = result.titleZh || "";
      if (variant.productInfo) {
        variant.productInfo.title = variant.title;
        variant.productInfo.titleRu = variant.titleRu;
        variant.productInfo.titleZh = variant.titleZh;
      }
    }
    ElMessage.success(`${shop.name} title regenerated`);
  } finally {
    titleRegenerating[shop.id] = false;
  }
}

function generateCurrentShop() {
  if (!selectedShop.value) return;
  return generateVariants([selectedShop.value.id]);
}

function generateAllShops() {
  return generateVariants(state.selectedShopIds);
}

async function generateVideosForAllShops() {
  if (!state.variants.length) {
    ElMessage.warning("请先生成素材包");
    return;
  }
  await generateVideosForVariants(state.variants);
}

async function generateVideosForVariants(variants, options = {}) {
  const targetVariants = (Array.isArray(variants) ? variants : []).filter(Boolean);
  if (!targetVariants.length) return;
  videoGenerating.value = true;
  videoStatus.done = 0;
  videoStatus.total = targetVariants.length;
  videoStatus.current = "";
  const failures = [];
  try {
    await mapWithConcurrency(targetVariants, VIDEO_GENERATE_CONCURRENCY, async (variant) => {
      videoStatus.current = variant.shopName || `Shop ${variant.shopId}`;
      try {
        await generateVideoForVariant(variant);
        videoStatus.done += 1;
      } catch (error) {
        failures.push(`${variant.shopName || variant.shopId}: ${error.message || "视频生成失败"}`);
        variant.videoError = error.message || "视频生成失败";
      }
    });
    if (failures.length) {
      ElMessage.warning(`已生成 ${videoStatus.done} 个视频，${failures.length} 个失败：${failures[0]}`);
    } else if (!options.silent) {
      ElMessage.success(`已生成 ${videoStatus.done} 个店铺视频`);
    }
  } finally {
    videoGenerating.value = false;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency || 1));
  let cursor = 0;
  async function runNext() {
    const index = cursor;
    cursor += 1;
    if (index >= list.length) return;
    await worker(list[index], index);
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, runNext));
}

async function generateVideoForSelectedShop() {
  if (!selectedVariant.value) {
    ElMessage.warning("请先生成当前店铺素材包");
    return;
  }
  videoGenerating.value = true;
  videoStatus.done = 0;
  videoStatus.total = 1;
  videoStatus.current = selectedVariant.value.shopName || "";
  try {
    await generateVideoForVariant(selectedVariant.value);
    videoStatus.done = 1;
    ElMessage.success(`${selectedVariant.value.shopName || "店铺"} 视频已生成`);
  } catch (error) {
    ElMessage.error(error.message || "视频生成失败");
  } finally {
    videoGenerating.value = false;
  }
}

async function generateVideoForVariant(variant) {
  const shop = state.shops.find((item) => Number(item.id) === Number(variant.shopId));
  const imageUrl = imagesByType(variant, "main")[0]?.previewUrl || material.mainImage?.url;
  if (!imageUrl) throw new Error("请先准备主图");
  const watermark = shop ? watermarkTemplateFor(shop) : null;
  const logoUrl = watermarkPreviewUrl(watermark);
  const image = await loadVideoImage(imageUrl);
  const logo = logoUrl ? await loadVideoImage(logoUrl).catch(() => null) : null;
  const blob = await renderShopVideo({ image, logo, watermark });
  const name = buildShopVideoName(variant);
  const objectUrl = URL.createObjectURL(blob);
  variant.videos = [{
    id: `video-${variant.id || variant.shopId}-${Date.now().toString(36)}`,
    name,
    url: objectUrl,
    previewUrl: objectUrl,
    localUrl: objectUrl,
    publishUrl: "",
    size: blob.size,
    contentType: blob.type || "video/webm",
    downloadUrl: objectUrl
  }];
  try {
    const file = new File([blob], name, { type: blob.type || "video/webm" });
    const uploaded = await uploadListingMedia(file);
    variant.videos[0] = {
      ...variant.videos[0],
      url: withImageToken(uploaded.previewUrl || uploaded.localUrl || uploaded.url || objectUrl),
      previewUrl: withImageToken(uploaded.previewUrl || uploaded.localUrl || objectUrl),
      localUrl: uploaded.localUrl || objectUrl,
      publishUrl: uploaded.publishUrl || uploaded.url || "",
      size: uploaded.size || blob.size,
      contentType: uploaded.contentType || blob.type || "video/webm"
    };
    await loadMediaAssets();
  } catch (error) {
    variant.videoError = `视频已生成本地预览，但上传素材库失败：${error.message || error}`;
  }
  return variant.videos[0];
}

async function renderShopVideo({ image, logo, watermark }) {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder === "undefined") {
      reject(new Error("当前浏览器不支持 MediaRecorder 视频录制"));
      return;
    }
    const width = 900;
    const height = 1200;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const fps = 30;
    const durationMs = VIDEO_DURATION * 1000;
    if (typeof canvas.captureStream !== "function") {
      reject(new Error("当前浏览器不支持 canvas.captureStream 视频录制"));
      return;
    }
    const stream = canvas.captureStream(fps);
    const mimeType = chooseVideoMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    let startedAt = 0;
    let frameId = 0;

    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error("Browser video recording failed"));
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));

    function drawFrame(now) {
      if (!startedAt) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / durationMs);
      drawShopVideoFrame(ctx, width, height, image, logo, watermark, progress);
      if (progress < 1) frameId = requestAnimationFrame(drawFrame);
      else window.setTimeout(() => recorder.state === "recording" && recorder.stop(), 120);
    }

    recorder.start(250);
    frameId = requestAnimationFrame(drawFrame);
    window.setTimeout(() => {
      cancelAnimationFrame(frameId);
      if (recorder.state === "recording") recorder.stop();
    }, durationMs + 600);
  });
}

function drawShopVideoFrame(ctx, width, height, image, logo, watermark, progress) {
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);
  const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
  const scale = 1.04 + Math.max(0, Math.sin(progress * Math.PI * 10)) * 0.018 + eased * 0.035;
  const cover = coverVideoRect(image.width, image.height, width, height, scale);
  const shakeX = Math.sin(progress * Math.PI * 12) * width * 0.004;
  const shakeY = Math.cos(progress * Math.PI * 10) * height * 0.003;
  ctx.drawImage(image, cover.x + shakeX, cover.y + shakeY, cover.width, cover.height);
  drawVideoShine(ctx, width, height, progress);
  drawVideoVignette(ctx, width, height);
  if (logo) drawVideoLogo(ctx, width, height, logo, watermark);
}

function coverVideoRect(sourceWidth, sourceHeight, targetWidth, targetHeight, extraScale = 1) {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight) * extraScale;
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

function drawVideoShine(ctx, width, height, progress) {
  const sweep = ((progress * 1.35) % 1.15) - 0.25;
  ctx.save();
  ctx.translate(width * sweep, height * 0.48);
  ctx.rotate(-0.22);
  const gradient = ctx.createLinearGradient(-width * 0.08, 0, width * 0.16, 0);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.42)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(-width * 0.12, -height, width * 0.28, height * 2);
  ctx.restore();
}

function drawVideoVignette(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(255,255,255,0.10)");
  gradient.addColorStop(0.52, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "rgba(15,23,42,0.10)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawVideoLogo(ctx, width, height, logo, watermark = {}) {
  const logoWidth = width * (Number(watermark.sizePercent || watermark.size_percent || 18) / 100);
  const logoHeight = logoWidth / (logo.width && logo.height ? logo.width / logo.height : 1);
  const margin = Math.max(24, width * 0.04);
  const positions = {
    "top-left": { x: margin, y: margin },
    "top-right": { x: width - logoWidth - margin, y: margin },
    "bottom-left": { x: margin, y: height - logoHeight - margin },
    "bottom-right": { x: width - logoWidth - margin, y: height - logoHeight - margin },
    "bottom-center": { x: (width - logoWidth) / 2, y: height - logoHeight - margin }
  };
  const custom = {
    x: width * (Number(watermark.xPercent ?? watermark.x_percent ?? 75) / 100),
    y: height * (Number(watermark.yPercent ?? watermark.y_percent ?? 75) / 100)
  };
    const point = watermark.position === "custom" ? custom : positions[watermark.position] || positions["top-right"];
  ctx.save();
  ctx.globalAlpha = Number(watermark.opacity ?? 0.88);
  ctx.drawImage(
    logo,
    Math.max(0, Math.min(point.x, width - logoWidth)),
    Math.max(0, Math.min(point.y, height - logoHeight)),
    logoWidth,
    logoHeight
  );
  ctx.restore();
}

function loadVideoImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image loading failed"));
    image.src = src;
  });
}

function chooseVideoMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((item) => MediaRecorder.isTypeSupported(item)) || "";
}

function buildShopVideoName(variant) {
  const base = String(material.title || variant.title || "product").replace(/[^\w.-]+/g, "-").slice(0, 48) || "product";
  const shop = String(variant.shopName || `shop-${variant.shopId}`).replace(/[^\w.-]+/g, "-").slice(0, 32);
  return `${base}-${shop}-video.webm`;
}
async function saveRule(shop) {
  await apiClient.post("/api/asset-variant-engine/rules", { shopId: shop.id, ...state.rules[shop.id] });
  ElMessage.success(`${shop.name} 规则已保存`);
}

async function syncOzonCategories() {
  syncingCategories.value = true;
  try {
    const result = await apiClient.post("/api/asset-variant-engine/sync-ozon-categories", {});
    ElMessage.success(`已从 ${result.shopName || "Ozon"} 同步 ${result.saved || 0} 条真实类目`);
    await loadBootstrap();
  } finally {
    syncingCategories.value = false;
  }
}

async function copyText(value, message = "已复制") {
  const text = String(value || "").trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  ElMessage.success(message);
}

async function importToListingAutomation() {
  if (!state.variants.length) {
    ElMessage.warning("请先生成素材包");
    return;
  }
  importing.value = true;
  try {
    const result = await apiClient.post("/api/asset-variant-engine/import-listing-automation", {
      variantIds: state.variants.map((variant) => variant.id).filter(Boolean)
    });
    ElMessage.success(result.note || `已导入 ${result.imported || 0} 个素材包`);
  } finally {
    importing.value = false;
  }
}

async function goToListingAutomation() {
  await importToListingAutomation();
  if (state.variants.length) {
    router.push({ name: "listing-automation" });
  }
}

function previewGeneratedResult() {
  if (selectedVariant.value) {
    openPackageDetail(selectedVariant.value);
    return;
  }
  ElMessage.warning("当前店铺还没有生成结果");
}

function exportPackages() {
  if (!state.variants.length) {
    ElMessage.warning("请先生成素材包");
    return;
  }
  const payload = {
    batchId: state.batchId,
    outputDir: state.outputDir,
    localOutputDir: state.localOutputDir,
    packages: state.variants.map((variant) => ({
      shop: variant.shopName,
      title: variant.title,
      titleRu: variant.titleRu || variant.title,
      titleZh: variant.titleZh || "",
      tags: variant.tags,
      description: variant.description,
      images: variant.images,
      videos: variant.videos || [],
      outputDir: variant.outputDir,
      localOutputDir: variant.localOutputDir,
      listing: variant.listingUrl
    }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `asset-packages-${state.batchId || Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function openImage(url, title = "素材预览") {
  if (!url) return;
  previewDialog.url = url;
  previewDialog.type = "image";
  previewDialog.title = title;
  previewDialog.visible = true;
}

function openVideo(url, title = "视频预览") {
  if (!url) return;
  previewDialog.url = url;
  previewDialog.type = "video";
  previewDialog.title = title;
  previewDialog.visible = true;
}

function openPackageDetail(variant) {
  if (!variant) return;
  packageDialog.variant = variant;
  packageDialog.visible = true;
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function imageDimensionText(image) {
  if (!image.width || !image.height) return "尺寸识别中";
  return `${image.width} x ${image.height}`;
}

function styleLabel(value) {
  return state.titleStyles.find((item) => item.value === value)?.label || value;
}

function watermarkTemplateFor(row) {
  const templateId = state.rules[row.id].watermarkTemplateId;
  return state.watermarkTemplates.find((item) => String(item.id) === String(templateId)) || null;
}

function watermarkPreviewUrl(template) {
  if (!template) return "";
  const id = String(template.id || "");
  if (id.startsWith("shop-")) {
    return withImageToken(`/api/tools/image-cropper/shop-watermark/${encodeURIComponent(id.slice(5))}/file`);
  }
  return withImageToken(template.logoUrl || template.logo_url || "");
}

function watermarkTemplateLabel(item) {
  const id = String(item.id || "");
  if (id.startsWith("shop-")) {
    const shopId = Number(id.slice(5));
    return state.shops.find((shop) => Number(shop.id) === shopId)?.name || item.name;
  }
  return item.name || "";
}

function categoryOptions() {
  if (state.ozonCategories.length) {
    return state.ozonCategories.map((item) => ({
      value: item.value || item.nameZh || item.pathZh || item.nameRu,
      label: item.label || item.nameZh || item.pathZh || item.nameRu,
      subLabel: item.subLabel || item.nameRu || item.pathRu || "Ozon 鐪熷疄绫荤洰"
    }));
  }
  return state.tailCategories.map((item) => ({ value: item, label: item, subLabel: "" }));
}

function vehicleOptions() {
  if (state.vehicleModelOptions.length) {
    return state.vehicleModelOptions.map((item) => ({
      value: item.labelZh || `${item.brand} ${item.model}`,
      label: item.labelZh || `${item.brand} ${item.model}`,
      subLabel: [
        item.labelRu,
          item.yearFrom ? `${item.yearFrom}-${item.yearTo || "至今"}` : ""
      ].filter(Boolean).join(" / ")
    }));
  }
  return state.vehicleModels.map((item) => ({ value: item, label: item, subLabel: "本地车型库" }));
}

function openWatermarkPreview(row) {
  const url = watermarkPreviewUrl(watermarkTemplateFor(row));
  if (!url) {
    ElMessage.warning("当前店铺还没有可预览的水印");
    return;
  }
  openImage(url, `${row.name} 水印预览`);
}

function availableTailTemplates(row) {
  const rule = state.rules[row.id] || {};
  return state.tailTemplates.filter((item) => {
    const shopMatched = !item.shopId || Number(item.shopId) === Number(row.id);
    const categoryMatched = !rule.tailCategory || item.category === rule.tailCategory;
    const modelMatched = !rule.vehicleModel || item.vehicleModel === rule.vehicleModel;
    return shopMatched && categoryMatched && modelMatched;
  });
}

function tailTemplateFor(row) {
  const id = Number(state.rules[row.id].tailTemplateId || 0);
  return state.tailTemplates.find((item) => Number(item.id) === id)
    || availableTailTemplates(row).find((item) => item.isDefault)
    || availableTailTemplates(row)[0]
    || null;
}

function onTailScopeChange(row) {
  const templates = availableTailTemplates(row);
  const currentId = Number(state.rules[row.id].tailTemplateId || 0);
  if (!templates.some((item) => Number(item.id) === currentId)) {
    state.rules[row.id].tailTemplateId = templates.find((item) => item.isDefault)?.id || templates[0]?.id || "";
  }
}

function openTailTemplatePreview(row) {
  const template = tailTemplateFor(row);
  if (!template.imageUrl) {
    ElMessage.warning("当前类目和车型还没有尾图模板");
    return;
  }
  openImage(template.imageUrl, `${row.name} 尾图模板预览`);
}

function setShopEnabled(shop, enabled) {
  const id = Number(shop.id);
  if (enabled && !state.selectedShopIds.includes(id)) state.selectedShopIds.push(id);
  if (!enabled) state.selectedShopIds = state.selectedShopIds.filter((item) => item !== id);
  if (!state.selectedShopId && state.selectedShopIds.length) state.selectedShopId = state.selectedShopIds[0];
}

function isShopEnabled(shop) {
  return state.selectedShopIds.includes(Number(shop.id));
}

function selectShop(shop) {
  state.selectedShopId = shop.id;
}

function variantImagesByType(type) {
  return (selectedVariant.value.images || []).filter((image) => image.type === type);
}

function imagesByType(variant, type) {
  return (variant.images || []).filter((image) => image.type === type);
}

function sourcePreviewImages() {
  return [
    ...(material.mainImage ? [{ type: "main", previewUrl: material.mainImage.url, outputPath: material.mainImage.name }] : []),
    ...material.detailImages.map((image, index) => ({ type: "detail", previewUrl: image.url, outputPath: `详情图${index + 1}` }))
  ];
}

function previewImagesForPanel() {
  return selectedVariant.value?.images?.length ? selectedVariant.value.images : sourcePreviewImages();
}

function previewDetailImagesForPanel() {
  if (selectedVariant.value?.images?.length) {
    return selectedVariant.value.images.filter((image) => image.type !== "main");
  }
  return sourcePreviewImages().filter((image) => image.type !== "main");
}

function imageTypeLabel(type) {
  if (type === "main") return "主图";
  if (type === "tail") return "尾图";
  return "详情图";
}

function mediaAssetStatusType(asset) {
  if (asset.publishUrl || asset.publish_url) return "success";
  if (asset.status === "local_only") return "warning";
  return "info";
}

function mediaAssetStatusText(asset) {
  if (asset.publishUrl || asset.publish_url) return "Ozon 可抓取";
  if (asset.status === "local_only") return "仅本地预览";
  return asset.status || "未知";
}

function mediaAssetPreview(asset) {
  return asset.previewUrl || asset.preview_url || asset.publishUrl || asset.publish_url || "";
}

function mediaAssetPublishUrl(asset) {
  return asset.publishUrl || asset.publish_url || "";
}

function mediaAssetType(asset) {
  return String(asset.mediaType || asset.media_type || "").toLowerCase();
}

function mediaAssetPreviewUrl(asset) {
  return previewUrlWithToken(mediaAssetPreview(asset));
}

function previewUrlWithToken(url) {
  const text = String(url || "").trim();
  if (!text || /^blob:/i.test(text) || /^data:/i.test(text)) return text;
  return withImageToken(text);
}

function openMediaAssetPreview(asset) {
  const url = mediaAssetPreviewUrl(asset);
  const title = asset.originalName || asset.original_name || asset.storageName || asset.storage_name || "素材预览";
  if (mediaAssetType(asset) === "video") openVideo(url, title);
  else openImage(url, title);
}

const assetProductGroups = computed(() => {
  if (state.variants.length) {
    const productName = material.title || state.sourceProduct?.name || "当前商品素材包";
    return [{
      key: state.batchId || "current",
      productName,
      sourceLabel: state.sourceProduct ? "选品计价表" : "素材裂变中心",
      batchLabel: state.batchId || "-",
      rows: state.variants.map((variant) => ({
        key: variant.id || `${variant.batchId}-${variant.shopId}`,
        shopName: variant.shopName || shopNameById(variant.shopId),
        title: variant.titleRu || variant.title || "",
        main: imagesByType(variant, "main"),
        details: imagesByType(variant, "detail"),
        tail: imagesByType(variant, "tail"),
        videos: variant.videos || [],
        localOutputDir: variant.localOutputDir || variant.outputDir || ""
      }))
    }];
  }

  const byBatch = new Map();
  for (const asset of state.mediaAssets) {
    const batchKey = asset.batchId || asset.batch_id || asset.sourceId || asset.source_id || "manual";
    if (!byBatch.has(batchKey)) {
      byBatch.set(batchKey, {
        key: batchKey,
        productName: assetProductNameFromAsset(asset, batchKey),
        sourceLabel: sourceModuleLabel(asset.sourceModule || asset.source_module),
        batchLabel: batchKey,
        rowsByShop: new Map()
      });
    }
    const group = byBatch.get(batchKey);
    const shopKey = asset.shopId || asset.shop_id || 0;
    if (!group.rowsByShop.has(shopKey)) {
      group.rowsByShop.set(shopKey, {
        key: `${batchKey}-${shopKey}`,
        shopName: shopNameById(shopKey) || (shopKey ? `店铺 ${shopKey}` : "未绑定店铺"),
        title: "",
        main: [],
        details: [],
        tail: [],
        videos: [],
        localOutputDir: ""
      });
    }
    const row = group.rowsByShop.get(shopKey);
    const role = String(asset.role || "").toLowerCase();
    if (mediaAssetType(asset) === "video" || role === "video") row.videos.push(asset);
    else if (role === "main") row.main.push(asset);
    else if (role === "tail") row.tail.push(asset);
    else row.details.push(asset);
  }
  return Array.from(byBatch.values()).map((group) => ({
    ...group,
    rows: Array.from(group.rowsByShop.values())
  }));
});

function shopNameById(shopId) {
  return state.shops.find((shop) => Number(shop.id) === Number(shopId))?.name || "";
}

function sourceModuleLabel(value) {
  const key = String(value || "").toLowerCase();
  if (key === "asset_variant") return "素材裂变中心";
  if (key === "listing_upload") return "手动上传";
  if (key === "selection") return "选品计价表";
  if (key === "manual") return "手动录入";
  return value || "未知来源";
}

function assetProductNameFromAsset(asset, fallback) {
  const name = asset.originalName || asset.original_name || asset.storageName || asset.storage_name || "";
  return material.title || state.sourceProduct?.name || String(name || fallback || "素材包").replace(/\.(jpg|jpeg|png|webp|mp4|mov|webm)$/i, "");
}

function openAssetLikePreview(asset, title = "素材预览") {
  const type = String(asset.mediaType || asset.media_type || asset.contentType || "").toLowerCase();
  const url = asset.previewUrl || asset.preview_url || asset.url || asset.localUrl || asset.publishUrl || asset.publish_url || "";
  if (type.includes("video") || /\.(webm|mp4|mov)(\?|$)/i.test(url)) openVideo(previewUrlWithToken(url), title);
  else openImage(previewUrlWithToken(url), title);
}

function packageStructureRows(variant = selectedVariant.value) {
  const shop = state.shops.find((item) => Number(item.id) === Number(variant.shopId)) || selectedShop.value;
  const rule = shop ? state.rules[shop.id] || {} : selectedRule.value || {};
  return [
    ["", variant.shopName || shop.name || "-"],
    ["", variant.localOutputDir || state.localOutputDir || "-"],
    ["", variant.outputDir || state.outputDir || "-"],
    ["", rule.tailCategory || "-"],
    ["", rule.vehicleModel || "-"],
    ["", variant.titleRu || variant.title || material.title || "-"],
    ["", variant.titleZh || variant.productInfo.titleZh || "-"],
    ["", variant.tags?.join?.(", ") || material.tags || "-"],
    ["", variant.description || material.description || "-"],
    ["", variant.productInfo.color || material.color || "-"],
    ["", variant.productInfo.material || material.material || "-"],
    ["", variant.productInfo.quantity || material.quantity || "-"],
    ["", productDimensionText(variant)],
    ["g", variant.productInfo.dimensions.weightG || material.weightG || "-"],
    ["", "images/main"],
    ["", "images/details"],
    ["", "images/tail"],
    ["??", imagesByType(variant, "main").length || (material.mainImage ? 1 : 0)],
    ["", imagesByType(variant, "detail").length || material.detailImages.length],
    ["", imagesByType(variant, "tail").length],
    ["Video", variant.videos.length || 0],
    [" JSON", variant.productInfoUrl || "-"],
    [" XLSX", variant.productInfoXlsxUrl || "-"],
    ["listing.xlsx", variant.listingUrl || "-"],
    ["listing.json", variant.listingJsonUrl || "-"]
  ];
}

function listingStructureRows() {
  return packageStructureRows(selectedVariant.value);
}

function productDimensionText(variant = selectedVariant.value) {
  const dimensions = variant.productInfo.dimensions || {};
  const length = cleanMetricValue(dimensions.lengthCm || material.lengthCm) || "-";
  const width = cleanMetricValue(dimensions.widthCm || material.widthCm) || "-";
  const height = cleanMetricValue(dimensions.heightCm || material.heightCm) || "-";
  return `${length} x ${width} x ${height} cm`;
}

function openTailTemplateDialog(row = null) {
  const rule = row ? state.rules[row.id] : null;
  tailTemplateDialog.visible = true;
  tailTemplateDialog.shopId = row.id || "";
  tailTemplateDialog.category = rule?.tailCategory || state.tailCategories[0] || "通用汽车用品";
  tailTemplateDialog.vehicleModel = rule?.vehicleModel || state.vehicleModels[0] || "通用车型";
  tailTemplateDialog.name = row ? `${row.name}-${tailTemplateDialog.category}-${tailTemplateDialog.vehicleModel}-尾图` : "";
  tailTemplateDialog.image = "";
  tailTemplateDialog.imageName = "";
  tailTemplateDialog.isDefault = true;
}

async function onTailTemplateImageChange(file) {
  tailTemplateDialog.image = await fileToDataUrl(file.raw);
  tailTemplateDialog.imageName = file.name;
}

async function createTailTemplate() {
  if (!tailTemplateDialog.image) {
    ElMessage.warning("请先上传尾图模板图片");
    return;
  }
  tailTemplateDialog.saving = true;
  try {
    const template = await apiClient.post("/api/asset-variant-engine/tail-templates", {
      shopId: tailTemplateDialog.shopId || null,
      category: tailTemplateDialog.category,
      vehicleModel: tailTemplateDialog.vehicleModel,
      name: tailTemplateDialog.name,
      image: tailTemplateDialog.image,
      isDefault: tailTemplateDialog.isDefault
    });
    tailTemplateDialog.visible = false;
    await loadBootstrap();
    if (template.shopId && state.rules[template.shopId]) {
      state.rules[template.shopId].tailCategory = template.category;
      state.rules[template.shopId].vehicleModel = template.vehicleModel;
      state.rules[template.shopId].tailTemplateId = template.id;
    }
    ElMessage.success("尾图模板已保存");
  } finally {
    tailTemplateDialog.saving = false;
  }
}

function scrollToResults() {
  nextTick(() => document.querySelector(".step-results").scrollIntoView({ behavior: "smooth", block: "start" }));
}

watch(
  () => [route.query.source, route.query.productId],
  () => loadSelectionSourceFromRoute()
);

onMounted(async () => {
  await loadBootstrap();
  await loadSelectionSourceFromRoute();
});
</script>

<template>
  <div class="asset-variant-page" v-loading="loading">
    <header class="workspace-header">
        <div>
          <h1>素材裂变中心</h1>
          <p>上传一套原始商品素材，按店铺规则批量生成标题、标签、描述、水印图、详情图和 listing 素材包。</p>
          <div v-if="state.localOutputDir" class="local-output-bar">
            <span>本地输出目录</span>
            <strong>{{ state.localOutputDir }}</strong>
            <el-button size="small" type="primary" link @click="copyText(state.localOutputDir, '已复制路径')">复制路径</el-button>
          </div>
        </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="loadBootstrap">刷新</el-button>
        <el-button :icon="Download" :disabled="!state.variants.length" @click="exportPackages">导出素材包</el-button>
        <el-button type="primary" :loading="generating" :disabled="!canGenerate || !selectedShop" @click="generateCurrentShop">一键生成当前版本</el-button>
        <el-button type="primary" :loading="generating" :disabled="!canGenerate" @click="generateAllShops">批量生成全部店铺版本</el-button>
        <el-button type="success" :loading="importing" :disabled="!state.variants.length" @click="goToListingAutomation">&#21435;&#19978;&#26550;</el-button>
      </div>
      <input ref="folderInputRef" class="hidden-input" type="file" webkitdirectory directory multiple @change="onFolderImport">
      <input ref="detailReplaceInputRef" class="hidden-input" type="file" accept="image/*" @change="onDetailReplaceInput">
    </header>

    <div class="flow-shell">
      <main class="flow-main">
        <section class="step-panel">
          <div class="step-heading">
            <span class="step-index">1</span>
            <div>
              <h2>上传原始素材</h2>
              <p>主图、详情图、标题、标签和描述会作为所有店铺裂变的母素材。</p>
            </div>
            <el-tag :type="material.mainImage?.url ? 'success' : 'warning'" effect="light">{{ mainUploadStatus }}</el-tag>
          </div>

          <div v-if="state.importedSets.length" class="imported-sets">
            <button v-for="set in state.importedSets" :key="set.key" type="button" @click="applyImportedSet(set)">
              {{ set.key }}
            </button>
          </div>

          <div v-if="state.sourceProduct" class="source-product-banner">
            <div>
              <span>已从选品计价表带入</span>
              <strong>{{ state.sourceProduct.name || state.sourceProduct.code || `产品 #${state.sourceProduct.id}` }}</strong>
            </div>
            <em v-if="state.sourceProduct.selectionId">选品单：{{ state.sourceProduct.selectionId }}</em>
            <em>主图 {{ material.mainImage ? 1 : 0 }} 张 / 详情图 {{ material.detailImages.length }} 张</em>
          </div>

          <div class="upload-layout">
            <div class="main-upload-card">
              <div class="block-title">
                <strong>主图上传区</strong>
                <span>拖拽或点击上传</span>
              </div>
              <el-upload drag :auto-upload="false" :show-file-list="false" accept="image/*" :on-change="onMainImageChange">
                <template v-if="!material.mainImage?.url">
                  <el-icon class="upload-icon"><UploadFilled /></el-icon>
                  <div class="upload-title">上传主图</div>
                  <p>支持 JPG / PNG / WEBP</p>
                </template>
                <img v-else class="main-preview" :src="material.mainImage.url" alt="主图预览">
              </el-upload>
              <div v-if="material.mainImage" class="file-meta">
                <div><strong>{{ material.mainImage.name }}</strong><el-tag size="small" type="success">{{ material.mainImage.status }}</el-tag></div>
                <span>{{ imageDimensionText(material.mainImage) }} / {{ formatBytes(material.mainImage.size) }}</span>
                <div class="file-actions">
                  <el-button size="small" :icon="ZoomIn" @click="openImage(material.mainImage.url, '主图预览')">放大</el-button>
                  <el-button size="small" :icon="Switch">替换</el-button>
                  <el-button size="small" type="danger" :icon="Delete" @click="removeMainImage">删除</el-button>
                </div>
              </div>
            </div>

            <div class="detail-upload-card">
              <div class="block-title">
                <strong>详情图上传区</strong>
                <span>{{ detailStatusText }}，支持拖拽排序</span>
              </div>
              <el-upload drag :auto-upload="false" :show-file-list="false" accept="image/*" multiple :on-change="onDetailImagesChange">
                <el-icon class="upload-icon"><UploadFilled /></el-icon>
                <div class="upload-title">上传详情图</div>
                <p>可一次选择多张图片</p>
              </el-upload>
              <div class="detail-grid">
                <article
                  v-for="(image, index) in material.detailImages"
                  :key="image.id"
                  class="detail-card"
                  :class="{ dragging: detailDragIndex === index, 'drag-over': detailDragOverIndex === index && detailDragIndex !== index }"
                  draggable="true"
                  @dragstart="onDetailDragStart(index, $event)"
                  @dragenter.prevent="onDetailDragEnter(index)"
                  @dragover.prevent
                  @drop="onDetailDrop(index, $event)"
                  @dragend="resetDetailDrag"
                >
                  <img :src="image.url" :alt="image.name" draggable="false" @click="openImage(image.url, `详情图 ${index + 1}`)">
                  <div class="detail-badge">详情图 {{ index + 1 }}</div>
                  <div class="detail-info">
                    <strong>{{ image.name }}</strong>
                    <span>{{ imageDimensionText(image) }}</span>
                  </div>
                  <div class="detail-actions">
                    <button type="button" @click="openImage(image.url, `详情图 ${index + 1}`)">预览</button>
                    <button type="button" @click="requestDetailReplace(index)">替换</button>
                    <button type="button" class="danger" @click="removeDetailImage(index)">删除</button>
                  </div>
                </article>
              </div>
            </div>

            <div class="product-info-card">
              <div class="block-title">
                <strong>产品信息</strong>
                <span>后续可由选品计价表带入</span>
              </div>
              <div class="product-form-grid">
                <label class="form-field wide">
                  <span>商品名称</span>
                  <el-input v-model="material.title" placeholder="Belgee X50 TPU key case" />
                </label>
                <label class="form-field">
                  <span>颜色</span>
                  <el-input v-model="material.color" placeholder="黑色 / 银色" />
                </label>
                <label class="form-field">
                  <span>材质</span>
                  <el-input v-model="material.material" placeholder="TPU / 皮革 / 金属" />
                </label>
                <label class="form-field">
                  <span>数量</span>
                  <el-input v-model="material.quantity" placeholder="1 件 / 2 件套" />
                </label>
                <div class="size-row">
                  <span>尺寸与重量</span>
                  <div>
                    <label class="size-field">
                      <em>长</em>
                      <el-input v-model="material.lengthCm" placeholder="填写长度">
                        <template #suffix>cm</template>
                      </el-input>
                    </label>
                    <label class="size-field">
                      <em>宽</em>
                      <el-input v-model="material.widthCm" placeholder="填写宽度">
                        <template #suffix>cm</template>
                      </el-input>
                    </label>
                    <label class="size-field">
                      <em>高</em>
                      <el-input v-model="material.heightCm" placeholder="填写高度">
                        <template #suffix>cm</template>
                      </el-input>
                    </label>
                    <label class="size-field">
                      <em>重量</em>
                      <el-input v-model="material.weightG" placeholder="填写重量">
                        <template #suffix>g</template>
                      </el-input>
                    </label>
                  </div>
                </div>
                <label class="form-field wide selling-points-field">
                  <span>产品卖点</span>
                  <el-input v-model="material.description" type="textarea" :rows="5" placeholder="例如：贴合原车钥匙、防刮耐磨、按键灵敏、适合日常通勤" />
                </label>
              </div>
            </div>
          </div>
        </section>

        <section class="step-panel">
          <div class="step-heading">
            <span class="step-index">2</span>
            <div>
              <h2>选择店铺与裂变规则</h2>
              <p>每个店铺一行配置水印、标题风格、类目、车型、尾图模板和主图方案。</p>
            </div>
            <div class="step-actions">
              <el-button size="small" :loading="syncingCategories" @click="syncOzonCategories">同步 Ozon 真实类目</el-button>
              <el-button size="small" @click="openTailTemplateDialog()">新增尾图模板</el-button>
            </div>
          </div>

          <div class="rule-list">
            <article
              v-for="shop in state.shops"
              :key="shop.id"
              class="rule-row"
              :class="{ active: Number(state.selectedShopId) === Number(shop.id), disabled: !isShopEnabled(shop) }"
              @click="selectShop(shop)"
            >
              <div class="rule-enable" @click.stop>
                <el-checkbox :model-value="isShopEnabled(shop)" @change="(value) => setShopEnabled(shop, value)" />
              </div>
              <div class="rule-shop">
                <strong>{{ shop.name }}</strong>
                <span>{{ isShopEnabled(shop) ? '已启用' : '未启用' }}</span>
              </div>
              <div class="rule-field watermark-field">
                <label>水印模板</label>
                <div class="media-select">
                  <button v-if="watermarkPreviewUrl(watermarkTemplateFor(shop))" type="button" class="tiny-preview" @click.stop="openWatermarkPreview(shop)">
                    <img :src="watermarkPreviewUrl(watermarkTemplateFor(shop))" :alt="`${shop.name} 水印`">
                  </button>
                  <el-select v-model="state.rules[shop.id].watermarkTemplateId" filterable clearable @click.stop>
                    <el-option v-for="item in state.watermarkTemplates" :key="item.id" :label="watermarkTemplateLabel(item)" :value="item.id" />
                  </el-select>
                </div>
              </div>
              <div class="rule-field">
                <label>标题风格</label>
                <el-select v-model="state.rules[shop.id].titleStyle" @click.stop>
                  <el-option v-for="item in state.titleStyles" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </div>
              <div class="rule-field">
                <label>类目</label>
                <el-select v-model="state.rules[shop.id].tailCategory" filterable allow-create default-first-option @change="onTailScopeChange(shop)" @click.stop>
                  <el-option
                    v-for="item in categoryOptions()"
                    :key="item.value"
                    :label="item.label"
                    :value="item.value"
                  >
                    <div class="option-two-line">
                      <strong>{{ item.label }}</strong>
                      <span>{{ item.subLabel }}</span>
                    </div>
                  </el-option>
                </el-select>
              </div>
              <div class="rule-field">
                <label>车型</label>
                <el-select v-model="state.rules[shop.id].vehicleModel" filterable allow-create default-first-option @change="onTailScopeChange(shop)" @click.stop>
                  <el-option
                    v-for="item in vehicleOptions()"
                    :key="item.value"
                    :label="item.label"
                    :value="item.value"
                  >
                    <div class="option-two-line">
                      <strong>{{ item.label }}</strong>
                      <span>{{ item.subLabel }}</span>
                    </div>
                  </el-option>
                </el-select>
              </div>
              <div class="rule-field tail-field">
                <label>尾图模板</label>
                <div class="media-select tail-preview-only">
                  <button v-if="tailTemplateFor(shop)?.imageUrl" type="button" class="tiny-preview square" @click.stop="openTailTemplatePreview(shop)" :title="tailTemplateFor(shop)?.name">
                    <img :src="tailTemplateFor(shop)?.imageUrl" :alt="tailTemplateFor(shop).name">
                  </button>
                  <div v-else class="tiny-empty">尾图</div>
                </div>
              </div>
              <div class="rule-field">
                <label>主图方案</label>
                <el-select v-model="state.rules[shop.id].mainImagePlan" @click.stop>
                  <el-option v-for="item in state.mainImagePlans" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </div>
              <div class="rule-actions" @click.stop>
                <el-button link type="primary" @click="saveRule(shop)">保存规则</el-button>
                <el-button link type="primary" @click="previewGeneratedResult">预览</el-button>
                <el-button link type="primary" @click="openTailTemplateDialog(shop)">加尾图</el-button>
              </div>
            </article>
          </div>
        </section>

        <section class="step-panel step-results">
          <div class="step-heading">
            <span class="step-index">3</span>
            <div>
              <h2>生成并预览多店铺素材包</h2>
              <p>每个店铺会输出独立素材包，包含主图、详情图、尾图、标题、标签、描述和 listing 文件。</p>
              <p v-if="videoGenerating" class="video-progress">正在生成视频：{{ videoStatus.done }} / {{ videoStatus.total }} {{ videoStatus.current }}</p>
            </div>
            <el-button type="primary" :disabled="!state.variants.length" @click="scrollToResults">查看结果</el-button>
          </div>

          <div v-if="state.variants.length" class="package-grid">
            <article v-for="variant in state.variants" :key="variant.id" class="package-card" @click="state.selectedShopId = variant.shopId">
              <img :src="variant.previewUrl" :alt="variant.shopName">
              <div class="package-head">
                <span>&#24215;&#38138;&#21517;</span>
                <strong>{{ variant.shopName }}</strong>
                <el-tag type="success" effect="light">&#24050;&#29983;&#25104;</el-tag>
              </div>
              <div class="package-path">
                <span>&#25991;&#20214;&#20301;&#32622;</span>
                <strong>{{ variant.localOutputDir || variant.outputDir }}</strong>
              </div>
              <div class="package-title-block">
                <span>俄语标题</span>
                <p>{{ variant.titleRu || variant.title }}</p>
              </div>
              <div v-if="variant.titleZh" class="package-title-block package-title-zh">
                <span>中文释义</span>
                <p>{{ variant.titleZh }}</p>
              </div>
              <div class="package-counts">
                <span>&#20027;&#22270; {{ imagesByType(variant, 'main').length }} &#24352;</span>
                <span>&#35814;&#24773;&#22270; {{ imagesByType(variant, 'detail').length }} &#24352;</span>
                <span>&#23614;&#22270; {{ imagesByType(variant, 'tail').length }} &#24352;</span>
                <span>Video {{ variant.videos.length || 0 }}</span>
              </div>
              <video v-if="variant.videos?.[0]" class="package-video-preview" :src="variant.videos[0].previewUrl || variant.videos[0].url" controls playsinline @click.stop />
              <p v-else-if="videoGenerating" class="package-video-state">视频生成中...</p>
              <p v-else-if="variant.videoError" class="package-video-error">{{ variant.videoError }}</p>
              <div class="package-strip">
                <button v-for="(image, index) in variant.images" :key="image.outputPath" type="button" @click.stop="openImage(image.previewUrl, `${imageTypeLabel(image.type)} ${image.sortOrder || index + 1}`)">
                  <img :src="image.previewUrl" :alt="image.outputPath">
                  <em>{{ imageTypeLabel(image.type) }} {{ image.sortOrder || index + 1 }}</em>
                </button>
              </div>
              <div class="package-actions">
                <el-button size="small" @click.stop="copyText(variant.localOutputDir || variant.outputDir, '素材包路径已复制')">复制路径</el-button>
                <el-button size="small" :icon="Download" tag="a" :href="variant.listingUrl" target="_blank" @click.stop>listing.xlsx</el-button>
              </div>
            </article>
          </div>
          <div v-else class="empty-results">
            <el-icon><Picture /></el-icon>
            <strong>还没有生成素材包</strong>
            <span>完成 Step 1 和 Step 2 后，点击顶部批量生成全部店铺版本。</span>
          </div>
        </section>

        <section class="step-panel media-assets-panel">
          <div class="step-heading">
            <span class="step-index">4</span>
            <div>
              <h2>统一素材资产</h2>
              <p>按产品素材包汇总展示，每个店铺一行查看主图、详情图、尾图和视频。</p>
            </div>
            <el-button size="small" :loading="mediaAssetLoading" @click="loadMediaAssets">刷新素材资产</el-button>
          </div>

          <div v-if="assetProductGroups.length" class="asset-package-list">
            <article v-for="group in assetProductGroups" :key="group.key" class="asset-package-card">
              <header class="asset-package-header">
                <div>
                  <span>商品名称</span>
                  <strong>{{ group.productName }}</strong>
                </div>
                <div>
                  <span>来源</span>
                  <strong>{{ group.sourceLabel }}</strong>
                </div>
                <div>
                  <span>批次</span>
                  <strong>{{ group.batchLabel }}</strong>
                </div>
              </header>
              <div class="asset-shop-list">
                <section v-for="row in group.rows" :key="row.key" class="asset-shop-row">
                  <div class="asset-shop-name">
                    <span>店铺</span>
                    <strong>{{ row.shopName }}</strong>
                  </div>
                  <div class="asset-row-title">
                    <span>标题</span>
                    <strong>{{ row.title || "未生成标题" }}</strong>
                  </div>
                  <div class="asset-bucket">
                    <span>主图 {{ row.main.length }}</span>
                    <div>
                      <button v-for="(asset, index) in row.main.slice(0, 3)" :key="asset.outputPath || asset.id || index" type="button" class="asset-thumb-button" @click="openAssetLikePreview(asset, `主图 ${index + 1}`)">
                        <img class="asset-thumb" :src="previewUrlWithToken(asset.previewUrl || asset.preview_url || asset.url)" alt="主图">
                      </button>
                    </div>
                  </div>
                  <div class="asset-bucket">
                    <span>详情图 {{ row.details.length }}</span>
                    <div>
                      <button v-for="(asset, index) in row.details.slice(0, 5)" :key="asset.outputPath || asset.id || index" type="button" class="asset-thumb-button" @click="openAssetLikePreview(asset, `详情图 ${index + 1}`)">
                        <img class="asset-thumb" :src="previewUrlWithToken(asset.previewUrl || asset.preview_url || asset.url)" alt="详情图">
                      </button>
                    </div>
                  </div>
                  <div class="asset-bucket">
                    <span>尾图 {{ row.tail.length }}</span>
                    <div>
                      <button v-for="(asset, index) in row.tail.slice(0, 2)" :key="asset.outputPath || asset.id || index" type="button" class="asset-thumb-button" @click="openAssetLikePreview(asset, `尾图 ${index + 1}`)">
                        <img class="asset-thumb" :src="previewUrlWithToken(asset.previewUrl || asset.preview_url || asset.url)" alt="尾图">
                      </button>
                    </div>
                  </div>
                  <div class="asset-bucket">
                    <span>视频 {{ row.videos.length }}</span>
                    <div>
                      <button v-for="(asset, index) in row.videos.slice(0, 2)" :key="asset.id || asset.url || index" type="button" class="asset-thumb-button" @click="openAssetLikePreview(asset, `视频 ${index + 1}`)">
                        <span class="asset-video-thumb"><el-icon><VideoCamera /></el-icon><em>Video</em></span>
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </article>
          </div>
          <div v-else class="empty-results compact">
            <el-icon><Picture /></el-icon>
            <strong>还没有统一素材资产</strong>
            <span>生成素材裂变包后，这里会按商品和店铺汇总展示。</span>
          </div>
        </section>
      </main>
    </div>

    <el-dialog v-model="previewDialog.visible" :title="previewDialog.title" width="860px">
      <video v-if="previewDialog.type === 'video'" class="dialog-video" :src="previewDialog.url" controls autoplay playsinline />
      <img v-else class="dialog-image" :src="previewDialog.url" alt="素材预览">
    </el-dialog>

    <el-dialog v-model="packageDialog.visible" width="1240px" class="package-dialog" destroy-on-close>
      <template #header>
        <div class="package-dialog-title">
          <span>素材包预览</span>
          <strong>{{ packageDialog.variant.shopName || "-" }}</strong>
        </div>
      </template>
      <div v-if="packageDialog.variant" class="package-preview">
        <header class="package-preview-hero">
          <div class="package-title-stack">
            <el-tag type="success" effect="light">已生成</el-tag>
            <h2>{{ packageDialog.variant.titleRu || packageDialog.variant.title }}</h2>
            <p v-if="packageDialog.variant.titleZh">{{ packageDialog.variant.titleZh }}</p>
            <div class="package-chip-row">
              <span>主图 {{ imagesByType(packageDialog.variant, 'main').length }}</span>
              <span>详情图 {{ imagesByType(packageDialog.variant, 'detail').length }}</span>
              <span>尾图 {{ imagesByType(packageDialog.variant, 'tail').length }}</span>
              <span>Video {{ packageDialog.variant.videos?.length || 0 }}</span>
              <span>{{ packageDialog.variant.productInfo?.category || selectedRule?.tailCategory || "未选类目" }}</span>
              <span>{{ packageDialog.variant.productInfo?.vehicleModel || selectedRule?.vehicleModel || "未选车型" }}</span>
            </div>
          </div>
          <div class="package-hero-actions">
            <el-button @click="copyText(packageDialog.variant.localOutputDir || packageDialog.variant.outputDir, '素材包路径已复制')">复制路径</el-button>
            <el-button type="primary" tag="a" :href="packageDialog.variant.listingUrl" target="_blank">打开 listing.xlsx</el-button>
          </div>
        </header>

        <section class="package-preview-summary">
          <button
            v-if="imagesByType(packageDialog.variant, 'main')[0]"
            type="button"
            class="package-main-preview"
            @click="openImage(imagesByType(packageDialog.variant, 'main')[0].previewUrl, imagesByType(packageDialog.variant, 'main')[0].outputPath)"
          >
            <img :src="imagesByType(packageDialog.variant, 'main')[0].previewUrl" alt="主图预览">
          </button>
          <div class="package-copy-panel">
            <section>
              <h3>AI 文案</h3>
              <dl class="package-copy-list">
                <div>
                  <dt>标签</dt>
                  <dd>{{ packageDialog.variant.tags?.join?.(", ") || "-" }}</dd>
                </div>
                <div>
                  <dt>描述</dt>
                  <dd>{{ packageDialog.variant.description || "-" }}</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>产品信息</h3>
              <div class="product-metric-grid">
                <div><span>颜色</span><strong>{{ packageDialog.variant.productInfo?.color || material.color || "-" }}</strong></div>
                <div><span>鏉愯川</span><strong>{{ packageDialog.variant.productInfo?.material || material.material || "-" }}</strong></div>
                <div><span>数量</span><strong>{{ packageDialog.variant.productInfo?.quantity || material.quantity || "-" }}</strong></div>
                <div><span>长宽高</span><strong>{{ productDimensionText(packageDialog.variant) }}</strong></div>
                <div><span>重量</span><strong>{{ cleanMetricValue(packageDialog.variant.productInfo?.dimensions?.weightG || material.weightG) || "-" }} g</strong></div>
              </div>
            </section>
          </div>
        </section>

        <el-tabs class="package-tabs">
          <el-tab-pane label="全部图片">
            <div class="image-section-grid">
              <section class="full-image-section">
                <h3>主图</h3>
                <div class="full-image-grid main-only">
                  <button v-for="image in imagesByType(packageDialog.variant, 'main')" :key="image.outputPath" type="button" @click="openImage(image.previewUrl, image.outputPath)">
                    <img :src="image.previewUrl" :alt="image.outputPath">
                    <span>{{ image.outputPath }}</span>
                  </button>
                </div>
              </section>
              <section class="full-image-section">
                <h3>全部详情图</h3>
                <div class="full-image-grid">
                  <button v-for="image in imagesByType(packageDialog.variant, 'detail')" :key="image.outputPath" type="button" @click="openImage(image.previewUrl, image.outputPath)">
                    <img :src="image.previewUrl" :alt="image.outputPath">
                    <span>详情图 {{ image.sortOrder }}</span>
                  </button>
                </div>
              </section>
              <section class="full-image-section">
                <h3>尾图</h3>
                <div class="full-image-grid">
                  <button v-for="image in imagesByType(packageDialog.variant, 'tail')" :key="image.outputPath" type="button" @click="openImage(image.previewUrl, image.outputPath)">
                    <img :src="image.previewUrl" :alt="image.outputPath">
                    <span>尾图 {{ image.sortOrder }}</span>
                  </button>
                </div>
              </section>
            </div>
          </el-tab-pane>
          <el-tab-pane label="Video">
            <div v-if="packageDialog.variant.videos?.length" class="video-section-grid">
              <section v-for="video in packageDialog.variant.videos" :key="video.id || video.url" class="full-video-section">
                <video :src="video.previewUrl || video.url" controls playsinline />
                <div class="video-meta-row">
                  <strong>{{ video.name }}</strong>
                  <span>{{ formatBytes(video.size) }}</span>
                  <a :href="video.downloadUrl || video.previewUrl || video.url" :download="video.name" target="_blank">Download</a>
                </div>
              </section>
            </div>
            <el-empty v-else description="No generated video yet" />
          </el-tab-pane>
          <el-tab-pane label="产品信息表">
            <div class="package-info-grid">
              <div v-for="[key, value] in packageStructureRows(packageDialog.variant).filter(([key]) => !String(value).startsWith('/api/'))" :key="key">
                <span>{{ key }}</span>
                <strong>{{ value }}</strong>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="文件结构">
            <div class="file-structure-panel">
              <div class="path-box">
                <span>本地目录</span>
                <strong>{{ packageDialog.variant.localOutputDir || packageDialog.variant.outputDir }}</strong>
                <el-button size="small" @click="copyText(packageDialog.variant.localOutputDir || packageDialog.variant.outputDir, '素材包路径已复制')">复制</el-button>
              </div>
              <div class="folder-grid">
                <span>product-info/</span>
                <span>images/main/</span>
                <span>images/details/</span>
                <span>images/tail/</span>
                <span>videos/</span>
              </div>
              <div class="file-link-row">
                <a v-if="packageDialog.variant.productInfoUrl" :href="packageDialog.variant.productInfoUrl" target="_blank">product-info.json</a>
                <a v-if="packageDialog.variant.productInfoXlsxUrl" :href="packageDialog.variant.productInfoXlsxUrl" target="_blank">product-info.xlsx</a>
                <a v-if="packageDialog.variant.listingUrl" :href="packageDialog.variant.listingUrl" target="_blank">listing.xlsx</a>
                <a v-if="packageDialog.variant.listingJsonUrl" :href="packageDialog.variant.listingJsonUrl" target="_blank">listing.json</a>
                <a v-for="video in packageDialog.variant.videos || []" :key="video.id || video.url" :href="video.previewUrl || video.url" target="_blank">{{ video.name || "video.webm" }}</a>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-dialog>

    <el-dialog v-model="tailTemplateDialog.visible" title="新增尾图模板" width="620px">
      <div class="tail-template-form">
        <el-select v-model="tailTemplateDialog.shopId" clearable placeholder="适用店铺，不选则通用">
          <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="shop.id" />
        </el-select>
        <el-input v-model="tailTemplateDialog.name" placeholder="模板名称" />
        <el-checkbox v-model="tailTemplateDialog.isDefault">设为默认尾图模板</el-checkbox>
        <el-upload drag :auto-upload="false" :show-file-list="false" accept="image/*" :on-change="onTailTemplateImageChange">
          <el-icon class="upload-icon"><UploadFilled /></el-icon>
          <div>上传尾图模板</div>
        </el-upload>
        <img v-if="tailTemplateDialog.image" class="tail-template-preview" :src="tailTemplateDialog.image" alt="尾图模板预览">
      </div>
      <template #footer>
        <el-button @click="tailTemplateDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="tailTemplateDialog.saving" @click="createTailTemplate">保存模板</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.asset-variant-page { position: relative; z-index: 0; display: flex; flex-direction: column; gap: 16px; color: #172033; isolation: isolate; }
.asset-variant-page img { max-width: 100%; max-height: 100%; }
.workspace-header { position: sticky; top: 0; z-index: 30; display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; padding: 14px 18px; border: 1px solid #dbe7f6; border-radius: 8px; background: rgba(255, 255, 255, .96); box-shadow: 0 8px 24px rgba(15, 23, 42, .08); backdrop-filter: blur(8px); }
.workspace-header h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
.workspace-header p { margin: 6px 0 0; color: #697386; line-height: 1.5; }
.local-output-bar { margin-top: 10px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; max-width: 980px; padding: 9px 10px; border-radius: 6px; background: #f3f8ff; border: 1px solid #d7e8ff; }
.local-output-bar span { color: #697386; font-size: 12px; }
.local-output-bar strong { overflow-wrap: anywhere; font-size: 13px; color: #172033; }
.header-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; max-width: 980px; }
.header-actions :deep(.el-button) { margin-left: 0; }
.hidden-input { display: none; }
.flow-shell { display: block; }
.flow-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.step-panel { border: 1px solid #e5eaf3; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
.step-panel { padding: 18px; }
.step-heading { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
.step-heading h2 { margin: 0; font-size: 18px; letter-spacing: 0; }
.step-heading p { margin: 5px 0 0; color: #697386; line-height: 1.5; }
.step-heading > .el-button, .step-heading > .el-tag { margin-left: auto; }
.step-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.step-index { width: 30px; height: 30px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; background: #1677ff; color: #fff; font-weight: 700; }
.imported-sets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.imported-sets button { border: 1px solid #d7e3f4; background: #f7fbff; color: #24518f; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.source-product-banner { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; padding: 10px 12px; border: 1px solid #b8dfc5; border-radius: 8px; background: #f1fbf5; color: #1f5f39; }
.source-product-banner div { display: flex; align-items: center; gap: 8px; min-width: 0; }
.source-product-banner span, .source-product-banner em { font-size: 12px; color: #4f7f61; font-style: normal; }
.source-product-banner strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 520px; }
.upload-layout { display: grid; grid-template-columns: 320px minmax(420px, 1fr) 380px; gap: 16px; align-items: start; }
.main-upload-card, .detail-upload-card, .product-info-card { border: 1px solid #e7edf6; border-radius: 8px; padding: 14px; background: #fbfcfe; min-width: 0; overflow: hidden; }
.block-title { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.block-title strong { font-size: 15px; }
.block-title span { color: #7b8798; font-size: 13px; }
.upload-icon { font-size: 30px; color: #1677ff; }
.upload-title { font-weight: 700; color: #172033; }
.main-upload-card :deep(.el-upload),
.main-upload-card :deep(.el-upload-dragger) { width: 100%; max-width: 100%; overflow: hidden; }
.main-upload-card :deep(.el-upload-dragger) { height: 320px; display: grid; place-items: center; padding: 0; }
.detail-upload-card :deep(.el-upload),
.detail-upload-card :deep(.el-upload-dragger) { width: 100%; max-width: 100%; overflow: hidden; }
.main-preview { width: 100%; height: 100%; max-height: 320px; aspect-ratio: 1; object-fit: contain; display: block; background: #f4f7fb; border-radius: 6px; }
.file-meta { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; font-size: 13px; color: #697386; }
.file-meta div:first-child { display: flex; justify-content: space-between; gap: 10px; }
.file-meta strong { color: #172033; overflow-wrap: anywhere; }
.file-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }
.detail-card { position: relative; border: 1px solid #e5eaf3; border-radius: 8px; background: #fff; overflow: hidden; cursor: grab; }
.detail-card.dragging { opacity: .48; cursor: grabbing; }
.detail-card.drag-over { border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22, 119, 255, .14); transform: translateY(-2px); }
.detail-card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; cursor: zoom-in; }
.detail-badge { position: absolute; left: 8px; top: 8px; padding: 3px 7px; border-radius: 5px; background: rgba(22, 119, 255, .92); color: #fff; font-size: 12px; }
.detail-info { display: flex; flex-direction: column; gap: 3px; padding: 8px; }
.detail-info strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-info span { font-size: 12px; color: #7b8798; }
.detail-actions { display: flex; border-top: 1px solid #edf1f7; }
.detail-actions button { flex: 1; border: 0; background: #fff; color: #1677ff; padding: 7px 2px; font-size: 12px; cursor: pointer; }
.detail-actions .danger { color: #f04438; }
.product-form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.form-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.form-field span, .size-row > span { color: #697386; font-size: 12px; }
.form-field.wide { grid-column: 1 / -1; }
.form-field.compact { grid-column: span 1; }
.selling-points-field :deep(.el-textarea__inner) { min-height: 118px !important; resize: vertical; }
.size-row { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 6px; }
.size-row > div { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.size-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.size-field em { color: #697386; font-size: 12px; font-style: normal; line-height: 1; }
.rule-list { display: flex; flex-direction: column; gap: 10px; }
.rule-row { display: grid; grid-template-columns: 28px 116px minmax(170px, .95fr) 128px minmax(150px, .8fr) minmax(150px, .8fr) 72px 136px 112px; gap: 8px; align-items: center; border: 1px solid #e5eaf3; border-radius: 8px; padding: 10px 12px; background: #fff; cursor: pointer; }
.rule-row.active { border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22, 119, 255, .08); }
.rule-row.disabled { opacity: .62; background: #f8fafc; }
.rule-shop { display: flex; flex-direction: column; gap: 4px; }
.rule-shop strong { font-size: 14px; }
.rule-shop span, .rule-field label { color: #7b8798; font-size: 12px; }
.rule-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tail-preview-only { min-width: 58px; }
.tail-preview-only .tiny-preview, .tail-preview-only .tiny-empty { flex: 0 0 42px; }
.media-select { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; align-items: center; }
.tiny-preview, .tiny-empty { width: 42px; height: 42px; border: 1px solid #dce5f2; border-radius: 6px; background: #f7f9fc; overflow: hidden; display: grid; place-items: center; padding: 0; cursor: zoom-in; color: #7b8798; font-size: 12px; }
.tiny-preview.square, .tiny-empty { width: 44px; height: 44px; }
.tiny-preview img { width: 100%; height: 100%; object-fit: contain; display: block; }
.tiny-preview.square img { object-fit: cover; }
.rule-actions { display: flex; flex-wrap: wrap; gap: 2px 8px; }
.option-two-line { display: flex; flex-direction: column; gap: 2px; line-height: 1.25; }
.option-two-line strong { font-weight: 600; }
.option-two-line span { color: #697386; font-size: 12px; }
.package-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; }
.package-card { display: flex; flex-direction: column; gap: 10px; border: 1px solid #e5eaf3; border-radius: 8px; padding: 12px; background: #fff; cursor: pointer; min-width: 0; }
.package-card > img { width: 100%; height: auto; max-height: 320px; aspect-ratio: 1; object-fit: cover; border-radius: 6px; background: #f4f7fb; }
.package-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.package-head > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.package-card span { color: #7b8798; font-size: 12px; overflow-wrap: anywhere; }
.package-head strong { font-size: 18px; line-height: 1.25; overflow-wrap: anywhere; }
.package-path { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border-radius: 6px; background: #f8fafc; border: 1px solid #edf1f7; }
.package-path strong { color: #334155; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; word-break: break-all; font-weight: 500; }
.package-title-block { display: flex; flex-direction: column; gap: 5px; }
.package-title-block p { line-height: 1.55; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.package-title-zh { color: #697386; font-size: 13px; }
.package-counts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-start !important; }
.package-counts span { padding: 3px 7px; border-radius: 5px; background: #eef6ff; color: #24518f; }
.package-strip { display: grid !important; grid-template-columns: repeat(auto-fill, minmax(54px, 1fr)); gap: 6px !important; align-items: start !important; max-height: 146px; overflow: auto; padding: 6px; border-radius: 6px; background: #f8fafc; }
.package-strip button { position: relative; border: 1px solid #e5eaf3; border-radius: 5px; overflow: hidden; padding: 0; background: #fff; cursor: zoom-in; }
.package-strip img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.package-strip em { position: absolute; left: 2px; bottom: 2px; right: 2px; padding: 1px 2px; border-radius: 3px; background: rgba(15, 23, 42, .72); color: #fff; font-style: normal; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.package-video-preview { width: 100%; max-height: 220px; margin-top: 10px; border-radius: 7px; background: #0f172a; object-fit: contain; }
.video-progress { margin: 6px 0 0; color: #1677ff; font-size: 12px; }
.package-video-state,
.package-video-error { margin: 0; padding: 8px 10px; border-radius: 6px; font-size: 12px; }
.package-video-state { color: #1677ff; background: #eef6ff; }
.package-video-error { color: #b42318; background: #fff1f0; }
.package-actions { display: flex; justify-content: flex-start; gap: 8px; flex-wrap: wrap; }
.package-actions :deep(.el-button) { margin-left: 0; }
.empty-results { min-height: 160px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: #7b8798; border: 1px dashed #dce5f2; border-radius: 8px; background: #fbfcfe; }
.empty-results .el-icon { font-size: 28px; color: #1677ff; }
.media-assets-panel { overflow: hidden; }
.asset-package-list { display: flex; flex-direction: column; gap: 14px; }
.asset-package-card { border: 1px solid #e5eaf3; border-radius: 8px; background: #fff; overflow: hidden; }
.asset-package-header { display: grid; grid-template-columns: minmax(260px, 1fr) 150px minmax(180px, .8fr); gap: 12px; padding: 12px 14px; background: #f8fafc; border-bottom: 1px solid #edf1f7; }
.asset-package-header div,
.asset-shop-name,
.asset-row-title,
.asset-bucket { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.asset-package-header span,
.asset-shop-row span { color: #697386; font-size: 12px; }
.asset-package-header strong,
.asset-shop-row strong { overflow-wrap: anywhere; }
.asset-shop-list { display: flex; flex-direction: column; }
.asset-shop-row { display: grid; grid-template-columns: 140px minmax(220px, 1fr) 110px minmax(220px, 1.3fr) 100px 100px; gap: 12px; align-items: start; padding: 12px 14px; border-bottom: 1px solid #edf1f7; }
.asset-shop-row:last-child { border-bottom: 0; }
.asset-row-title strong { font-size: 13px; line-height: 1.45; color: #334155; }
.asset-bucket > div { display: flex; gap: 6px; flex-wrap: wrap; min-height: 70px; align-content: flex-start; }
.asset-thumb-button { width: 52px; aspect-ratio: 3 / 4; border: 1px solid #d7e3f4; border-radius: 6px; padding: 0; background: #f8fafc; overflow: hidden; cursor: zoom-in; display: inline-grid; place-items: stretch; }
.asset-thumb-button:hover { border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22, 119, 255, .12); }
.asset-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
.asset-video-thumb { width: 100%; height: 100%; display: grid; place-items: center; align-content: center; gap: 4px; background: #0f172a; color: #fff; }
.asset-video-thumb :deep(.el-icon) { font-size: 18px; }
.asset-video-thumb em { font-style: normal; font-size: 10px; opacity: .86; }
.empty-results.compact { min-height: 120px; padding: 24px; }
.preview-panel { position: sticky; top: 16px; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.preview-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.preview-header div { display: flex; flex-direction: column; gap: 4px; }
.preview-header span { color: #7b8798; font-size: 12px; }
.preview-header strong { font-size: 18px; }
.preview-block { border-top: 1px solid #edf1f7; padding-top: 14px; }
.preview-block h3 { margin: 0 0 10px; font-size: 14px; }
.hero-preview { width: 100%; border: 0; border-radius: 8px; padding: 0; background: #f4f7fb; overflow: hidden; cursor: zoom-in; }
.hero-preview img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.preview-empty { min-height: 180px; display: grid; place-items: center; color: #7b8798; background: #f8fafc; border-radius: 8px; }
.panel-image-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.panel-image-grid { max-height: 380px; overflow: auto; padding-right: 2px; }
.panel-image-grid button { position: relative; border: 1px solid #e5eaf3; border-radius: 6px; padding: 0; overflow: hidden; cursor: zoom-in; background: #f8fafc; }
.panel-image-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.panel-image-grid em { position: absolute; left: 4px; top: 4px; padding: 2px 5px; border-radius: 4px; background: rgba(22, 119, 255, .9); color: #fff; font-size: 11px; font-style: normal; }
.copy-preview { display: flex; flex-direction: column; gap: 10px; margin: 0; }
.copy-preview div { display: flex; flex-direction: column; gap: 3px; }
.copy-preview dt { color: #7b8798; font-size: 12px; }
.copy-preview dd { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
.listing-structure { display: flex; flex-direction: column; border: 1px solid #edf1f7; border-radius: 8px; overflow: hidden; }
.listing-structure div { display: grid; grid-template-columns: 80px minmax(0, 1fr); border-bottom: 1px solid #edf1f7; }
.listing-structure div:last-child { border-bottom: 0; }
.listing-structure span, .listing-structure strong { padding: 8px 10px; font-size: 12px; }
.listing-structure span { background: #f8fafc; color: #697386; }
.listing-structure strong { overflow-wrap: anywhere; }
.dialog-image, .dialog-video { width: 100%; max-height: 72vh; object-fit: contain; display: block; background: #0f172a; border-radius: 8px; }
.package-dialog-title { display: flex; align-items: baseline; gap: 10px; }
.package-dialog-title span { color: #697386; font-size: 13px; }
.package-dialog-title strong { font-size: 18px; color: #172033; }
.package-preview { display: flex; flex-direction: column; gap: 14px; max-height: 78vh; overflow: auto; padding-right: 4px; }
.package-preview-hero { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; padding: 14px; border: 1px solid #e5eaf3; border-radius: 8px; background: #f8fbff; }
.package-title-stack { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.package-title-stack h2 { margin: 0; font-size: 19px; line-height: 1.35; letter-spacing: 0; overflow-wrap: anywhere; }
.package-title-stack p { margin: 0; color: #697386; line-height: 1.5; }
.package-chip-row { display: flex; gap: 8px; flex-wrap: wrap; }
.package-chip-row span { padding: 4px 8px; border-radius: 5px; background: #fff; border: 1px solid #dce8f6; color: #24518f; font-size: 12px; }
.package-hero-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; flex: 0 0 auto; }
.package-preview-summary { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 14px; align-items: stretch; }
.package-main-preview { border: 1px solid #e5eaf3; border-radius: 8px; padding: 0; background: #f8fafc; overflow: hidden; cursor: zoom-in; }
.package-main-preview img { width: 100%; height: 100%; min-height: 360px; aspect-ratio: 1; object-fit: cover; display: block; }
.package-copy-panel { display: grid; grid-template-rows: 1fr auto; gap: 14px; min-width: 0; }
.package-copy-panel section, .full-image-section, .file-structure-panel { border: 1px solid #e5eaf3; border-radius: 8px; padding: 14px; background: #fff; }
.package-copy-panel h3, .full-image-section h3 { margin: 0 0 10px; font-size: 15px; }
.package-copy-list { display: flex; flex-direction: column; gap: 12px; margin: 0; }
.package-copy-list div { display: flex; flex-direction: column; gap: 4px; }
.package-copy-list dt { color: #697386; font-size: 12px; }
.package-copy-list dd { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.product-metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.product-metric-grid div { padding: 10px; border-radius: 6px; background: #f8fafc; border: 1px solid #edf1f7; }
.product-metric-grid span { display: block; color: #697386; font-size: 12px; margin-bottom: 5px; }
.product-metric-grid strong { overflow-wrap: anywhere; }
.package-tabs { border: 1px solid #e5eaf3; border-radius: 8px; padding: 0 14px 14px; background: #fff; }
.image-section-grid { display: flex; flex-direction: column; gap: 14px; }
.full-image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.full-image-grid.main-only { grid-template-columns: repeat(auto-fill, minmax(180px, 260px)); }
.full-image-grid button { border: 1px solid #e5eaf3; border-radius: 8px; padding: 0; overflow: hidden; background: #f8fafc; cursor: zoom-in; text-align: left; }
.full-image-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.full-image-grid span { display: block; padding: 7px; color: #697386; font-size: 12px; overflow-wrap: anywhere; }
.video-section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.full-video-section { border: 1px solid #e5eaf3; border-radius: 8px; padding: 12px; background: #fbfcfe; }
.full-video-section video { width: 100%; max-height: 520px; border-radius: 7px; background: #0f172a; object-fit: contain; }
.video-meta-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 13px; }
.video-meta-row strong { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.video-meta-row span { color: #697386; }
.video-meta-row a { color: #1677ff; text-decoration: none; }
.package-info-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.package-info-grid div { min-height: 70px; border: 1px solid #edf1f7; border-radius: 7px; padding: 10px; background: #fbfcfe; }
.package-info-grid span { display: block; color: #697386; font-size: 12px; margin-bottom: 6px; }
.package-info-grid strong { font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
.path-box { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px; border-radius: 7px; background: #f3f8ff; border: 1px solid #d7e8ff; }
.path-box span { color: #697386; font-size: 12px; }
.path-box strong { overflow-wrap: anywhere; }
.folder-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.folder-grid span { padding: 12px; border-radius: 7px; border: 1px solid #edf1f7; background: #fbfcfe; color: #24518f; font-weight: 600; }
.file-link-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.file-link-row a { padding: 7px 10px; border-radius: 6px; border: 1px solid #d7e8ff; background: #f3f8ff; color: #1677ff; text-decoration: none; }
.tail-template-form { display: flex; flex-direction: column; gap: 12px; }
.tail-template-preview { width: 180px; aspect-ratio: 1; object-fit: cover; border-radius: 8px; border: 1px solid #e5eaf3; }
@media (max-width: 1500px) {
  .upload-layout { grid-template-columns: 320px minmax(0, 1fr); }
  .product-info-card { grid-column: 1 / -1; }
  .rule-row { grid-template-columns: 34px 150px repeat(2, minmax(160px, 1fr)); }
  .asset-package-header,
  .asset-shop-row { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .workspace-header, .step-heading { flex-direction: column; }
  .upload-layout, .product-form-grid { grid-template-columns: 1fr; }
  .rule-row { grid-template-columns: 1fr; }
}
</style>


