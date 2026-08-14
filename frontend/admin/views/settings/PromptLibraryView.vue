<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Download, MagicStick, Picture, Refresh, Search, Setting, UploadFilled, View } from "@element-plus/icons-vue";
import { downloadUrl, generateAiCommerceCopy, generateAiImages, pullAiImageTaskResult, withImageToken } from "../../api/tools/aiImageGenerator";
import { createMaterialAsset, listMaterialAssets, updateMaterialAsset } from "../../api/materialAssets";
import { apiClient } from "../../utils/api";
import { openAiVariantLabWindow } from "../../utils/ai-variant-lab-window";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import {
  createAiTaskSnapshot,
  resolveAiStrategyPlan as resolveLocalAiStrategyPlan
} from "../../config/aiStrategyLibrary";
import {
  createAiStrategy,
  createAiStrategyLayerRule,
  deleteAiStrategy,
  listAiStrategies,
  listAiStrategyLayerRules,
  resolveAiStrategyPlan as resolveRemoteAiStrategyPlan,
  updateAiStrategyLayerRule,
  updateAiStrategy
} from "../../api/settings/aiStrategies";
import {
  createAiPromptTemplate,
  deleteAiPromptTemplate,
  duplicateAiPromptTemplate,
  listAiPromptTemplates,
  renderAiPromptTemplate,
  setDefaultAiPromptTemplate,
  updateAiPromptTemplate
} from "../../api/settings/aiPromptTemplates";
import { createWritebackStrategies } from "./writebackStrategies";

const router = useRouter();
const route = useRoute();
const AI_WORKBENCH_DRAFT_PREFIX = "aiVisualWorkbenchDraft:";

function createWorkbenchId() {
  return `aiwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const sceneOptions = [
  { label: "平台规则模板", value: "platform_rule" },
  { label: "产品类型模板", value: "product_rule" },
  { label: "品牌车型模板", value: "brand_rule" },
  { label: "风格模板", value: "main_image_variant" },
  { label: "负向规则模板", value: "global_negative" },
  { label: "文案生成模板", value: "title_generation" }
];

const modeOptions = [
  { label: "文生图", value: "text_to_image" },
  { label: "图生图", value: "image_to_image" },
  { label: "局部替换", value: "inpaint" },
  { label: "文本生成", value: "text" },
  { label: "全局规则", value: "global" }
];

const variantModes = [
  { key: "main_image_variant", title: "主图裂变", text: "生成多套主图方案" },
  { key: "multi_model_variant", title: "多车型裂变", text: "批量生成车型素材" },
  { key: "logo_text_replace", title: "Logo/文字替换", text: "保持构图局部替换" },
  { key: "title_generation", title: "标题标签生成", text: "生成标题、标签、描述" },
  { key: "detail_image", title: "详情图生成", text: "扩展详情页素材" }
];

const styleOptions = [
  { key: "high_click", title: "高点击基础图风", prompt: "high click-through ecommerce main image, clean base product layout, stronger product contrast, clear selling point visual hierarchy" },
  { key: "premium", title: "高端原厂风", prompt: "premium OEM style, refined studio lighting, realistic material texture" },
  { key: "minimal", title: "极简高级风", prompt: "minimal premium ecommerce layout, restrained clean background, refined lighting, clear product silhouette" },
  { key: "white", title: "白底清晰风", prompt: "clean white background, sharp product edges, natural shadow" },
  { key: "scene", title: "安装场景风", prompt: "realistic installation scene, practical usage environment" },
  { key: "ozon", title: "Ozon爆款风", prompt: "Ozon marketplace high-click main image, strong product focus" },
  { key: "ins", title: "INS生活方式风", prompt: "lifestyle inspired composition, clean social-commerce visual, modern soft light, tasteful scene" },
  { key: "custom", title: "自定义Prompt", prompt: "" }
];

const optimizationGroups = [
  {
    title: "图片优化",
    type: "image",
    items: [
      { key: "main_image_redo", title: "主图重做", text: "重做当前主图，提高点击率", variantMode: "main_image_variant" },
      { key: "multi_model_variant", title: "主图多车型裂变", text: "每个车型生成独立主图", variantMode: "multi_model_variant" },
      { key: "multi_ratio_variant", title: "主图多尺寸裂变", text: "按 3:4、1:1、4:5 输出多比例", variantMode: "main_image_variant" },
      { key: "logo_text_replace", title: "Logo / 文字替换", text: "保持构图，只替换文字区域", variantMode: "logo_text_replace" },
      { key: "detail_image_redo", title: "详情图重做", text: "生成卖点、安装、尺寸说明图", variantMode: "detail_image" },
      { key: "installation_scene", title: "安装场景图生成", text: "生成安装和使用场景素材", variantMode: "detail_image" },
      { key: "white_bg_image", title: "白底图生成", text: "输出干净白底图", variantMode: "main_image_variant" }
    ]
  },
  {
    title: "文案优化",
    type: "copy",
    items: [
      { key: "title_optimize", title: "标题优化", text: "生成高搜索、高点击标题", variantMode: "title_generation" },
      { key: "tag_optimize", title: "标签优化", text: "生成 Ozon 搜索标签", variantMode: "title_generation" },
      { key: "description_optimize", title: "描述优化", text: "重写描述和简介", variantMode: "title_generation" },
      { key: "selling_point_extract", title: "卖点提炼", text: "提炼核心卖点与功能词", variantMode: "title_generation" }
    ]
  },
  {
    title: "数据诊断驱动",
    type: "diagnosis",
    items: [
      { key: "low_exposure", title: "曝光低", text: "优化标题 / 标签 / 关键词", variantMode: "title_generation" },
      { key: "low_ctr", title: "点击率低", text: "优化主图", variantMode: "main_image_variant" },
      { key: "low_conversion", title: "转化率低", text: "优化详情图、安装图、信任感", variantMode: "detail_image" },
      { key: "high_cart_low_order", title: "加购高成交低", text: "优化详情页和价格理由", variantMode: "detail_image" },
      { key: "high_ad_cost", title: "广告花费高", text: "生成多版本主图做 A/B 测试", variantMode: "main_image_variant" }
    ]
  }
];

const strategyGroups = {
  image: [
    { key: "high_click", title: "高点击基础图风", text: "强化主体和基础主图转化" },
    { key: "premium", title: "高端原厂风", text: "质感、材质、品牌感更强" },
    { key: "white", title: "白底清晰风", text: "适合白底图和标准主图" },
    { key: "scene", title: "安装场景风", text: "突出安装和使用场景" },
    { key: "ozon", title: "Ozon爆款风", text: "平台点击导向" },
    { key: "custom", title: "自定义 Prompt", text: "使用自定义风格要求" }
  ],
  title: [
    { key: "search_title", title: "高搜索标题", text: "覆盖核心搜索词" },
    { key: "click_title", title: "高点击标题", text: "强化卖点和适配车型" },
    { key: "model_precise_title", title: "车型精准标题", text: "品牌车型靠前" },
    { key: "universal_title", title: "通用款标题", text: "适合通用产品" },
    { key: "competitor_diff_title", title: "竞品差异化标题", text: "突出材质、安装、套装差异" }
  ],
  tags: [
    { key: "ozon_search_tags", title: "Ozon搜索标签", text: "覆盖平台搜索习惯" },
    { key: "brand_tags", title: "品牌词标签", text: "围绕品牌扩展" },
    { key: "model_tags", title: "车型词标签", text: "围绕车型扩展" },
    { key: "category_tags", title: "类目词标签", text: "围绕产品类目扩展" },
    { key: "material_function_tags", title: "材质功能标签", text: "材质、功能、场景词" }
  ],
  detail: [
    { key: "selling_point_detail", title: "卖点说明图", text: "突出核心卖点" },
    { key: "install_steps", title: "安装步骤图", text: "降低理解成本" },
    { key: "material_detail", title: "材质细节图", text: "突出质感和耐用性" },
    { key: "usage_scene", title: "使用场景图", text: "补充真实使用场景" },
    { key: "size_detail", title: "尺寸说明图", text: "降低售前疑问" },
    { key: "kit_list", title: "套装清单图", text: "展示数量和配件" },
    { key: "compare_detail", title: "对比图", text: "突出升级点" }
  ]
};

const assetGroups = [
  { title: "图片资产", items: ["主图", "详情图"] },
  { title: "文案资产", items: ["标题", "标签", "描述"] }
];

const detailImageTypeOptions = [
  "安装图",
  "白底说明图",
  "材质细节图",
  "尺寸说明图",
  "对比图",
  "套装清单图",
  "使用场景图",
  "信任感图"
];

const resultTabs = [
  { name: "images", label: "图片结果" },
  { name: "titles", label: "标题结果" },
  { name: "tags", label: "标签结果" },
  { name: "descriptions", label: "描述结果" },
  { name: "writebacks", label: "回写记录" }
];

const diagnosisOptions = [
  { key: "low_exposure", title: "曝光低", advice: "建议优化标题、标签、关键词" },
  { key: "low_ctr", title: "点击率低", advice: "建议优化主图" },
  { key: "low_conversion", title: "转化率低", advice: "建议优化详情图、安装图、信任感图片" },
  { key: "high_cart_low_order", title: "加购高成交低", advice: "建议优化详情页、价格理由、材质说明、评价图" },
  { key: "high_ad_cost", title: "广告花费高", advice: "建议生成多版本主图做 A/B 测试" }
];

const commerceAiModes = [
  {
    title: "商品优化 AI",
    subtitle: "让一个已有链接变得更强",
    items: [
      { key: "low_ctr", title: "提升点击率", text: "CTR / 主图点击优化" },
      { key: "low_exposure", title: "提升曝光", text: "SEO / 标题标签关键词" },
      { key: "low_conversion", title: "提升转化率", text: "CVR / 详情图与信任感" },
      { key: "decision_cost", title: "降低决策成本", text: "安装、尺寸、材质解释" },
      { key: "premium_feel", title: "提升高级感", text: "质感、构图、客单价感知" },
      { key: "trust_feel", title: "提升信任感", text: "对比、细节、真实使用场景" }
    ]
  },
  {
    title: "商品裂变 AI",
    subtitle: "让一个商品扩散成更多商品",
    items: [
      { key: "multi_model_variant", title: "多型号铺货", text: "车型/SKU 扩散" },
      { key: "multi_scene_variant", title: "多场景铺货", text: "安装、礼盒、白底、场景" },
      { key: "multi_persona_variant", title: "多人群铺货", text: "家用、商务、礼品人群" },
      { key: "multi_ratio_variant", title: "多尺寸铺货", text: "3:4 / 1:1 / 4:5" },
      { key: "multi_color_variant", title: "多颜色铺货", text: "颜色与材质变体" },
      { key: "multi_style_variant", title: "多风格铺货", text: "高端、极简、爆款风格" }
    ]
  }
];

const styleBiasOptions = [
  { key: "premium", title: "高端" },
  { key: "minimal", title: "极简" },
  { key: "ozon", title: "爆款" },
  { key: "ins", title: "INS" },
  { key: "white", title: "白底" },
  { key: "scene", title: "安装场景" }
];

const WORKBENCH_MODE_OPTIONS = [
  { label: "图片任务", value: "image" },
  { label: "文本任务", value: "text" }
];
const IMAGE_OUTPUT_ITEMS = ["主图", "详情图"];
const TEXT_OUTPUT_ITEMS = ["标题", "标签", "描述"];
const TEXT_WRITEBACK_ITEMS = ["标题", "标签", "描述", "富文本"];
const TEXT_TASK_OPTIONS = [
  { key: "标题", goalKey: "title_optimize", title: "标题", text: "优化搜索结构和点击表达" },
  { key: "标签", goalKey: "tag_optimize", title: "标签", text: "补齐搜索标签和类目词" },
  { key: "描述", goalKey: "description_optimize", title: "描述", text: "重写卖点说明并联动富文本" }
];
const TEXT_OPTIMIZATION_KEYS = ["title_optimize", "tag_optimize", "description_optimize", "selling_point_extract", "low_exposure"];
const TEXT_STRATEGY_MAP = {
  title_optimize: {
    defaults: ["高搜索标题结构", "高点击标题表达", "车型前置标题"],
    optional: ["品牌词强化", "材质功能词补充"],
    group: "标题策略"
  },
  tag_optimize: {
    defaults: ["核心搜索标签", "车型标签扩展", "类目标签补充"],
    optional: ["材质功能标签", "场景标签补充"],
    group: "标签策略"
  },
  description_optimize: {
    defaults: ["核心卖点重写", "适配关系说明", "安装与使用描述"],
    optional: ["信任感补充", "售后说明补充"],
    group: "描述策略"
  },
  selling_point_extract: {
    defaults: ["卖点提炼", "功能词提炼", "人群场景提炼"],
    optional: ["材质优势补充", "差异化表达"],
    group: "卖点策略"
  },
  low_exposure: {
    defaults: ["高搜索标题结构", "核心搜索标签", "核心卖点重写"],
    optional: ["车型词覆盖", "长尾词补充", "材质功能词强化"],
    group: "文本综合策略"
  }
};

const categoryStrategyRules = [
  {
    category: "门槛条",
    aliases: ["门槛", "踏板", "迎宾踏板", "threshold", "sill"],
    summary: "适合突出车型、安装位置、材质厚度和套装数量。",
    goals: {
      low_ctr: {
        recommendedStrategies: ["车型信息强化", "主图主体强化", "安装位置强化", "套装数量强化"],
        optionalStrategies: ["价格感强化", "长度尺寸强化", "品牌质感强化"],
        imageStyles: ["premium", "high_click", "white"],
        recommendedAssets: ["主图", "标题", "标签"],
        promptModules: ["车型强化模块", "高点击构图模块", "门槛条安装区域模块"]
      },
      low_conversion: {
        recommendedStrategies: ["安装场景说明", "材质细节说明", "尺寸信息说明", "对比说明"],
        optionalStrategies: ["套装清单说明", "耐磨说明", "安装前后对比"],
        imageStyles: ["scene", "premium"],
        recommendedAssets: ["详情图", "安装图", "描述"],
        promptModules: ["安装步骤模块", "材质细节模块", "尺寸说明模块"]
      },
      low_exposure: {
        recommendedStrategies: ["高搜索标题结构", "车型词覆盖", "材质功能词强化", "标签扩展"],
        optionalStrategies: ["俄语标题优化", "长尾词扩展", "安装位置关键词"],
        imageStyles: ["white", "high_click"],
        recommendedAssets: ["标题", "标签"],
        promptModules: ["Ozon标题SEO模块", "门槛条关键词模块"]
      }
    }
  },
  {
    category: "钥匙壳",
    aliases: ["钥匙", "钥匙套", "key case", "key cover"],
    summary: "适合突出质感、按键清晰度、保护性和手持场景。",
    goals: {
      low_ctr: {
        recommendedStrategies: ["高级质感强化", "手持场景强化", "主体占比70%", "车型适配强化"],
        optionalStrategies: ["礼盒感强化", "金属质感强化", "颜色质感强化"],
        imageStyles: ["premium", "ozon", "white"],
        recommendedAssets: ["主图", "标题"],
        promptModules: ["钥匙壳质感模块", "手持场景模块", "车型适配模块"]
      },
      low_conversion: {
        recommendedStrategies: ["按键清晰说明", "包裹保护说明", "材质细节说明", "实拍对比说明"],
        optionalStrategies: ["手感说明", "防摔说明", "细节微距"],
        imageStyles: ["premium", "scene"],
        recommendedAssets: ["详情图", "描述", "卖点"],
        promptModules: ["按键细节模块", "保护性说明模块", "材质微距模块"]
      },
      low_exposure: {
        recommendedStrategies: ["车型词覆盖", "钥匙壳类目词覆盖", "材质词覆盖", "标签扩展"],
        optionalStrategies: ["颜色词扩展", "保护套长尾词", "品牌词组合"],
        imageStyles: ["white", "ozon"],
        recommendedAssets: ["标题", "标签"],
        promptModules: ["钥匙壳SEO模块", "材质功能标签模块"]
      }
    }
  },
  {
    category: "防蚊网",
    aliases: ["防蚊", "纱窗", "车窗网", "mosquito", "mesh"],
    summary: "适合突出露营场景、通风、防虫效果和安装方式。",
    goals: {
      low_ctr: {
        recommendedStrategies: ["露营场景强化", "防虫效果强化", "主体占比70%", "车窗适配强化"],
        optionalStrategies: ["夜晚场景强化", "家庭出游场景", "通风感强化"],
        imageStyles: ["scene", "ozon"],
        recommendedAssets: ["主图", "场景图", "标题"],
        promptModules: ["露营场景模块", "防虫效果模块", "车窗安装模块"]
      },
      low_conversion: {
        recommendedStrategies: ["安装方式说明", "使用效果说明", "通风说明", "尺寸适配说明"],
        optionalStrategies: ["夜晚防虫说明", "材质细节", "收纳说明"],
        imageStyles: ["scene", "white"],
        recommendedAssets: ["详情图", "安装图", "描述"],
        promptModules: ["安装说明模块", "使用效果模块", "尺寸说明模块"]
      }
    }
  },
  {
    category: "通用汽车配件",
    aliases: ["汽车用品", "汽车配件", "auto accessory"],
    summary: "通用策略，适合缺少明确类目时兜底。",
    goals: {
      low_ctr: {
        recommendedStrategies: ["主图主体强化", "车型信息强化", "高对比点击构图", "A/B主图套组"],
        optionalStrategies: ["价格感强化", "使用场景强化", "品牌质感强化"],
        imageStyles: ["premium", "high_click", "white"],
        recommendedAssets: ["主图", "标题", "标签"],
        promptModules: ["通用高点击构图模块", "车型强化模块"]
      },
      low_exposure: {
        recommendedStrategies: ["高搜索标题结构", "核心关键词覆盖", "车型词覆盖", "标签扩展"],
        optionalStrategies: ["俄语标题优化", "长尾词扩展", "材质功能词强化"],
        imageStyles: ["white", "ozon"],
        recommendedAssets: ["标题", "标签"],
        promptModules: ["Ozon标题SEO模块", "标签扩展模块"]
      },
      low_conversion: {
        recommendedStrategies: ["安装场景说明", "材质细节说明", "尺寸信息说明", "信任感强化"],
        optionalStrategies: ["对比说明", "套装清单说明", "售后信任说明"],
        imageStyles: ["scene", "premium"],
        recommendedAssets: ["详情图", "描述", "卖点"],
        promptModules: ["详情图转化模块", "信任感说明模块"]
      }
    }
  }
];

const outputOptions = assetGroups.flatMap((group) => group.items);
const ratioOptions = ["3:4", "1:1", "4:5"];
const IMAGE_GENERATION_CONCURRENCY = 3;
const COPY_GENERATION_CONCURRENCY = 5;
const WRITEBACK_CONCURRENCY = 3;

const loading = ref(false);
const workbenchId = computed(() => String(route.query.workbenchId || "").trim());
const workbenchDraftStorageKey = computed(() => `${AI_WORKBENCH_DRAFT_PREFIX}${workbenchId.value || "default"}`);
const aiWorkbenchReady = ref(false);
let aiWorkbenchSaveTimer = 0;
const generating = ref(false);
const templates = ref([]);
const selectedTemplateId = ref(null);
const activeImage = ref("");
const previewPositivePrompt = ref("");
const previewNegativePrompt = ref("");
const promptEditorState = reactive({
  positivePrompt: "",
  negativePrompt: "",
  variablesJson: "{}"
});
const previewContext = reactive({
  targetModel: "",
  strategyTitles: [],
  job: {}
});

const strategyDrawer = ref(false);
const diagnosisDrawer = ref(false);
const productInfoDrawer = ref(false);
const productInfoMode = ref("edit");
const savingProductInfo = ref(false);
const sourceSubmitMode = ref("new_selection");
const workbenchTaskMode = ref("image");
const activeCommerceMode = ref("optimization");
const activeConfigTab = ref("output");
const strategyEditorMode = ref("optimization");
const strategyEditorGoalKey = ref("low_ctr");
const strategyEditorPlanTitle = ref("");
const templateCenterVisible = ref(false);
const strategyLibraryVisible = ref(false);
const strategyLayerRules = ref([]);
const strategyNodeDialogVisible = ref(false);
const strategyNodeSaving = ref(false);
const strategyNodeMode = ref("plan");
const sourceDialogVisible = ref(false);
const sourceOnlineProducts = ref([]);
const sourceSelections = ref([]);
const sourceCollectors = ref([]);
const sourceListingRecords = ref([]);
const sourceAssets = ref([]);
const sourceTab = ref("online_products");
const sourceLoading = ref(false);
const sourceFilters = reactive({
  online_products: { keyword: "", page: 1, pageSize: 10, total: 0 },
  selection: { keyword: "", page: 1, pageSize: 10, total: 0 },
  collector: { keyword: "", page: 1, pageSize: 10, total: 0 },
  listing_records: { keyword: "", page: 1, pageSize: 10, total: 0 }
});
const remoteStrategyPlan = ref(null);
const strategyPlanLoading = ref(false);
const sourceImportingId = ref("");
const routeSelectionImporting = ref(false);
const importedRouteSelectionId = ref("");
const importedRouteCollectorSku = ref("");
const importedRouteOnlineProductSignature = ref("");
const importedRouteDraftSignature = ref("");
const importedRouteListingRecordId = ref("");
const importedRouteListingRecordSignature = ref("");
const sourceOnlineProductsLoaded = ref(false);
const sourceSelectionsLoaded = ref(false);
const sourceCollectorsLoaded = ref(false);
const sourceListingRecordsLoaded = ref(false);
const sourceAssetsLoaded = ref(false);
const referenceUploadInputRef = ref(null);
const templateSearch = ref("");
const templateCategory = ref("");
const savingTemplate = ref(false);
const strategyLibrarySearch = ref("");
const strategyLibraryGoal = ref("");
const strategyLibraryRows = ref([]);
const strategyLibraryLoading = ref(false);
const savingStrategy = ref(false);
const sourceImageRenderKey = ref(0);
const strategyNodeForm = reactive({
  strategyId: null,
  type: "plan",
  title: "",
  key: "",
  text: "",
  positivePrompt: "",
  negativePrompt: ""
});
const strategyNodeDialogTitle = computed(() => ({
  tree: "类目树编辑",
  goal: "GOAL 编辑",
  plan: "PLAN 编辑"
}[strategyNodeMode.value] || "策略节点编辑"));
const taskStatus = ref("待生成");
const activeResultTab = ref("images");
const logs = ref([]);
const results = ref([]);
const sourceFieldPrefsKey = "ozon:main-image-variant:source-fields:v1";
const defaultSourceFieldKeys = [
  "productName",
  "categoryName",
  "title",
  "brandModel",
  "materialColor",
  "quantity",
  "package",
  "sellingPoints",
  "tags",
  "summary",
  "sourceImageUrl"
];
const visibleSourceFieldKeys = ref([...defaultSourceFieldKeys]);
const demoReferenceImageUrl = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960" viewBox="0 0 720 960">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#f8fbff"/>
      <stop offset="1" stop-color="#e8f2ff"/>
    </linearGradient>
    <linearGradient id="case" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#111827"/>
      <stop offset="1" stop-color="#374151"/>
    </linearGradient>
  </defs>
  <rect width="720" height="960" rx="36" fill="url(#bg)"/>
  <rect x="110" y="112" width="500" height="736" rx="32" fill="#fff" opacity=".82"/>
  <g transform="translate(210 210)">
    <path d="M150 0c82 0 150 68 150 150v250c0 52-42 94-94 94H94c-52 0-94-42-94-94V150C0 68 68 0 150 0Z" fill="url(#case)"/>
    <circle cx="150" cy="118" r="44" fill="#f3f4f6"/>
    <rect x="77" y="212" width="146" height="42" rx="21" fill="#6b7280"/>
    <rect x="77" y="278" width="146" height="42" rx="21" fill="#6b7280"/>
    <rect x="77" y="344" width="146" height="42" rx="21" fill="#6b7280"/>
    <path d="M150 472c37 0 68 30 68 68s-31 68-68 68-68-30-68-68 31-68 68-68Z" fill="#d1d5db"/>
    <circle cx="150" cy="540" r="34" fill="#fff"/>
  </g>
  <text x="360" y="802" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#111827">DEMO KEY CASE</text>
  <text x="360" y="842" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="#667085">sample reference image</text>
</svg>
`)}`;

const task = reactive({
  productName: "【演示案例】TENET T7 TPU汽车钥匙壳",
  categoryName: "汽车用品 / 汽车配件 / 汽车钥匙套",
  title: "",
  brand: "TENET",
  vehicleModel: "T7",
  material: "TPU",
  color: "黑色",
  quantity: 1,
  productType: "汽车钥匙壳",
  sellingPoints: "柔软防刮，贴合钥匙轮廓，按键清晰，日常防摔防磨，适合TENET T7车钥匙。",
  productTags: "TENET T7, 汽车钥匙壳, TPU保护套, 防刮, 黑色",
  summary: "这是系统内置的演示案例，用于展示导入商品前的AI优化工作流。实际使用时请点击导入素材或上传参考图替换为真实商品。",
  richContent: "",
  detailImageCount: 0,
  videoCount: 0,
  useSourceImageAsReference: true,
  writeBackCurrentAsset: true,
  packageWeightG: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  logisticsRuleName: "",
  sourcePlatform: "",
  supplierName: "",
  purchaseUrl: "",
  purchaseCost: "",
  domesticShipping: "",
  handlingFee: "",
  salePrice: "",
  labelPrice: "",
  exchangeRate: "",
  supplierNote: "",
  sourceImageUrl: demoReferenceImageUrl,
  sourceImageOriginalUrl: demoReferenceImageUrl,
  sourceType: "demo",
  sourceId: "",
  sourceSelectionId: null,
  sourceCollectorSku: "",
  sourceListingRecordId: "",
  sourcePackageId: "",
  sourceLabel: "演示案例：钥匙壳样例，请导入真实素材后再生成",
  optimizationTarget: "low_ctr",
  strategyKey: "high_click",
  selectedStrategies: [],
  variantMode: "main_image_variant",
  targetInput: "",
  targets: [],
  style: "high_click",
  customPrompt: "",
  outputs: ["主图"],
  detailImageTypes: ["安装图", "材质细节图", "尺寸说明图"],
  ratio: "3:4",
  imageCount: 1,
  platform: "Ozon",
  subjectRatio: 70,
  lockGeometry: true,
  promptModules: {
    platformRule: "Ozon marketplace product image, clean commercial layout, no watermark.",
    productRule: "Auto accessory product, keep product structure and material accurate.",
    brandRule: "Target brand/model: {{target_model}}. Do not imply official authorization.",
    styleRule: "",
    compositionRule: "Main product occupies about 70% of the frame, balanced composition, marketplace ready.",
    userExtraPrompt: "",
    negativePrompt: "No watermark. No fake certification. No distorted product. No unreadable text. No extra accessories."
  },
  advancedPositivePrompt: "",
  advancedNegativePrompt: "",
  variablesJson: "{}"
});

const productInfoForm = reactive({});

const templateForm = reactive(createBlankTemplate());
const strategyForm = reactive(createBlankStrategy());

const selectedStyle = computed(() => styleOptions.find((item) => item.key === task.style) || styleOptions[0]);
const selectedVariantMode = computed(() => variantModes.find((item) => item.key === task.variantMode) || variantModes[0]);
const flatOptimizationTargets = computed(() => optimizationGroups.flatMap((group) => group.items.map((item) => ({ ...item, groupType: group.type, groupTitle: group.title }))));
function resolveTextGoalKey(outputs = []) {
  const normalized = Array.isArray(outputs) ? outputs : [];
  const hasTitle = normalized.includes("标题");
  const hasTag = normalized.includes("标签");
  const hasDescription = normalized.includes("描述");
  if (hasTitle && hasTag && hasDescription) return "low_exposure";
  if (hasDescription) return "description_optimize";
  if (hasTag) return "tag_optimize";
  if (hasTitle) return "title_optimize";
  return "low_exposure";
}
const selectedOptimizationTarget = computed(() => flatOptimizationTargets.value.find((item) => item.key === task.optimizationTarget) || flatOptimizationTargets.value[0]);
const isTextWorkbench = computed(() => workbenchTaskMode.value === "text");
const activeGoalKey = computed(() => (isTextWorkbench.value ? resolveTextGoalKey(task.outputs) : task.optimizationTarget));
const selectedTextTaskOptions = computed(() => TEXT_TASK_OPTIONS.filter((item) => task.outputs.includes(item.key)));
const filteredOptimizationTargets = computed(() => flatOptimizationTargets.value.filter((item) => (
  isTextWorkbench.value ? TEXT_OPTIMIZATION_KEYS.includes(item.key) : !TEXT_OPTIMIZATION_KEYS.includes(item.key)
)));
const workbenchCommerceModes = computed(() => {
  if (isTextWorkbench.value) {
    return [{
      title: "文本优化",
      subtitle: "围绕标题、标签、描述和富文本回写生成",
      items: filteredOptimizationTargets.value
    }];
  }
  return commerceAiModes;
});
const activeWorkbenchModes = computed(() => {
  if (isTextWorkbench.value) return workbenchCommerceModes.value;
  return workbenchCommerceModes.value.filter((_, index) => (
    activeCommerceMode.value === "optimization" ? index === 0 : index === 1
  ));
});
const currentStrategyType = computed(() => {
  const key = activeGoalKey.value;
  if (["title_optimize", "low_exposure"].includes(key)) return "title";
  if (["tag_optimize"].includes(key)) return "tags";
  if (["detail_image_redo", "installation_scene", "low_conversion", "high_cart_low_order", "description_optimize", "selling_point_extract"].includes(key)) return "detail";
  return selectedOptimizationTarget.value?.groupType === "copy" ? "title" : "image";
});
const currentStrategyOptions = computed(() => strategyGroups[currentStrategyType.value] || strategyGroups.image);
const selectedStrategy = computed(() => currentStrategyOptions.value.find((item) => item.key === task.strategyKey) || currentStrategyOptions.value[0]);
const isVariantWorkflow = computed(() => strategyBusinessMode.value === "product_variant");
const activeTemplate = computed(() => templates.value.find((item) => item.id === selectedTemplateId.value));
const enabledTemplates = computed(() => templates.value.filter((item) => item.enabled));
const filteredTemplates = computed(() => {
  const keyword = templateSearch.value.trim().toLowerCase();
  return templates.value.filter((item) => {
    if (templateCategory.value && item.scene !== templateCategory.value) return false;
    if (!keyword) return true;
    return [item.name, item.description, item.scene, item.mode].some((value) => String(value || "").toLowerCase().includes(keyword));
  });
});
const strategyGoalOptions = computed(() => flatOptimizationTargets.value.map((item) => ({ label: item.title, value: item.key })));
const strategyAssetOptions = [
  { label: "主图", value: "main_image" },
  { label: "标题", value: "title" },
  { label: "标签", value: "tags" },
  { label: "详情图", value: "detail_image" },
  { label: "描述", value: "description" }
];
const strategyBusinessModeOptions = [
  { label: "商品优化AI", value: "product_optimization" },
  { label: "商品裂变AI", value: "product_variant" }
];
const globalNegativePromptRules = [
  "No Chinese text or Chinese characters.",
  "Do not output any Chinese characters in title, tags, description, or rich-content text.",
  "The final returned commerce copy must be Russian only."
];
const filteredStrategyRows = computed(() => {
  const keyword = strategyLibrarySearch.value.trim().toLowerCase();
  return strategyLibraryRows.value.filter((item) => {
    if (strategyLibraryGoal.value && !(item.applicable_goals || []).includes(strategyLibraryGoal.value)) return false;
    if (!keyword) return true;
    return [
      item.title,
      item.strategy_key,
      ...(item.aliases || []),
      ...(item.positive_modules || []),
      ...(item.negative_modules || [])
    ].some((value) => String(value || "").toLowerCase().includes(keyword));
  });
});
const strategyBusinessMode = computed(() => activeGoalKey.value?.startsWith("multi_") ? "product_variant" : "product_optimization");
const strategyCategoryText = computed(() => [
  task.platform,
  task.categoryName,
  task.productType,
  task.productName,
  task.title,
  task.sellingPoints
].filter(Boolean).join(" "));
const localAiStrategyPlan = computed(() => resolveLocalAiStrategyPlan({
  businessMode: strategyBusinessMode.value,
  goalKey: activeGoalKey.value,
  selectedTitles: task.selectedStrategies,
  fallbackTitles: selectedGoalStrategies.value,
  categoryText: strategyCategoryText.value
}));
const aiStrategyPlan = computed(() => remoteStrategyPlan.value || localAiStrategyPlan.value);
function resolveStrategyPlanForTitles(strategyTitles = []) {
  return resolveLocalAiStrategyPlan({
    businessMode: strategyBusinessMode.value,
    goalKey: activeGoalKey.value,
    selectedTitles: strategyTitles,
    fallbackTitles: strategyTitles.length ? [] : selectedGoalStrategies.value.slice(0, 1),
    categoryText: strategyCategoryText.value
  });
}
function resolvePlanModulesForEditor(item = {}) {
  const row = strategyLibraryRows.value.find((strategy) => (
    strategy.strategy_key === item.strategyKey
    || strategy.strategy_key === item.key
    || strategy.title === item.title
  ));
  if (row) {
    return {
      positiveModules: row.positive_modules || row.positiveModules || [],
      negativeModules: row.negative_modules || row.negativeModules || []
    };
  }
  return item.title ? resolveStrategyPlanForTitles([item.title]) : { positiveModules: [], negativeModules: [] };
}

function defaultTreePositivePrompt(rule = {}) {
  return [
    `Strategy tree: ${rule.title || categoryTreeStatus.value.treeName}.`,
    `Category: ${currentCategoryName()}.`,
    categoryStrategyRule.value.summary ? `Category focus: ${categoryStrategyRule.value.summary}.` : "",
    "Keep the product structure, material, color, fitment, and usage scenario consistent with the imported source."
  ].filter(Boolean).join("\n");
}

function defaultTreeNegativePrompt() {
  return globalNegativePromptRules.join("\n");
}

function defaultGoalPositivePrompt(goal = {}) {
  const config = goalStrategyConfigFor(goal.key || strategyEditorGoalKey.value);
  return [
    `Business GOAL: ${goal.title || editorSelectedGoal.value?.title || ""}.`,
    goal.text ? `Problem to solve: ${goal.text}.` : "",
    (config.defaults || []).length ? `Recommended PLAN options: ${(config.defaults || []).join(", ")}.` : "",
    "Prioritize the selected GOAL while preserving all verified product facts from the source material."
  ].filter(Boolean).join("\n");
}

function defaultGoalNegativePrompt() {
  return uniquePromptLines([
    ...globalNegativePromptRules,
    "Do not invent unsupported fitment, function, material, quantity, or certification claims."
  ]).join("\n");
}

function defaultPlanPositivePrompt(item = {}) {
  const plan = resolvePlanModulesForEditor(item);
  if (plan.positiveModules?.length) return arrayToLines(plan.positiveModules);
  return [
    `Execute PLAN: ${item.title || ""}.`,
    `Business GOAL: ${editorSelectedGoal.value?.title || ""}.`,
    "Use the imported product title, category, color, fitment models, and source images as factual constraints.",
    "Generate a practical commerce optimization direction that can be reused for Ozon product assets."
  ].filter(Boolean).join("\n");
}

function defaultPlanNegativePrompt(item = {}) {
  const plan = resolvePlanModulesForEditor(item);
  return uniquePromptLines([
    ...globalNegativePromptRules,
    ...(plan.negativeModules || []),
    "Do not add unverified compatible models, dimensions, quantities, or package contents."
  ]).join("\n");
}

function buildPromptSourceRows(groups = [], targetModel = "") {
  const variables = buildVariables(targetModel);
  return groups.flatMap((group) => uniquePromptLines(group.lines || []).map((line) => ({
    source: group.source,
    line: renderText(line, variables)
  }))).filter((row) => row.line);
}

function buildWorkbenchPositivePromptSources(strategyTitles = selectedStrategyTitles.value, job = {}) {
  const strategyPlan = resolveStrategyPlanForTitles(strategyTitles);
  const outputInstruction = job.type === "主图"
    ? "Asset output: generate one Ozon main image. Focus on click-through, clear product subject, vehicle fitment, and marketplace-safe composition."
    : job.type === "详情图"
      ? `Asset output: generate one Ozon detail image module: ${job.detailType || "详情图"}. Keep the product consistent with the source product while explaining this single module only.`
      : "Asset output: generate commerce copy only. Do not request or describe image generation.";
  if (promptEditorState.positivePrompt) {
    return [{ source: "高级正向", lines: linesToArray(promptEditorState.positivePrompt) }];
  }
  return [
    { source: "平台规则", lines: [task.promptModules.platformRule] },
    { source: "商品信息", lines: [task.promptModules.productRule, task.promptModules.brandRule] },
    { source: "决策树", lines: [`Category strategy: ${categoryStrategyRule.value.category}. ${categoryStrategyRule.value.summary || ""}`] },
    { source: "GOAL", lines: [`Business goal: ${selectedOptimizationTarget.value?.title || ""}. Single execution strategy for this asset: ${strategyTitles.join(", ") || selectedGoalStrategies.value[0] || ""}.`] },
    { source: "任务输出", lines: [outputInstruction] },
    { source: "PLAN", lines: strategyPlan.positiveModules || [] },
    { source: "裂变策略", lines: isVariantWorkflow.value ? [
      "Variant rule: keep product structure, composition, visual style, background, material, and lighting consistent across the batch.",
      "Only change the declared variant variable such as target model, color, scene, ratio, or style."
    ] : [] },
    { source: "风格策略", lines: [selectedStyle.value.prompt || task.customPrompt, task.promptModules.styleRule, task.promptModules.compositionRule] },
    { source: "用户补充", lines: [task.promptModules.userExtraPrompt, task.customPrompt] }
  ].filter((group) => uniquePromptLines(group.lines || []).length);
}

function buildWorkbenchNegativePromptSources(strategyTitles = selectedStrategyTitles.value) {
  const strategyPlan = resolveStrategyPlanForTitles(strategyTitles);
  if (promptEditorState.negativePrompt) {
    return [{ source: "高级负向", lines: linesToArray(promptEditorState.negativePrompt) }];
  }
  return [
    { source: "商品负向", lines: [task.promptModules.negativePrompt] },
    { source: "全局规则", lines: globalNegativePromptRules },
    { source: "PLAN禁用", lines: strategyPlan.negativeModules || [] }
  ].filter((group) => uniquePromptLines(group.lines || []).length);
}

function buildPositivePrompt(strategyTitles = selectedStrategyTitles.value, job = {}) {
  const strategyPlan = resolveStrategyPlanForTitles(strategyTitles);
  const outputInstruction = job.type === "主图"
    ? "Asset output: generate one Ozon main image. Focus on click-through, clear product subject, vehicle fitment, and marketplace-safe composition."
    : job.type === "详情图"
      ? `Asset output: generate one Ozon detail image module: ${job.detailType || "详情图"}. Keep the product consistent with the source product while explaining this single module only.`
      : "Asset output: generate commerce copy only. Do not request or describe image generation.";
  return task.advancedPositivePrompt || [
    task.promptModules.platformRule,
    task.promptModules.productRule,
    task.promptModules.brandRule,
    `Category strategy: ${categoryStrategyRule.value.category}. ${categoryStrategyRule.value.summary || ""}`,
    `Business goal: ${selectedOptimizationTarget.value?.title || ""}. Single execution strategy for this asset: ${strategyTitles.join(", ") || selectedGoalStrategies.value[0] || ""}.`,
    outputInstruction,
    strategyPlan.positiveModules.length ? `Strategy execution modules:\n${strategyPlan.positiveModules.map((item) => `- ${item}`).join("\n")}` : "",
    isVariantWorkflow.value ? [
      "Variant rule: keep product structure, composition, visual style, background, material, and lighting consistent across the batch.",
      "Only change the declared variant variable such as target model, color, scene, ratio, or style."
    ].join("\n") : "",
    selectedStyle.value.prompt || task.customPrompt,
    task.promptModules.styleRule,
    task.promptModules.compositionRule,
    task.promptModules.userExtraPrompt,
    task.customPrompt
  ].filter(Boolean).join("\n");
}
function buildNegativePrompt(strategyTitles = selectedStrategyTitles.value) {
  const strategyPlan = resolveStrategyPlanForTitles(strategyTitles);
  return task.advancedNegativePrompt || uniquePromptLines([
    task.promptModules.negativePrompt,
    ...globalNegativePromptRules,
    ...strategyPlan.negativeModules
  ]).join("\n");
}
const finalPrompt = computed(() => buildPositivePrompt());
const finalNegativePrompt = computed(() => buildNegativePrompt());
const workbenchPreviewJob = computed(() => previewContext.job || {});
const workbenchPreviewStrategyTitles = computed(() => (
  previewContext.strategyTitles?.length
    ? previewContext.strategyTitles
    : workbenchPreviewJob.value.strategyTitles || selectedStrategyTitles.value.slice(0, 1)
));
const workbenchPreviewTargetModel = computed(() => previewContext.targetModel || task.targets[0] || "");
const workbenchPreviewTemplateType = computed(() => {
  if (task.sourceType === "selection") return "选品池模板";
  if (task.sourceType === "online_product") return "在线商品模板";
  if (task.sourceType === "collector_box" || task.sourceType === "listing_record") return "上架模板";
  if (task.sourceType === "material_asset") return "素材模板";
  return "通用模板";
});
const workbenchPreviewTemplateHint = computed(() => {
  if (task.sourceType === "selection") return "适合优化选品信息、卖点和选品回写";
  if (task.sourceType === "online_product") return "适合围绕在线链接继续做素材和文案优化";
  if (task.sourceType === "collector_box") return "适合整理采集内容并生成上架草稿";
  if (task.sourceType === "listing_record") return "适合直接修复上架内容并覆盖提交";
  if (task.sourceType === "material_asset") return "适合修正素材资产本身的文案和关联信息";
  return "当前来源未匹配到专用模板";
});
const workbenchPreviewTemplateRows = computed(() => {
  const targetModel = workbenchPreviewTargetModel.value || task.vehicleModel || task.brand || "-";
  const baseRows = [
    { label: "来源", value: task.sourceLabel || "-" },
    { label: "模板", value: workbenchPreviewTemplateType.value },
    { label: "用途", value: workbenchPreviewTemplateHint.value },
    { label: "商品", value: task.productName || "-" },
    { label: "类目", value: task.categoryName || task.productType || "-" },
    { label: "品牌/型号", value: `${task.brand || "-"} ${task.vehicleModel || ""}`.trim() || "-" },
    { label: "目标车型", value: targetModel },
    { label: "当前输出", value: selectedWriteBackAssets.value.join(" / ") || "待选择" }
  ];
  if (task.sourceType === "selection") {
    baseRows.push(
      { label: "卖点", value: task.sellingPoints || "-" },
      { label: "标签", value: task.productTags || "-" },
      { label: "物流", value: task.logisticsRuleName || "-" }
    );
  }
  if (task.sourceType === "online_product") {
    baseRows.push(
      { label: "标题", value: task.title || "-" },
      { label: "简介", value: task.summary || "-" },
      { label: "价格", value: [task.salePrice, task.labelPrice].filter(Boolean).join(" / ") || "-" }
    );
  }
  if (task.sourceType === "collector_box" || task.sourceType === "listing_record") {
    baseRows.push(
      { label: "标题", value: task.title || "-" },
      { label: "简介", value: task.summary || "-" },
      { label: "属性", value: [task.material, task.color, task.quantity].filter(Boolean).join(" / ") || "-" }
    );
  }
  if (task.sourceType === "material_asset") {
    baseRows.push(
      { label: "资产类型", value: task.outputs.join(" / ") || "-" },
      { label: "供应商", value: task.supplierName || "-" },
      { label: "来源平台", value: task.sourcePlatform || "-" }
    );
  }
  return baseRows;
});
const workbenchPositivePromptRows = computed(() => buildPromptSourceRows(
  buildWorkbenchPositivePromptSources(workbenchPreviewStrategyTitles.value, workbenchPreviewJob.value),
  workbenchPreviewTargetModel.value
));
const workbenchNegativePromptRows = computed(() => buildPromptSourceRows(
  buildWorkbenchNegativePromptSources(workbenchPreviewStrategyTitles.value),
  workbenchPreviewTargetModel.value
));
const displayResults = computed(() => results.value.filter((item) => item.status !== "deleted"));
const imageResults = computed(() => displayResults.value.filter((item) => item.imageUrl || item.assetKind === "image"));
const titleResults = computed(() => displayResults.value.filter((item) => item.generatedTitles?.length));
const tagResults = computed(() => displayResults.value.filter((item) => item.generatedTags?.length));
const descriptionResults = computed(() => displayResults.value.filter((item) => item.generatedDescription));
const writebackResults = computed(() => displayResults.value.filter((item) => item.writeBackStatus === "已提交" || item.assetId));
const currentModeResults = computed(() => (
  isTextWorkbench.value
    ? displayResults.value.filter((item) => item.assetKind === "copy")
    : displayResults.value.filter((item) => item.assetKind === "image")
));
const currentModeHasResults = computed(() => currentModeResults.value.length > 0);
const currentModeWritebackResults = computed(() => (
  isTextWorkbench.value
    ? writebackResults.value.filter((item) => item.assetKind === "copy")
    : writebackResults.value.filter((item) => item.assetKind === "image")
));
const selectionTemplateReady = computed(() => task.sourceType === "selection" && Boolean(task.sourceSelectionId));
const sourceSubmitReady = computed(() => {
  if (task.sourceType === "selection") return Boolean(task.sourceSelectionId);
  if (task.sourceType === "online_product") return Boolean(task.sourceId);
  if (task.sourceType === "collector_box") return Boolean(task.sourceCollectorSku);
  if (task.sourceType === "listing_record") return Boolean(task.sourceListingRecordId);
  return false;
});
const writebackContext = computed(() => ({
  sourceType: task.sourceType,
  sourceSubmitMode: sourceSubmitMode.value,
  sourceSelectionId: task.sourceSelectionId,
  sourceCollectorSku: task.sourceCollectorSku,
  sourceListingRecordId: task.sourceListingRecordId,
  selectionTemplateReady: selectionTemplateReady.value
}));
const writebackStrategies = computed(() => createWritebackStrategies({
  task,
  router,
  apiClient,
  selectionTemplateReady: selectionTemplateReady.value,
  createDerivedSelectionRecord,
  safeOverwriteSelectionSource,
  forceOverwriteSelectionSource,
  overwriteSelectionSource,
  overwriteCollectorSource,
  overwriteListingRecordSource,
  bundleMaySyncRichContent
}));
const activeWritebackStrategy = computed(() => writebackStrategies.value[sourceSubmitMode.value] || writebackStrategies.value.asset_only);
const selectionWritebackModeOptions = computed(() => {
  if (task.sourceType !== "selection") return [];
  return [
    {
      value: "new_selection",
      label: "生成新记录",
      description: "保留原选品池母数据，AI 结果落到新的派生选品记录。"
    },
    {
      value: "safe_overwrite_selection",
      label: "安全回写",
      description: "只更新 AI 承接字段、备注、图片和富文本，尽量不碰母数据。"
    },
    {
      value: "force_overwrite_selection",
      label: "强制覆盖",
      description: "直接覆盖标题、标签、描述等母数据字段，适合明确要替换原文案时使用。"
    }
  ];
});
const selectionWritebackModeHelp = computed(() => {
  if (task.sourceType !== "selection") return "";
  if (sourceSubmitMode.value === "force_overwrite_selection") {
    return "强制覆盖会直接写入选品池标题、标签、描述等母数据字段，后续自动主题标签流程仍可能再次覆盖这些内容。";
  }
  if (sourceSubmitMode.value === "safe_overwrite_selection") {
    return "安全回写会优先写入 generated_title、generated_tags、generated_description，并把 AI 建议保存在备注区，避免和后续自动标签流程互相打架。";
  }
  return "生成新记录最稳妥，适合先沉淀 AI 结果，再人工确认是否替换当前选品池母数据。";
});
const writeBackGateText = computed(() => {
  if (!sourceSubmitReady.value) return "请先导入来源";
  return activeWritebackStrategy.value.actionLabel || "仅保存结果";
});
const copyResultSectionVisible = computed(() => (
  ["标题", "标签", "描述"].some((item) => task.outputs.includes(item))
  || titleResults.value.length
  || tagResults.value.length
  || descriptionResults.value.length
));
const imageResultSectionVisible = computed(() => (
  !isTextWorkbench.value
  && (task.outputs.some((item) => IMAGE_OUTPUT_ITEMS.includes(item)) || imageResults.value.length)
));
const copyResultWorkbenchVisible = computed(() => isTextWorkbench.value || copyResultSectionVisible.value);
const writebackResultSectionVisible = computed(() => currentModeWritebackResults.value.length > 0);
const selectedWriteBackAssets = computed(() => {
  if (isTextWorkbench.value) {
    return [...TEXT_WRITEBACK_ITEMS];
  }
  const assets = [];
  if (task.outputs.includes("主图")) assets.push("主图");
  if (task.outputs.includes("详情图")) assets.push(`详情图：${task.detailImageTypes.join(" / ") || "类目推荐模块"}`);
  return assets;
});
const textWriteBackHint = computed(() => (
  task.outputs.includes("描述")
    ? "文本任务默认优化标题、标签、描述；当描述发生变化时，会自动同步重建富文本。"
    : "文本任务默认优化标题、标签、描述。"
));
const aiRecommendations = computed(() => {
  const title = selectedOptimizationTarget.value?.title || "主图重做";
  const base = {
    low_exposure: ["Ozon爆款标题", "品牌/车型关键词前置", "补齐材质功能标签", "生成高搜索标题"],
    low_ctr: ["高点击主图风", "主体占比提升到 70%", "车型强化", "生成 3 套 A/B 主图"],
    low_conversion: ["安装场景图", "材质细节图", "尺寸说明图", "信任感详情图"],
    high_cart_low_order: ["安装步骤图", "套装清单图", "材质说明图", "价格理由图"],
    high_ad_cost: ["多版本主图 A/B 测试", "高点击主图风", "白底清晰风", "Ozon爆款风"],
    multi_model_variant: ["每个车型独立主图", "车型文字强化", "保持产品结构一致", "自动沉淀素材包"],
    title_optimize: ["高搜索标题", "车型精准标题", "核心关键词覆盖", "俄语标题结构优化"],
    tag_optimize: ["Ozon搜索标签", "品牌词标签", "车型词标签", "材质功能标签"],
    detail_image_redo: ["卖点说明图", "安装步骤图", "材质细节图", "尺寸说明图"]
  };
  return base[task.optimizationTarget] || [
    title.includes("安装") ? "安装场景风" : "高端原厂风",
    "车型强化",
    "Ozon爆款标题",
    "保留商品结构和材质"
  ];
});
const recommendedStrategyCards = computed(() => {
  const optionalMap = {
    low_ctr: ["价格感强化", "使用场景强化", "品牌质感强化"],
    low_exposure: ["竞品词扩展", "长尾词覆盖", "材质词强化"],
    low_conversion: ["评价图", "包装清单图", "售后信任图"],
    multi_model_variant: ["车型批量排序", "Logo文字替换", "多店铺素材包"]
  };
  const defaults = aiRecommendations.value.map((title) => ({ title, recommended: true }));
  const optional = (optionalMap[task.optimizationTarget] || ["白底图补充", "高级感强化", "场景图补充"]).map((title) => ({ title, recommended: false }));
  return [...defaults, ...optional];
});
const goalStrategyMap = {
  low_ctr: {
    defaults: ["主图主体强化", "车型信息强化", "高对比点击构图", "A/B主图套组"],
    optional: ["价格感强化", "使用场景强化", "品牌质感强化"],
    group: "点击策略"
  },
  low_exposure: {
    defaults: ["高搜索标题结构", "核心关键词覆盖", "车型词覆盖", "标签扩展"],
    optional: ["俄语标题优化", "长尾词扩展", "材质功能词强化"],
    group: "曝光策略"
  },
  low_conversion: {
    defaults: ["安装场景说明", "材质细节说明", "尺寸信息说明", "信任感强化"],
    optional: ["对比说明", "套装清单说明", "售后信任说明"],
    group: "转化策略"
  },
  decision_cost: {
    defaults: ["安装路径说明", "适配关系说明", "尺寸参数说明", "套装内容说明"],
    optional: ["购买理由强化", "使用前后对比", "常见疑问说明"],
    group: "决策策略"
  },
  premium_feel: {
    defaults: ["质感强化", "高级光影", "主体留白", "品牌感构图"],
    optional: ["礼盒感", "金属质感", "暗色高级感"],
    group: "质感策略"
  },
  trust_feel: {
    defaults: ["真实使用感", "材质可信说明", "安装效果证明", "细节可信展示"],
    optional: ["评价感素材", "对比证明", "耐用性说明"],
    group: "信任策略"
  },
  multi_model_variant: {
    defaults: ["车型变量替换", "主图型号强化", "标题型号替换", "标签型号覆盖", "批量任务生成"],
    optional: ["车型排序", "多店铺素材包", "同构图批量扩展"],
    group: "铺货策略"
  },
  multi_scene_variant: {
    defaults: ["场景差异化", "安装场景扩展", "白底搜索图", "礼品场景图"],
    optional: ["暗色质感场景", "节日场景", "户外场景"],
    group: "场景策略"
  },
  multi_persona_variant: {
    defaults: ["人群卖点差异", "使用场景差异", "标题人群词替换", "标签人群词覆盖"],
    optional: ["商务人群", "家庭人群", "礼品人群"],
    group: "人群策略"
  },
  multi_ratio_variant: {
    defaults: ["3:4主图版本", "1:1搜索版本", "4:5信息流版本", "主体位置自适应"],
    optional: ["白底补充版", "详情首屏版", "广告测试版"],
    group: "尺寸策略"
  },
  multi_color_variant: {
    defaults: ["颜色变量替换", "材质质感保持", "标题颜色词替换", "标签颜色词覆盖"],
    optional: ["浅色背景版", "暗色背景版", "对比色版本"],
    group: "颜色策略"
  },
  multi_style_variant: {
    defaults: ["高端版本", "极简版本", "爆款版本", "白底版本"],
    optional: ["安装场景版", "INS版本", "礼盒版本"],
    group: "风格策略"
  }
};
const matchedCategoryStrategyRule = computed(() => {
  const text = [
    task.categoryName,
    task.productType,
    task.productName,
    task.title,
    task.sellingPoints
  ].join(" ").toLowerCase();
  return categoryStrategyRules.find((rule) => rule.aliases?.some((alias) => text.includes(String(alias).toLowerCase())))
    || categoryStrategyRules.find((rule) => rule.category === "通用汽车配件")
    || categoryStrategyRules[0];
});
const activeCategoryGoalRule = computed(() => {
  const rule = matchedCategoryStrategyRule.value;
  return rule?.goals?.[activeGoalKey.value] || null;
});
const selectedGoalStrategyConfig = computed(() => {
  if (isTextWorkbench.value) {
    const keys = selectedTextTaskOptions.value.map((item) => item.goalKey);
    const merged = keys.length ? keys : [activeGoalKey.value];
    return {
      defaults: Array.from(new Set(merged.flatMap((key) => (TEXT_STRATEGY_MAP[key] || TEXT_STRATEGY_MAP.low_exposure).defaults || []))),
      optional: Array.from(new Set(merged.flatMap((key) => (TEXT_STRATEGY_MAP[key] || TEXT_STRATEGY_MAP.low_exposure).optional || []))),
      group: "文本策略"
    };
  }
  if (activeCategoryGoalRule.value) {
    return {
      defaults: activeCategoryGoalRule.value.recommendedStrategies || [],
      optional: activeCategoryGoalRule.value.optionalStrategies || [],
      group: `${matchedCategoryStrategyRule.value.category}类目策略`,
      recommendedAssets: activeCategoryGoalRule.value.recommendedAssets || [],
      imageStyles: activeCategoryGoalRule.value.imageStyles || [],
      promptModules: activeCategoryGoalRule.value.promptModules || []
    };
  }
  return goalStrategyMap[task.optimizationTarget] || goalStrategyMap.low_ctr;
});
function goalStrategyConfigFor(goalKey) {
  if (TEXT_OPTIMIZATION_KEYS.includes(goalKey)) {
    return TEXT_STRATEGY_MAP[goalKey] || TEXT_STRATEGY_MAP.low_exposure;
  }
  const rule = matchedCategoryStrategyRule.value;
  const categoryGoalRule = rule?.goals?.[goalKey] || null;
  if (categoryGoalRule) {
    return {
      defaults: categoryGoalRule.recommendedStrategies || [],
      optional: categoryGoalRule.optionalStrategies || [],
      group: `${rule.category}类目策略`,
      recommendedAssets: categoryGoalRule.recommendedAssets || [],
      imageStyles: categoryGoalRule.imageStyles || [],
      promptModules: categoryGoalRule.promptModules || []
    };
  }
  return goalStrategyMap[goalKey] || goalStrategyMap.low_ctr;
}
const selectedGoalStrategies = computed(() => selectedGoalStrategyConfig.value.defaults);
const goalStrategyCards = computed(() => [
  ...selectedGoalStrategyConfig.value.defaults.map((title) => ({
    title,
    recommended: true,
    group: selectedGoalStrategyConfig.value.group
  })),
  ...selectedGoalStrategyConfig.value.optional.map((title) => ({
    title,
    recommended: false,
    group: isTextWorkbench.value ? "补充策略" : "可选增强"
  }))
]);
const pendingGenerationTasks = computed(() => {
  const jobs = buildGenerationJobs();
  if (jobs.length) {
    return jobs.map((job, index) => ({
      type: job.type,
      title: job.targetModel
        ? `${job.strategyTitle}${job.detailType ? ` / ${job.detailType}` : ""}：${job.targetModel}`
        : `${job.strategyTitle || selectedOptimizationTarget.value?.title || "默认策略"}${job.detailType ? ` / ${job.detailType}` : ""} 方案 ${index + 1}`,
      desc: isVariantWorkflow.value
        ? "裂变任务会锁定参考图风格和产品结构，只替换当前变量。"
        : "独立策略任务会单独生成一张方案，不与其他策略混合。"
    }));
  }
  return [{
    type: task.outputs.includes("主图") ? "主图" : task.outputs.includes("详情图") ? "详情图" : "文案",
    title: "请选择一个策略",
    desc: isVariantWorkflow.value ? "裂变模式下选择一个策略，再添加车型变量。" : "商品优化模式下，每选一个策略就生成一张独立方案。"
  }];
});
const aiIssueHints = computed(() => [
  task.sourceImageUrl ? "当前主图可作为 image2 参考图，建议保持产品结构一致。" : "当前缺少参考主图，建议先导入或粘贴主图 URL。",
  `已识别类目策略：${categoryStrategyRule.value.category}，${categoryStrategyRule.value.summary}`,
  task.targets.length ? `已选择 ${task.targets.length} 个车型，可批量生成独立素材。` : "未添加目标车型，标题/标签仍可使用商品品牌作为关键词。",
  selectedOptimizationTarget.value?.text || "选择优化目标后，AI会推荐生成策略。"
]);
const categoryStrategyRule = computed(() => {
  const goal = selectedOptimizationTarget.value?.title || "提升点击率";
  const rule = matchedCategoryStrategyRule.value;
  const ctr = rule.goals?.low_ctr?.recommendedStrategies || ["主体强化", "车型强化", "高对比构图"];
  const cvr = rule.goals?.low_conversion?.recommendedStrategies || ["场景图", "细节图", "尺寸图"];
  const seo = rule.goals?.low_exposure?.recommendedStrategies || ["品牌词", "车型词", "功能词"];
  return {
    category: rule.category,
    summary: rule.summary,
    goal,
    ctr,
    cvr,
    seo,
    promptModules: activeCategoryGoalRule.value?.promptModules || []
  };
});
const importedCategoryName = computed(() => task.categoryName || task.productType || "");
const hasSpecificCategoryTree = computed(() => Boolean(importedCategoryName.value && categoryStrategyRule.value.category !== "通用汽车配件"));
const categoryTreeStatus = computed(() => ({
  category: importedCategoryName.value || "未识别类目",
  treeName: hasSpecificCategoryTree.value ? `${categoryStrategyRule.value.category}专属类目树` : "通用类目树",
  mode: hasSpecificCategoryTree.value ? "专属策略树" : "默认通用",
  description: hasSpecificCategoryTree.value
    ? "已自动匹配当前类目的专属 GOAL / PLAN。"
    : importedCategoryName.value
      ? "当前类目暂未沉淀专属树，默认使用通用 GOAL / PLAN。"
      : "导入素材后会自动识别类目；未识别时使用通用 GOAL / PLAN。"
}));
const currentLayerRule = computed(() => {
  const specific = findLayerRuleForCategory(importedCategoryName.value || categoryStrategyRule.value.category);
  return specific || strategyLayerRules.value.find((item) => item.rule_key === "global-default") || null;
});
const currentLayerGoalMap = computed(() => ({ ...(currentLayerRule.value?.goal_strategy_map || {}) }));
const currentLayerMetadata = computed(() => currentLayerRule.value?.metadata || {});
const currentLayerCustomGoals = computed(() => {
  const goals = currentLayerMetadata.value.customGoals;
  return Array.isArray(goals) ? goals.filter((item) => item && item.enabled !== false) : [];
});
const strategySummary = computed(() => ({
  platform: task.platform,
  category: categoryStrategyRule.value.category,
  target: isTextWorkbench.value
    ? (selectedTextTaskOptions.value.map((item) => item.title).join(" / ") || "文本优化")
    : (selectedOptimizationTarget.value?.title || "提升点击率"),
  recommendation: selectedStrategyTitles.value.join(isVariantWorkflow.value ? "" : " / "),
  outputs: selectedWriteBackAssets.value.slice(0, 4).join(" / ")
}));
const editorSelectedGoal = computed(() => (
  currentLayerCustomGoals.value.find((item) => item.key === strategyEditorGoalKey.value)
  || flatOptimizationTargets.value.find((item) => item.key === strategyEditorGoalKey.value)
  || selectedOptimizationTarget.value
));
const editorGoalBusinessMode = computed(() => {
  const customGoal = currentLayerCustomGoals.value.find((item) => item.key === strategyEditorGoalKey.value);
  if (customGoal?.mode === "variant") return "product_variant";
  return strategyEditorGoalKey.value?.startsWith("multi_") ? "product_variant" : "product_optimization";
});
const editorGoalStrategyConfig = computed(() => goalStrategyConfigFor(strategyEditorGoalKey.value));
const editorGoalStrategyCards = computed(() => [
  ...(editorGoalStrategyConfig.value.defaults || []).map((title) => ({
    title,
    recommended: true,
    group: editorGoalStrategyConfig.value.group
  })),
  ...(editorGoalStrategyConfig.value.optional || []).map((title) => ({
    title,
    recommended: false,
    group: "可选增强"
  }))
]);
const goalPlanGroups = computed(() => commerceAiModes.map((mode, index) => {
  const modeKey = index === 0 ? "optimization" : "variant";
  const customGoals = currentLayerCustomGoals.value.filter((item) => (item.mode || "optimization") === modeKey);
  const customGoalMap = new Map(customGoals.map((item) => [item.key, item]));
  const items = mode.items.map((item) => ({
    ...item,
    ...(customGoalMap.get(item.key) || {}),
    custom: Boolean(customGoalMap.get(item.key)),
    active: strategyEditorGoalKey.value === item.key
  }));
  customGoals.forEach((item) => {
    if (!items.some((goal) => goal.key === item.key)) {
      items.push({
        ...item,
        custom: true,
        active: strategyEditorGoalKey.value === item.key
      });
    }
  });
  return {
    ...mode,
    modeKey,
    items
  };
}));
const activePlanCards = computed(() => {
  const savedKeys = currentLayerGoalMap.value[strategyEditorGoalKey.value] || [];
  const savedStrategies = savedKeys
    .map((key) => strategyLibraryRows.value.find((row) => row.strategy_key === key))
    .filter(Boolean)
    .map((row) => ({
      title: row.title,
      recommended: true,
      group: currentLayerRule.value?.title || "已保存策略树",
      strategyKey: row.strategy_key,
      custom: Boolean(row.metadata?.custom)
    }));
  const source = savedStrategies.length ? savedStrategies : editorGoalStrategyCards.value;
  return source.map((item, index) => ({
    ...item,
    order: index + 1,
    active: strategyEditorPlanTitle.value === item.title,
    promptCount: item.promptCount ?? resolvePlanModulesForEditor(item).positiveModules.length
  }));
});
const editorSelectedPlan = computed(() => activePlanCards.value.find((item) => item.title === strategyEditorPlanTitle.value) || activePlanCards.value[0] || null);
const editorSelectedTree = computed(() => ({
  title: categoryTreeStatus.value.treeName,
  text: categoryTreeStatus.value.mode,
  custom: hasSpecificCategoryTree.value,
  active: true
}));
const editorCurrentGoalGroup = computed(() => goalPlanGroups.value.find((item) => item.modeKey === strategyEditorMode.value));
const canDeleteSelectedGoal = computed(() => Boolean(editorSelectedGoal.value?.custom));
const canDeleteSelectedPlan = computed(() => Boolean(editorSelectedPlan.value?.custom));
function buildPromptSourceGroup(source, lines = []) {
  return {
    source,
    lines: uniquePromptLines(lines).slice(0, 8)
  };
}

function flattenPromptSourceRows(groups = []) {
  return groups.flatMap((group) => group.lines.map((line) => ({
    source: group.source,
    line
  })));
}

const editorPositivePromptSources = computed(() => {
  const planItem = editorSelectedPlan.value || {};
  const planTitle = planItem.title || "";
  const plan = planTitle ? resolvePlanModulesForEditor(planItem) : { positiveModules: [], negativeModules: [] };
  const goal = editorSelectedGoal.value || {};
  const rule = currentLayerRule.value || {};
  const metadata = rule.metadata || {};
  return [
    buildPromptSourceGroup("策略树", linesToArray(metadata.categoryPrompt || defaultTreePositivePrompt(rule))),
    buildPromptSourceGroup("当前类目", [
      `Category: ${categoryTreeStatus.value.category}.`,
      categoryStrategyRule.value.summary ? `Category focus: ${categoryStrategyRule.value.summary}.` : ""
    ]),
    buildPromptSourceGroup("GOAL", linesToArray(goal.positivePrompt || defaultGoalPositivePrompt(goal))),
    buildPromptSourceGroup("PLAN", [
      planTitle ? `PLAN: ${planTitle}.` : "",
      ...(plan.positiveModules || [])
    ])
  ].filter((group) => group.lines.length);
});

const editorNegativePromptSources = computed(() => {
  const planItem = editorSelectedPlan.value || {};
  const plan = planItem.title ? resolvePlanModulesForEditor(planItem) : { positiveModules: [], negativeModules: [] };
  const goal = editorSelectedGoal.value || {};
  const rule = currentLayerRule.value || {};
  const metadata = rule.metadata || {};
  return [
    buildPromptSourceGroup("策略树禁用项", linesToArray(metadata.negativePrompt || defaultTreeNegativePrompt())),
    buildPromptSourceGroup("GOAL 禁用项", linesToArray(goal.negativePrompt || defaultGoalNegativePrompt())),
    buildPromptSourceGroup("PLAN 禁用项", plan.negativeModules || []),
    buildPromptSourceGroup("全局禁用项", globalNegativePromptRules)
  ].filter((group) => group.lines.length);
});

const editorPromptPreview = computed(() => {
  return {
    positive: editorPositivePromptSources.value
      .flatMap((group) => group.lines.map((line) => `[${group.source}] ${line}`))
      .join("\n"),
    negative: editorNegativePromptSources.value
      .flatMap((group) => group.lines.map((line) => `[${group.source}] ${line}`))
      .join("\n")
  };
});
const editorPositivePromptRows = computed(() => flattenPromptSourceRows(editorPositivePromptSources.value));
const editorNegativePromptRows = computed(() => flattenPromptSourceRows(editorNegativePromptSources.value));
const selectedStrategyTitles = computed(() => {
  const fallback = selectedGoalStrategies.value.slice(0, 1);
  return task.selectedStrategies.length ? task.selectedStrategies : fallback;
});
const selectedStrategyCountText = computed(() => {
  if (isTextWorkbench.value) return selectedStrategyTitles.value[0] ? "当前策略" : "未选择策略";
  if (!selectedStrategyTitles.value.length) return "未选择策略";
  return isVariantWorkflow.value
    ? `已选 1 个裂变策略`
    : `已选 ${selectedStrategyTitles.value.length} 个独立策略`;
});
const sourceFieldOptions = computed(() => [
  { key: "productName", label: "商品名称", hint: "选品表商品名，AI 识别产品主体", value: task.productName, model: "productName", placeholder: "例如：TENET 通用不锈钢门槛条", span: 2 },
  { key: "categoryName", label: "产品类目", hint: "Ozon 类目或内部产品类型", value: task.categoryName || task.productType, model: "categoryName", placeholder: "例如：汽车用品 / 门槛条", span: 2 },
  { key: "title", label: "上架标题", hint: "编辑上架里的标题，可作为文案参考", value: task.title, model: "title", placeholder: "如果已有标题，可以放在这里", span: 2 },
  { key: "brandModel", label: "汽车品牌 / 型号", hint: "当前母商品适配车型", custom: "brandModel" },
  { key: "materialColor", label: "材质 / 颜色", hint: "影响图片质感、颜色和文案", custom: "materialColor" },
  { key: "quantity", label: "数量", hint: "套装数量、件数或包装数量", value: task.quantity, model: "quantity", placeholder: "例如：4件套" },
  { key: "package", label: "包装克重 / 尺寸", hint: "编辑上架必填物流属性", custom: "package", span: 2 },
  { key: "logistics", label: "物流规则", hint: "选品池物流规则", value: task.logisticsRuleName, model: "logisticsRuleName", placeholder: "例如：标准小包 / 空陆" },
  { key: "sellingPoints", label: "产品卖点", hint: "给 AI 生成主图和详情图的核心利益点", value: task.sellingPoints, model: "sellingPoints", type: "textarea", placeholder: "防刮耐磨、安装便捷、贴合车门门槛区域", span: 2 },
  { key: "tags", label: "产品标签", hint: "编辑上架标签，可用于标题标签生成", value: task.productTags, model: "productTags", placeholder: "多个标签用逗号分隔", span: 2 },
  { key: "summary", label: "简介", hint: "编辑上架简介 / 运营描述", value: task.summary, model: "summary", type: "textarea", placeholder: "用于详情图文案和描述生成", span: 2 },
  { key: "richContent", label: "富内容 / 附内容", hint: "Ozon 富内容 JSON 或尾图内容摘要", value: task.richContent, model: "richContent", type: "textarea", placeholder: "可放尾图、富内容、补充说明", span: 2 },
  { key: "sourcePlatform", label: "来源平台", hint: "1688、供应商、手工录入等", value: task.sourcePlatform, model: "sourcePlatform", placeholder: "例如：1688" },
  { key: "supplier", label: "供应商 / 采购链接", hint: "后续回写和追溯采购来源", custom: "supplier", span: 2 },
  { key: "cost", label: "采购成本 / 运费 / 打包费", hint: "用于回写选品表和利润计算", custom: "cost", span: 2 },
  { key: "price", label: "售价 / 标价 / 汇率", hint: "选品池价格信息", custom: "price", span: 2 },
  { key: "supplierNote", label: "供应商备注", hint: "采购侧补充说明", value: task.supplierNote, model: "supplierNote", type: "textarea", placeholder: "供应商备注、注意事项", span: 2 },
  { key: "sourceImageUrl", label: "主图 / 参考图 URL", hint: "后续可接上传，当前用于 image2 图生图参考", value: task.sourceImageUrl, model: "sourceImageUrl", placeholder: "粘贴主图或参考图 URL", span: 2 }
]);
const visibleSourceFields = computed(() => sourceFieldOptions.value.filter((item) => visibleSourceFieldKeys.value.includes(item.key)));
function getSourceFieldOption(key) {
  return sourceFieldOptions.value.find((item) => item.key === key) || null;
}

const productInfoTemplateMeta = computed(() => {
  if (task.sourceType === "selection") {
    return {
      title: "选品池编辑模板",
      subtitle: "围绕选品信息、卖点、供应链和回写字段进行编辑，默认通过派生新记录承接 AI 结果",
      action: "保存并返回 AI 工作台"
    };
  }
  if (task.sourceType === "online_product") {
    return {
      title: "在线商品优化模板",
      subtitle: "围绕在线商品现有链接补齐素材、文案和价格上下文，当前默认只支持导入分析",
      action: "保存并返回 AI 工作台"
    };
  }
  if (task.sourceType === "collector_box") {
    return {
      title: "采集箱上架模板",
      subtitle: "按上架草稿结构整理采集内容，便于后续优化和转上架",
      action: "保存并返回 AI 工作台"
    };
  }
  if (task.sourceType === "listing_record") {
    return {
      title: "上架记录编辑模板",
      subtitle: "按上架字段修正当前记录，保存后继续在 AI 工作台生成优化结果",
      action: "保存并返回 AI 工作台"
    };
  }
  if (task.sourceType === "material_asset") {
    return {
      title: "素材资产编辑模板",
      subtitle: "围绕素材信息、关联文案和来源信息进行整理",
      action: "保存并返回 AI 工作台"
    };
  }
  return {
    title: "通用编辑模板",
    subtitle: "补齐当前商品信息，保存后回到 AI 工作台继续优化",
    action: "保存并返回 AI 工作台"
  };
});

const productInfoPreviewFacts = computed(() => {
  const facts = [
    { label: "当前来源", value: task.sourceLabel || "当前编辑桌商品" },
    { label: "编辑模板", value: productInfoTemplateMeta.value.title },
    { label: "类目", value: productInfoForm.categoryName || productInfoForm.productType || "-" },
    { label: "品牌 / 型号", value: `${productInfoForm.brand || "-"} ${productInfoForm.vehicleModel || ""}`.trim() || "-" }
  ];
  if (task.sourceType === "selection") {
    facts.push(
      { label: "卖点", value: productInfoForm.sellingPoints || "-" },
      { label: "物流", value: productInfoForm.logisticsRuleName || "-" },
      { label: "回写策略", value: sourceModeLabel(sourceSubmitMode.value) }
    );
  } else if (task.sourceType === "online_product") {
    facts.push(
      { label: "上架标题", value: productInfoForm.title || "-" },
      { label: "价格", value: [productInfoForm.salePrice, productInfoForm.labelPrice].filter(Boolean).join(" / ") || "-" },
      { label: "回写策略", value: sourceModeLabel("asset_only") }
    );
  } else if (task.sourceType === "collector_box" || task.sourceType === "listing_record") {
    facts.push(
      { label: "上架标题", value: productInfoForm.title || "-" },
      { label: "商品简介", value: productInfoForm.summary || "-" },
      { label: "回写策略", value: sourceModeLabel(task.sourceType === "collector_box" ? "overwrite_collector" : "overwrite_listing_record") }
    );
  } else {
    facts.push(
      { label: "标签", value: productInfoForm.productTags || "-" },
      { label: "来源平台", value: productInfoForm.sourcePlatform || "-" }
    );
  }
  return facts;
});

const productInfoSections = computed(() => {
  const sections = [];
  const pick = (...keys) => keys.map(getSourceFieldOption).filter(Boolean);
  if (task.sourceType === "selection") {
    sections.push(
      { title: "选品基础信息", subtitle: "这部分会作为选品优化的主输入", fields: pick("productName", "categoryName", "title", "brandModel", "materialColor", "quantity", "sellingPoints", "tags", "summary", "sourceImageUrl") },
      { title: "供应链与物流", subtitle: "用于选品判断和后续回写", fields: pick("package", "logistics", "sourcePlatform", "supplier", "supplierNote") },
      { title: "成本与价格", subtitle: "保留选品池所需的成本结构", fields: pick("cost", "price") }
    );
    return sections;
  }
  if (task.sourceType === "online_product") {
    sections.push(
      { title: "在线商品主体信息", subtitle: "直接围绕线上链接补齐优化所需字段", fields: pick("productName", "title", "categoryName", "brandModel", "materialColor", "quantity", "tags", "summary") },
      { title: "卖点与素材上下文", subtitle: "用于主图、详情图和文案策略生成", fields: pick("sellingPoints", "richContent", "sourceImageUrl") },
      { title: "价格与来源", subtitle: "保留价格、来源平台和供应商信息", fields: pick("package", "price", "sourcePlatform", "supplier", "supplierNote") }
    );
    return sections;
  }
  if (task.sourceType === "collector_box" || task.sourceType === "listing_record") {
    sections.push(
      { title: "上架主体信息", subtitle: "直接按照上架草稿结构编辑", fields: pick("productName", "title", "categoryName", "brandModel", "materialColor", "quantity", "tags", "summary") },
      { title: "卖点与内容", subtitle: "这里的内容最适合接文案和详情图策略", fields: pick("sellingPoints", "richContent", "sourceImageUrl") },
      { title: "规格与价格", subtitle: "保留上架时常用的属性、包装和价格字段", fields: pick("package", "price", "sourcePlatform", "supplier", "supplierNote") }
    );
    return sections;
  }
  if (task.sourceType === "material_asset") {
    sections.push(
      { title: "素材主体信息", subtitle: "整理素材对应的商品和文案上下文", fields: pick("productName", "title", "categoryName", "brandModel", "materialColor", "tags", "summary", "sourceImageUrl") },
      { title: "素材补充信息", subtitle: "补齐来源、供应商和卖点说明", fields: pick("sellingPoints", "sourcePlatform", "supplier", "supplierNote", "richContent") }
    );
    return sections;
  }
  return [
    { title: "基础信息", subtitle: "补齐当前工作台的商品输入", fields: pick("productName", "categoryName", "title", "brandModel", "materialColor", "sellingPoints", "tags", "summary", "sourceImageUrl") },
    { title: "补充信息", subtitle: "用于 AI 生成时理解商品和来源", fields: pick("package", "sourcePlatform", "supplier", "cost", "price", "supplierNote") }
  ];
});

function ensureWorkbenchRouteId() {
  if (workbenchId.value) return;
  router.replace({
    query: {
      ...route.query,
      workbenchId: createWorkbenchId()
    }
  }).catch(() => {});
}

function createWorkbenchDraftSnapshot() {
  return {
    task: JSON.parse(JSON.stringify(task)),
    results: JSON.parse(JSON.stringify(results.value || [])),
    logs: JSON.parse(JSON.stringify(logs.value || [])),
    workbenchTaskMode: workbenchTaskMode.value,
    activeCommerceMode: activeCommerceMode.value,
    activeResultTab: activeResultTab.value,
    taskStatus: taskStatus.value,
    sourceSubmitMode: sourceSubmitMode.value,
    selectedTemplateId: selectedTemplateId.value,
    savedAt: new Date().toISOString()
  };
}

function restoreWorkbenchDraft() {
  try {
    const raw = localStorage.getItem(workbenchDraftStorageKey.value);
    if (!raw) return;
    const parsed = JSON.parse(raw || "{}");
    if (parsed?.task && typeof parsed.task === "object") Object.assign(task, parsed.task);
    if (Array.isArray(parsed?.results)) results.value = parsed.results;
    if (Array.isArray(parsed?.logs)) logs.value = parsed.logs;
    if (parsed?.workbenchTaskMode) workbenchTaskMode.value = parsed.workbenchTaskMode;
    if (parsed?.activeCommerceMode) activeCommerceMode.value = parsed.activeCommerceMode;
    if (parsed?.activeResultTab) activeResultTab.value = parsed.activeResultTab;
    if (parsed?.taskStatus) taskStatus.value = parsed.taskStatus;
    if (parsed?.sourceSubmitMode) {
      sourceSubmitMode.value = parsed.sourceSubmitMode === "overwrite_selection"
        ? "safe_overwrite_selection"
        : parsed.sourceSubmitMode;
    }
    if (Object.prototype.hasOwnProperty.call(parsed || {}, "selectedTemplateId")) {
      selectedTemplateId.value = parsed.selectedTemplateId;
    }
  } catch {
    localStorage.removeItem(workbenchDraftStorageKey.value);
  }
}

onMounted(() => {
  ensureWorkbenchRouteId();
  loadSourceFieldPreferences();
  loadTemplates();
  refreshRemoteStrategyPlan();
  importSelectionFromRoute();
  importCollectorFromRoute();
  importOnlineProductFromRoute();
  importListingDraftFromRoute();
  importListingRecordFromRoute();
  aiWorkbenchReady.value = true;
});

watch(() => route.query.baseSelectionId, () => {
  importSelectionFromRoute();
});

watch(() => route.query.collectorSku, () => {
  importCollectorFromRoute();
});

watch(() => [route.query.onlineProductId, route.query.source, route.query.autoImport, route.query.importAt], () => {
  importOnlineProductFromRoute();
});

watch(() => [route.query.draftId, route.query.draftIds, route.query.source, route.query.autoImport, route.query.importAt], () => {
  importListingDraftFromRoute();
});

watch(() => [route.query.listingRecordId, route.query.source, route.query.autoImport, route.query.importAt], () => {
  importListingRecordFromRoute();
});

watch(workbenchId, (id) => {
  if (!id) return;
  restoreWorkbenchDraft();
  if (!aiWorkbenchReady.value) return;
  saveDraft({ silent: true });
}, { immediate: true });

watch(
  [
    () => workbenchTaskMode.value,
    () => activeCommerceMode.value,
    () => JSON.stringify(task),
    () => JSON.stringify(results.value || [])
  ],
  () => {
    if (!aiWorkbenchReady.value || !workbenchId.value) return;
    window.clearTimeout(aiWorkbenchSaveTimer);
    aiWorkbenchSaveTimer = window.setTimeout(() => {
      saveDraft({ silent: true });
    }, 180);
  }
);

watch(sourceTab, (tab) => {
  if (!sourceDialogVisible.value) return;
  if (tab === "assets") loadSourceAssets();
  else if (tab === "online_products") loadSourceOnlineProducts();
  else if (tab === "collector") loadSourceCollectors();
  else if (tab === "listing_records") loadSourceListingRecords();
  else loadSourceSelections();
});

watch(() => task.sourceType, (type) => {
  if (type === "selection") sourceSubmitMode.value = "new_selection";
  else if (type === "online_product") sourceSubmitMode.value = "online_product_to_template";
  else if (type === "collector_box") sourceSubmitMode.value = "overwrite_collector";
  else if (type === "listing_record") sourceSubmitMode.value = "overwrite_listing_record";
  else sourceSubmitMode.value = "asset_only";
});

watch(workbenchTaskMode, (mode) => {
  if (mode === "text") {
    activeCommerceMode.value = "optimization";
    task.outputs = [...TEXT_OUTPUT_ITEMS];
    task.optimizationTarget = resolveTextGoalKey(task.outputs);
    task.selectedStrategies = selectedGoalStrategies.value[0] ? [selectedGoalStrategies.value[0]] : [];
    return;
  }
  if (TEXT_OPTIMIZATION_KEYS.includes(task.optimizationTarget)) {
    const nextTarget = flatOptimizationTargets.value.find((item) => !TEXT_OPTIMIZATION_KEYS.includes(item.key));
    if (nextTarget) selectOptimizationTarget(nextTarget);
  } else {
    task.outputs = task.outputs.filter((item) => !TEXT_OUTPUT_ITEMS.includes(item));
    if (!task.outputs.length) task.outputs = ["主图"];
  }
}, { immediate: true });

watch([
  () => task.optimizationTarget,
  () => task.selectedStrategies.join("|"),
  () => selectedGoalStrategies.value.join("|"),
  () => strategyCategoryText.value,
  () => strategyBusinessMode.value
], () => {
  refreshRemoteStrategyPlan();
});

watch(selectedTemplateId, (value) => {
  const template = templates.value.find((item) => item.id === value && item.enabled);
  if (template) applyTemplate(template);
});

async function loadTemplates() {
  loading.value = true;
  try {
    templates.value = await listAiPromptTemplates();
    const selectedTemplate = templates.value.find((item) => item.id === selectedTemplateId.value && item.enabled);
    const defaultTemplate = templates.value.find((item) => item.scene === "main_image_variant" && item.is_default && item.enabled)
      || templates.value.find((item) => item.scene === "main_image_variant" && item.enabled);
    if (selectedTemplate) applyTemplate(selectedTemplate);
    else if (defaultTemplate) applyTemplate(defaultTemplate);
  } catch (error) {
    ElMessage.error(error.message || "提示词库加载失败");
  } finally {
    loading.value = false;
  }
}

async function refreshRemoteStrategyPlan() {
  strategyPlanLoading.value = true;
  try {
    remoteStrategyPlan.value = await resolveRemoteAiStrategyPlan({
      businessMode: strategyBusinessMode.value,
      goalKey: activeGoalKey.value,
      selectedTitles: task.selectedStrategies,
      fallbackTitles: selectedGoalStrategies.value,
      categoryText: strategyCategoryText.value
    });
  } catch {
    remoteStrategyPlan.value = null;
  } finally {
    strategyPlanLoading.value = false;
  }
}

async function openSourceDialog() {
  sourceDialogVisible.value = true;
  sourceTab.value = "online_products";
  loadSourceOnlineProducts();
}

function sourcePagerFor(tab = sourceTab.value) {
  return sourceFilters[tab] || sourceFilters.selection;
}

function resetSourcePage(tab = sourceTab.value) {
  sourcePagerFor(tab).page = 1;
}

function sourceSearchPlaceholder(tab = sourceTab.value) {
  if (tab === "online_products") return "搜索商品名、Offer ID、Ozon SKU";
  if (tab === "collector") return "搜索标题、SKU、类目";
  if (tab === "listing_records") return "搜索标题、offer、店铺、product id";
  return "搜索商品、选品单、车型、类目";
}

function sourceFooterSummary(tab = sourceTab.value) {
  const pager = sourcePagerFor(tab);
  return `第 ${pager.page} 页 / 共 ${pager.total} 条`;
}

function searchSourceRows(tab = sourceTab.value) {
  resetSourcePage(tab);
  loadSourceRows(tab);
}

function handleSourcePageChange(tab, page) {
  sourcePagerFor(tab).page = Number(page || 1);
  loadSourceRows(tab);
}

function handleSourcePageSizeChange(tab, size) {
  const pager = sourcePagerFor(tab);
  pager.pageSize = Number(size || 10);
  pager.page = 1;
  loadSourceRows(tab);
}

function loadSourceRows(tab = sourceTab.value) {
  if (tab === "online_products") return loadSourceOnlineProducts();
  if (tab === "collector") return loadSourceCollectors();
  if (tab === "listing_records") return loadSourceListingRecords();
  if (tab === "assets") return loadSourceAssets();
  return loadSourceSelections();
}

async function loadSourceOnlineProducts() {
  sourceLoading.value = true;
  try {
    const pager = sourceFilters.online_products;
    const params = new URLSearchParams({
      paged: "1",
      page: String(pager.page),
      pageSize: String(pager.pageSize),
      shopId: "all",
      status: "all"
    });
    const keyword = pager.keyword.trim();
    if (keyword) {
      params.set("name", keyword);
      params.set("offer", keyword);
    }
    const result = await apiClient.get(`/api/online-products?${params.toString()}`, { noCache: true });
    sourceOnlineProducts.value = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
    sourceFilters.online_products.total = Number(result?.total ?? sourceOnlineProducts.value.length);
    sourceFilters.online_products.page = Number(result?.page || pager.page);
    sourceFilters.online_products.pageSize = Number(result?.pageSize || pager.pageSize);
    sourceOnlineProductsLoaded.value = true;
  } catch (error) {
    ElMessage.error(error.message || "在线商品加载失败");
  } finally {
    sourceLoading.value = false;
  }
}

async function loadSourceSelections() {
  sourceLoading.value = true;
  try {
    const pager = sourceFilters.selection;
    const params = new URLSearchParams({
      paged: "1",
      page: String(pager.page),
      pageSize: String(pager.pageSize),
      summaryMode: "skip"
    });
    if (pager.keyword.trim()) params.set("query", pager.keyword.trim());
    const selections = await apiClient.get(`/api/products/selection?${params.toString()}`, { noCache: true });
    sourceSelections.value = Array.isArray(selections?.rows) ? selections.rows : (Array.isArray(selections) ? selections : []);
    sourceFilters.selection.total = Number(selections?.total ?? sourceSelections.value.length);
    sourceFilters.selection.page = Number(selections?.page || pager.page);
    sourceFilters.selection.pageSize = Number(selections?.pageSize || pager.pageSize);
    sourceSelectionsLoaded.value = true;
  } catch (error) {
    ElMessage.error(error.message || "选品商品加载失败");
  } finally {
    sourceLoading.value = false;
  }
}

async function loadSourceCollectors() {
  sourceLoading.value = true;
  try {
    const pager = sourceFilters.collector;
    const params = new URLSearchParams({
      page: String(pager.page),
      pageSize: String(pager.pageSize),
      summaryMode: "skip"
    });
    if (pager.keyword.trim()) params.set("query", pager.keyword.trim());
    const result = await apiClient.get(`/api/listing/collector-box?${params.toString()}`, { noCache: true });
    sourceCollectors.value = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
    sourceFilters.collector.total = Number(result?.total ?? sourceCollectors.value.length);
    sourceFilters.collector.page = Number(result?.page || pager.page);
    sourceFilters.collector.pageSize = Number(result?.pageSize || pager.pageSize);
    sourceCollectorsLoaded.value = true;
  } catch (error) {
    ElMessage.error(error.message || "采集箱商品加载失败");
  } finally {
    sourceLoading.value = false;
  }
}

async function loadSourceAssets() {
  if (sourceAssetsLoaded.value && sourceAssets.value.length) return;
  sourceLoading.value = true;
  try {
    const [assets, matrixAssets] = await Promise.all([
      listMaterialAssets({ limit: 24 }),
      apiClient.get("/api/listing/media/assets?limit=24", { noCache: true }).catch(() => [])
    ]);
    const normalizedMaterialAssets = Array.isArray(assets) ? assets : [];
    const normalizedMatrixAssets = (Array.isArray(matrixAssets) ? matrixAssets : []).map((item) => ({
      id: `matrix-${item.id || item.assetId || item.url}`,
      asset_type: item.type || item.asset_type || "image",
      role: item.role || item.assetRole || "shop_matrix_asset",
      title: item.title || item.name || item.productName || "店铺矩阵素材",
      url: item.url || item.imageUrl || item.mainImageUrl || item.path || "",
      thumbnail_url: item.thumbnail_url || item.thumbnailUrl || item.url || item.imageUrl || item.mainImageUrl || "",
      source_type: "shop_matrix_asset",
      source_id: String(item.id || item.assetId || ""),
      source_package_id: item.packageId || item.package_id || item.batchId || "",
      target_brand: item.targetBrand || item.target_brand || "",
      target_model: item.targetModel || item.target_model || item.vehicleModel || "",
      product_name: item.productName || item.product_name || item.title || item.name || "",
      status: item.status || "ready",
      metadata: {
        ...(item.metadata || {}),
        title: item.title || item.name || "",
        tags: item.tags || item.productTags || "",
        summary: item.description || item.summary || "",
        productType: item.productType || item.category || "",
        categoryName: item.categoryName || item.ozonCategoryName || ""
      }
    })).filter((item) => item.url || item.title || item.product_name);
    const seen = new Set();
    sourceAssets.value = [...normalizedMaterialAssets, ...normalizedMatrixAssets].filter((item) => {
      const key = `${item.source_type || "material"}-${item.id}-${item.url || item.thumbnail_url || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    sourceAssetsLoaded.value = true;
  } catch (error) {
    ElMessage.error(error.message || "统一素材资产加载失败");
  } finally {
    sourceLoading.value = false;
  }
}

function loadSourceFieldPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(sourceFieldPrefsKey) || "[]");
    const validKeys = new Set(sourceFieldOptions.value.map((item) => item.key));
    const next = Array.isArray(stored) ? stored.filter((key) => validKeys.has(key)) : [];
    if (next.length) visibleSourceFieldKeys.value = next;
  } catch {
    visibleSourceFieldKeys.value = [...defaultSourceFieldKeys];
  }
}

function saveSourceFieldPreferences() {
  localStorage.setItem(sourceFieldPrefsKey, JSON.stringify(visibleSourceFieldKeys.value));
}

function resetSourceFieldPreferences() {
  visibleSourceFieldKeys.value = [...defaultSourceFieldKeys];
  saveSourceFieldPreferences();
}

const productInfoEditableKeys = [
  "productName",
  "categoryName",
  "title",
  "brand",
  "vehicleModel",
  "material",
  "color",
  "quantity",
  "productType",
  "sellingPoints",
  "productTags",
  "summary",
  "richContent",
  "packageWeightG",
  "lengthCm",
  "widthCm",
  "heightCm",
  "logisticsRuleName",
  "sourcePlatform",
  "supplierName",
  "purchaseUrl",
  "purchaseCost",
  "domesticShipping",
  "handlingFee",
  "salePrice",
  "labelPrice",
  "exchangeRate",
  "supplierNote",
  "sourceImageUrl"
];

const productInfoReadonly = computed(() => productInfoMode.value === "preview");
const productInfoDialogTitle = computed(() => (
  productInfoReadonly.value ? "预览商品信息" : "编辑完整商品信息"
));

async function openProductInfoEditor(mode = "edit") {
  productInfoMode.value = mode;
  productInfoEditableKeys.forEach((key) => {
    productInfoForm[key] = task[key] ?? "";
  });
  productInfoDrawer.value = true;
}

function applyProductInfoFormToTask() {
  productInfoEditableKeys.forEach((key) => {
    task[key] = productInfoForm[key] ?? "";
  });
  refreshRecommendedStrategiesFromCategory();
}

function buildProductInfoSelectionPayload() {
  return {
    name: productInfoForm.productName || productInfoForm.title,
    title: productInfoForm.title,
    ozon_category_name: productInfoForm.categoryName || productInfoForm.productType,
    category_name: productInfoForm.categoryName || productInfoForm.productType,
    product_type: productInfoForm.productType || "selection",
    vehicle_brand: productInfoForm.brand,
    vehicle_model: productInfoForm.vehicleModel,
    material: productInfoForm.material,
    color: productInfoForm.color,
    purchase_quantity: productInfoForm.quantity,
    selling_points: productInfoForm.sellingPoints,
    product_tags: productInfoForm.productTags,
    summary: productInfoForm.summary,
    rich_content: productInfoForm.richContent,
    package_weight_g: productInfoForm.packageWeightG,
    length_cm: productInfoForm.lengthCm,
    width_cm: productInfoForm.widthCm,
    height_cm: productInfoForm.heightCm,
    logistics_rule_name: productInfoForm.logisticsRuleName,
    source_platform: productInfoForm.sourcePlatform,
    supplier_name: productInfoForm.supplierName,
    purchase_url: productInfoForm.purchaseUrl,
    purchase_cost: productInfoForm.purchaseCost,
    domestic_shipping: productInfoForm.domesticShipping,
    handling_fee: productInfoForm.handlingFee,
    sale_price_rmb: productInfoForm.salePrice,
    listing_price_rub: productInfoForm.labelPrice || productInfoForm.salePrice,
    exchange_rate: productInfoForm.exchangeRate,
    supplier_note: productInfoForm.supplierNote,
    image_url: productInfoForm.sourceImageUrl
  };
}

function buildProductInfoEditPayload() {
  return {
    internal_product_name: productInfoForm.productName,
    title: productInfoForm.title || productInfoForm.productName,
    category_name: productInfoForm.categoryName || productInfoForm.productType,
    product_type: productInfoForm.productType,
    brand: productInfoForm.brand,
    model: productInfoForm.vehicleModel,
    material: productInfoForm.material,
    color: productInfoForm.color,
    quantity: productInfoForm.quantity,
    purchase_quantity: productInfoForm.quantity,
    weight_g: productInfoForm.packageWeightG,
    package_weight_g: productInfoForm.packageWeightG,
    length_cm: productInfoForm.lengthCm,
    width_cm: productInfoForm.widthCm,
    height_cm: productInfoForm.heightCm,
    selling_points: productInfoForm.sellingPoints,
    tags: productInfoForm.productTags,
    summary: productInfoForm.summary,
    description: productInfoForm.summary || productInfoForm.sellingPoints,
    rich_content: productInfoForm.richContent,
    source_platform: productInfoForm.sourcePlatform,
    supplier_name: productInfoForm.supplierName,
    purchase_url: productInfoForm.purchaseUrl,
    purchase_cost: productInfoForm.purchaseCost,
    domestic_shipping: productInfoForm.domesticShipping,
    handling_fee: productInfoForm.handlingFee,
    price: productInfoForm.salePrice,
    old_price: productInfoForm.labelPrice,
    exchange_rate: productInfoForm.exchangeRate,
    operation_note: productInfoForm.supplierNote,
    image_url: productInfoForm.sourceImageUrl
  };
}

async function saveProductInfoEditor() {
  if (!String(productInfoForm.productName || productInfoForm.title || "").trim()) {
    ElMessage.warning("请先填写内部商品名称或标题");
    return;
  }
  savingProductInfo.value = true;
  try {
    applyProductInfoFormToTask();
    saveDraft({ silent: true });
    productInfoDrawer.value = false;
    ElMessage.success("已保存为当前 AI 工作台草稿，最终提交时再写回来源");
  } catch (error) {
    ElMessage.error(error.message || "保存商品信息失败");
  } finally {
    savingProductInfo.value = false;
  }
}

function normalizeTextValue(value, fallback = "") {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function cleanImportedField(value = "") {
  return normalizeTextValue(value, "").replace(/\s+/g, " ").trim();
}

function normalizeImportedBrand(value = "") {
  const text = cleanImportedField(value);
  if (!text || /^(no brand|без бренда|нет бренда|无品牌)$/i.test(text)) return "无品牌";
  return text;
}

function attributeValueFromList(attributes = [], names = [], ids = []) {
  const list = Array.isArray(attributes) ? attributes : [];
  const normalizedNames = names.map((name) => String(name || "").toLowerCase()).filter(Boolean);
  const normalizedIds = ids.map((id) => String(id));
  for (const attr of list) {
    const attrName = String(attr?.name || attr?.attribute_name || attr?.title || "").toLowerCase();
    const attrId = String(attr?.attribute_id || attr?.attributeId || attr?.id || "");
    const matchedName = normalizedNames.some((name) => attrName.includes(name));
    const matchedId = attrId && normalizedIds.includes(attrId);
    if (!matchedName && !matchedId) continue;
    const values = Array.isArray(attr.values) ? attr.values : [];
    const first = values.map((item) => item?.value || item?.name || item?.text || item).filter(Boolean)[0];
    const value = cleanImportedField(attr.value ?? attr.attribute_value ?? first);
    if (value) return value;
  }
  return "";
}

function knownVehicleBrandFromText(...values) {
  const text = values.map((value) => cleanImportedField(value)).filter(Boolean).join(" ");
  if (!text) return "";
  const candidates = [
    ["HAVAL", "哈弗", "哈佛"],
    ["TENET", "Тенет"],
    ["BELGEE", "Белджи"],
    ["CHERY", "奇瑞"],
    ["GEELY", "吉利"],
    ["CHANGAN", "长安"],
    ["OMODA"],
    ["JAECOO"],
    ["EXEED"]
  ];
  const lower = text.toLowerCase();
  for (const aliases of candidates) {
    if (aliases.some((alias) => lower.includes(String(alias).toLowerCase()))) return aliases[0];
  }
  return "";
}

function resolveImportedVehicleModel({ edit = {}, raw = {}, payload = {}, detail = {}, item = {} } = {}) {
  const explicit = cleanImportedField(
    edit.vehicleModel || edit.vehicle_model || edit.carModel || edit.car_model ||
    raw.vehicleModel || raw.vehicle_model || raw.carModel || raw.car_model ||
    payload.vehicleModel || payload.vehicle_model || payload.carModel || payload.car_model ||
    item.vehicle_model || item.vehicleModel || item.car_model || item.carModel ||
    attributeValueFromList(raw.attributes || raw.attribute_values || raw.characteristics, ["vehicle model", "car model", "车型", "适配车型"], [7212]) ||
    attributeValueFromList(item.attributes, ["vehicle model", "car model", "车型", "适配车型"], [7212])
  );
  if (explicit) return explicit;
  return knownVehicleBrandFromText(
    edit.title,
    edit.productName,
    payload.productTitle,
    detail.title,
    raw.title,
    raw.name,
    raw.description,
    item.name,
    item.description
  );
}

function previewImageUrl(url = "") {
  const value = String(url || "");
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return value;
  if (/^https?:\/\//i.test(value)) return `/api/image-proxy?url=${encodeURIComponent(value)}`;
  return withImageToken(value);
}

const sourceImagePreviewUrl = computed(() => previewImageUrl(task.sourceImageUrl));
const sourceImagePreviewList = computed(() => sourceImagePreviewUrl.value ? [sourceImagePreviewUrl.value] : []);

function selectionThumbUrl(row = {}) {
  return row.thumbnail_url
    || row.thumb_url
    || row.image_thumb_url
    || row.main_image_thumbnail
    || row.preview_url
    || row.image_url
    || row.main_image_url
    || row.primary_image
    || "";
}

function selectionPreviewList(row = {}) {
  return [
    selectionThumbUrl(row),
    row.image_url,
    row.main_image_url,
    row.primary_image,
    ...normalizeImageList(row.detail_image_urls || row.detailImageUrls)
  ].filter((item, index, list) => item && list.indexOf(item) === index);
}

function collectorThumbUrl(row = {}) {
  return row.image_url
    || row.productImage
    || row.payload?.productImage
    || row.rawPayload?.productImage
    || "";
}

function collectorPreviewList(row = {}) {
  return [
    collectorThumbUrl(row),
    ...normalizeImageList(row.rawPayload?.images || row.payload?.images || row.images)
  ].filter((item, index, list) => item && list.indexOf(item) === index);
}

function parseOnlineProductRaw(row = {}) {
  const raw = row?.raw_json;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function onlineProductThumbUrl(row = {}) {
  const raw = parseOnlineProductRaw(row);
  return row.primary_image
    || row.image_url
    || raw.primary_image
    || raw.image_url
    || normalizeImageList(raw.images)[0]
    || "";
}

function onlineProductPreviewList(row = {}) {
  const raw = parseOnlineProductRaw(row);
  return [
    onlineProductThumbUrl(row),
    ...normalizeImageList(row.images),
    ...normalizeImageList(raw.images)
  ].filter((item, index, list) => item && list.indexOf(item) === index);
}

function listingRecordThumbUrl(row = {}) {
  return listingRecordImageCandidates(row)[0] || "";
}

function listingRecordPreviewList(row = {}) {
  return listingRecordImageCandidates(row);
}

function listingRecordOriginalImageUrl(row = {}) {
  return listingRecordImageCandidates(row)[0] || "";
}

function isWeakPreviewImageUrl(url = "") {
  const value = String(url || "").trim();
  if (/^\/uploads\/listing-media\//i.test(value)) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.origin !== window.location.origin && parsed.pathname.startsWith("/uploads/");
  } catch {
    return false;
  }
}

function listingRecordImageCandidates(row = {}) {
  const item = row.request?.items?.[0] || {};
  return normalizeImageList([
    row.primary_image,
    ...normalizeImageList(row.images),
    item.primary_image,
    ...normalizeImageList(item.images),
    row.fallback_image,
    row.online_primary_image
  ]).sort((left, right) => Number(isWeakPreviewImageUrl(left)) - Number(isWeakPreviewImageUrl(right)));
}

function listingRecordStatusText(row = {}) {
  const map = {
    imported: "上架成功",
    published: "上架成功",
    success: "上架成功",
    submitted: "已提交",
    processing: "处理中",
    resubmitting: "重提中",
    ozon_status_pending: "待同步",
    ozon_status_error: "同步失败",
    failed: "上架失败"
  };
  return map[row.status] || row.status || "-";
}

function extractRecordAttributeValue(item = {}, names = [], ids = []) {
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  for (const attr of attrs) {
    const attrName = String(attr?.name || attr?.attribute_name || "").toLowerCase();
    const attrId = Number(attr?.id || attr?.attribute_id || 0);
    const matchedName = names.some((name) => attrName.includes(String(name).toLowerCase()));
    const matchedId = ids.some((id) => Number(id) === attrId);
    if (!matchedName && !matchedId) continue;
    const values = Array.isArray(attr.values) ? attr.values : [];
    const first = values.map((value) => value?.value || value?.name || value?.text || value).filter(Boolean)[0];
    return normalizeTextValue(attr.value || first);
  }
  return "";
}

function extractRecordRichContent(item = {}) {
  if (item.rich_content_json) return String(item.rich_content_json || "");
  const direct = extractRecordAttributeValue(item, ["JSON富内容", "Rich", "rich"], [11254]);
  if (direct) return direct;
  const groups = Array.isArray(item.complex_attributes) ? item.complex_attributes : [];
  for (const group of groups) {
    const attrs = Array.isArray(group.attributes) ? group.attributes : [];
    const richAttr = attrs.find((attr) => String(attr?.id || "").toLowerCase() === "rich_content_json" || Number(attr?.id || 0) === 11254);
    const value = richAttr?.values?.[0]?.value;
    if (value) return String(value);
  }
  return "";
}

function assetPreviewList(asset = {}) {
  return [
    asset.url,
    asset.thumbnail_url,
    asset.thumbnailUrl,
    asset.imageUrl,
    ...normalizeImageList(asset.metadata?.detailImageUrls || asset.metadata?.detail_image_urls)
  ].filter((item, index, list) => item && list.indexOf(item) === index);
}

function normalizeInternalImageUrl(url = "") {
  const value = String(url || "").trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return value;
  try {
    const parsed = new URL(value, window.location.origin);
    const internalHosts = new Set([window.location.hostname, "localhost", "127.0.0.1", "erp.hjt888.xyz"]);
    if (internalHosts.has(parsed.hostname) && parsed.pathname.startsWith("/api/")) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return value;
  }
  return value;
}

function applySelectionSource(row = {}) {
  task.productName = row.name || row.product_name || task.productName;
  task.title = row.title || row.ozon_title || row.name || row.product_name || task.title;
  task.brand = normalizeImportedBrand(row.brand || row.product_brand || row.ozon_brand || row.vehicle_brand);
  task.vehicleModel = cleanImportedField(row.vehicle_model || row.vehicleModel) || knownVehicleBrandFromText(row.title, row.ozon_title, row.name, row.product_name);
  task.material = row.material || task.material;
  task.color = normalizeTextValue(row.color, task.color);
  task.quantity = row.purchase_quantity || row.quantity || task.quantity;
  task.categoryName = row.ozon_category_name || row.category_name || task.categoryName;
  task.productType = row.product_type || row.ozon_category_name || task.productType;
  task.sellingPoints = row.selling_points || task.sellingPoints;
  task.productTags = normalizeTextValue(row.tags || row.product_tags || row.main_tags, task.productTags);
  task.summary = row.summary || row.description || row.short_description || task.summary;
  task.richContent = row.rich_content_json || row.rich_content || row.tail_content || task.richContent;
  task.packageWeightG = row.package_weight_g || row.weight_g || task.packageWeightG;
  task.lengthCm = row.length_cm || task.length || task.lengthCm;
  task.widthCm = row.width_cm || row.width || task.widthCm;
  task.heightCm = row.height_cm || row.height || task.heightCm;
  task.logisticsRuleName = row.logistics_rule_name || row.resolved_logistics_rule_name || row.logistics_rule || task.logisticsRuleName;
  task.sourcePlatform = row.source_platform || task.sourcePlatform;
  task.supplierName = row.supplier_name || row.supplier || task.supplierName;
  task.purchaseUrl = row.purchase_url || row.purchase_link || task.purchaseUrl;
  task.purchaseCost = row.purchase_cost ?? task.purchaseCost;
  task.domesticShipping = row.domestic_shipping ?? task.domesticShipping;
  task.handlingFee = row.handling_fee ?? task.handlingFee;
  task.salePrice = row.sale_price_rmb ?? row.sale_price ?? task.salePrice;
  task.labelPrice = row.listing_price_rub ?? row.label_price ?? task.labelPrice;
  task.exchangeRate = row.exchange_rate ?? task.exchangeRate;
  task.supplierNote = row.supplier_note || task.supplierNote;
  task.sourceImageUrl = normalizeInternalImageUrl(row.image_url || row.main_image_url || task.sourceImageUrl);
  task.sourceImageOriginalUrl = task.sourceImageUrl;
  task.sourceType = "selection";
  task.sourceId = String(row.id || "");
  task.sourceSelectionId = row.id || null;
  task.sourceCollectorSku = "";
  task.sourceListingRecordId = "";
  task.sourcePackageId = "";
  task.sourceLabel = `选品池 #${row.selection_id || row.id || ""}`;
  sourceSubmitMode.value = "new_selection";
  refreshRecommendedStrategiesFromCategory();
}

async function importSelectionSource(row = {}) {
  const importKey = String(row.id || row.selection_id || "");
  sourceImportingId.value = importKey;
  applySelectionSource(row);
  sourceDialogVisible.value = false;
  ElMessage.success("已导入选品表商品，详情正在后台补齐");
  sourceImportingId.value = "";
  if (row.id) {
    apiClient.get(`/api/products/${row.id}`, { noCache: true })
      .then((detail) => applySelectionSource({ ...row, ...(detail?.data || detail || {}) }))
      .catch(() => null);
  }
}

function applyCollectorSource(detail = {}) {
  const payload = detail.payload || {};
  const raw = detail.rawPayload || {};
  const edit = detail.editPayload || {};
  const images = normalizeImageList(raw.images || payload.images || [detail.image_url]);
  task.productName = edit.internal_product_name || edit.productName || edit.title || payload.productTitle || detail.title || task.productName;
  task.title = edit.title || payload.productTitle || detail.title || task.title;
  task.brand = normalizeImportedBrand(edit.brand || raw.brand || payload.brand);
  task.vehicleModel = resolveImportedVehicleModel({ edit, raw, payload, detail });
  task.material = edit.material || raw.material || task.material;
  task.color = normalizeTextValue(edit.color || raw.color, task.color);
  task.quantity = edit.quantity || edit.purchase_quantity || raw.quantity || task.quantity;
  task.categoryName = edit.category_name || detail.category_name || raw.category_name || raw.category || task.categoryName;
  task.productType = edit.product_type || edit.category_name || detail.category_name || task.productType;
  task.sellingPoints = edit.selling_points || edit.description || raw.description || task.sellingPoints;
  task.productTags = normalizeTextValue(edit.tags || raw.hashtags || raw.tags, task.productTags);
  task.summary = edit.summary || edit.description || raw.description || task.summary;
  task.richContent = edit.richContent || edit.rich_content || task.richContent;
  task.packageWeightG = edit.weight_g || edit.package_weight_g || raw.weight_g || raw.custom_weight || task.packageWeightG;
  task.lengthCm = edit.length_cm || raw.length_cm || task.lengthCm;
  task.widthCm = edit.width_cm || raw.width_cm || task.widthCm;
  task.heightCm = edit.height_cm || raw.height_cm || task.heightCm;
  task.sourcePlatform = "Ozon";
  task.purchaseUrl = detail.product_url || payload.productUrl || task.purchaseUrl;
  task.salePrice = edit.sale_price || detail.price || raw.price || task.salePrice;
  task.labelPrice = edit.old_price || raw.old_price || raw.originalPrice || task.labelPrice;
  task.supplierNote = edit.operation_note || task.supplierNote;
  task.sourceImageUrl = normalizeInternalImageUrl(images[0] || detail.image_url || task.sourceImageUrl);
  task.sourceImageOriginalUrl = task.sourceImageUrl;
  task.detailImageCount = Math.max(images.length - 1, 0);
  task.videoCount = normalizeImageList(raw.videos || payload.videos).length;
  task.sourceType = "collector_box";
  task.sourceId = String(detail.sku || "");
  task.sourceSelectionId = detail.selection_product_id || null;
  task.sourceCollectorSku = String(detail.sku || "");
  task.sourceListingRecordId = "";
  task.sourcePackageId = "";
  task.sourceLabel = `采集箱 SKU ${detail.sku || ""}`;
  sourceSubmitMode.value = "overwrite_collector";
  refreshRecommendedStrategiesFromCategory();
}

function applyOnlineProductSource(detail = {}) {
  const raw = parseOnlineProductRaw(detail);
  const images = onlineProductPreviewList(detail);
  const title = detail.name || raw.name || detail.offer_id || detail.ozon_sku || task.title;
  task.productName = title || task.productName;
  task.title = title || task.title;
  task.brand = normalizeImportedBrand(
    raw.brand
    || detail.brand
    || attributeValueFromList(raw.attributes || raw.attribute_values || raw.characteristics, ["brand", "品牌", "бренд"], [85])
  );
  task.vehicleModel = resolveImportedVehicleModel({ raw, detail });
  task.material = cleanImportedField(raw.material || detail.material) || task.material;
  task.color = normalizeTextValue(raw.color || detail.color, task.color);
  task.quantity = raw.quantity || detail.quantity || task.quantity;
  task.categoryName = detail.category_name || raw.category_name || raw.category || task.categoryName;
  task.productType = detail.category_name || raw.type_name || raw.category || task.productType;
  task.sellingPoints = raw.description || detail.description || task.sellingPoints;
  task.productTags = normalizeTextValue(raw.tags || raw.keywords || detail.tags, task.productTags);
  task.summary = raw.description || detail.description || task.summary;
  task.packageWeightG = raw.weight_g || raw.weight || detail.weight_g || task.packageWeightG;
  task.lengthCm = raw.length_cm || raw.length || detail.length_cm || task.lengthCm;
  task.widthCm = raw.width_cm || raw.width || detail.width_cm || task.widthCm;
  task.heightCm = raw.height_cm || raw.height || detail.height_cm || task.heightCm;
  task.sourcePlatform = "Ozon";
  task.salePrice = detail.sale_price ?? raw.sale_price ?? raw.price ?? task.salePrice;
  task.labelPrice = detail.old_price ?? raw.old_price ?? task.labelPrice;
  task.sourceImageUrl = normalizeInternalImageUrl(images[0] || detail.primary_image || detail.image_url || task.sourceImageUrl);
  task.sourceImageOriginalUrl = task.sourceImageUrl;
  task.detailImageCount = Math.max(images.length - 1, 0);
  task.videoCount = normalizeImageList(raw.videos || detail.video_urls).length;
  task.sourceType = "online_product";
  task.sourceId = String(detail.id || "");
  task.sourceSelectionId = detail.product_id || null;
  task.sourceCollectorSku = "";
  task.sourceListingRecordId = "";
  task.sourcePackageId = "";
  task.sourceLabel = `在线商品 #${detail.id || ""}${detail.offer_id ? ` / ${detail.offer_id}` : ""}`;
  sourceSubmitMode.value = "online_product_to_template";
  sourceImageRenderKey.value += 1;
  refreshRecommendedStrategiesFromCategory();
}

async function importOnlineProductSource(row = {}) {
  const importKey = `online-${String(row.id || "")}`;
  sourceImportingId.value = importKey;
  try {
    applyOnlineProductSource(row);
    sourceDialogVisible.value = false;
    ElMessage.success("已导入在线商品信息");
  } catch (error) {
    ElMessage.error(error.message || "导入在线商品失败");
  } finally {
    sourceImportingId.value = "";
  }
}

async function importCollectorSource(row = {}) {
  const importKey = String(row.sku || "");
  sourceImportingId.value = importKey;
  try {
    const detail = row.payload || row.rawPayload
      ? row
      : await apiClient.get(`/api/listing/collector-box/${encodeURIComponent(importKey)}`, { noCache: true });
    applyCollectorSource(detail || row);
    sourceDialogVisible.value = false;
    ElMessage.success("已导入采集箱商品，可在完整商品信息里补齐后加入选品池");
  } catch (error) {
    ElMessage.error(error.message || "导入采集箱商品失败");
  } finally {
    sourceImportingId.value = "";
  }
}

function applyListingRecordSource(detail = {}) {
  const item = detail.request?.items?.[0] || {};
  const images = listingRecordPreviewList(detail);
  const originalImageUrl = normalizeInternalImageUrl(listingRecordOriginalImageUrl(detail) || images[0] || "");
  const previewImageUrlForTask = normalizeInternalImageUrl(listingRecordThumbUrl(detail) || originalImageUrl || task.sourceImageUrl);
  task.sourceType = "listing_record";
  task.sourceImageUrl = previewImageUrlForTask;
  task.sourceImageOriginalUrl = originalImageUrl || previewImageUrlForTask;
  const material = extractRecordAttributeValue(item, ["材料", "材质", "material", "материал"], [7199]) || item.material || "";
  const color = extractRecordAttributeValue(item, ["颜色", "color", "цвет"], [10096]) || item.color || "";
  const tags = extractRecordAttributeValue(item, ["产品标签", "主题标签", "主图标签", "tag", "тег", "ключ"], [10096]);
  const description = item.description || extractRecordAttributeValue(item, ["描述", "description", "описание"], []);
  task.productName = item.name || detail.product_name || task.productName;
  task.title = item.name || detail.product_name || task.title;
  task.brand = normalizeImportedBrand(extractRecordAttributeValue(item, ["品牌", "brand", "бренд"], [85]));
  task.vehicleModel = resolveImportedVehicleModel({ item, detail });
  task.material = material || task.material;
  task.color = color || task.color;
  task.quantity = item.quantity || task.quantity;
  task.categoryName = detail.category_name || item.category_name || item.description_category_name || task.categoryName;
  task.productType = detail.category_name || item.type_name || task.productType;
  task.sellingPoints = description || task.sellingPoints;
  task.productTags = normalizeTextValue(tags, task.productTags);
  task.summary = description || task.summary;
  task.richContent = extractRecordRichContent(item) || task.richContent;
  task.packageWeightG = item.weight || detail.weight || task.packageWeightG;
  task.lengthCm = item.depth ? Number(item.depth) / 10 : task.lengthCm;
  task.widthCm = item.width ? Number(item.width) / 10 : task.widthCm;
  task.heightCm = item.height ? Number(item.height) / 10 : task.heightCm;
  task.sourcePlatform = "Ozon";
  task.purchaseUrl = detail.ozon_product_id ? `https://www.ozon.ru/product/${detail.ozon_product_id}` : task.purchaseUrl;
  task.salePrice = item.price || detail.price || task.salePrice;
  task.labelPrice = item.old_price || detail.old_price || task.labelPrice;
  task.detailImageCount = Math.max(images.length - 1, 0);
  task.videoCount = normalizeImageList(detail.video_urls || item.video_urls).length;
  task.sourceId = String(detail.id || "");
  task.sourceSelectionId = detail.source_product_id || null;
  task.sourceCollectorSku = "";
  task.sourceListingRecordId = String(detail.id || "");
  task.sourcePackageId = "";
  task.sourceLabel = `上架记录 #${detail.id || ""}${detail.offer_id ? ` / ${detail.offer_id}` : ""}`;
  sourceSubmitMode.value = "overwrite_listing_record";
  sourceImageRenderKey.value += 1;
  refreshRecommendedStrategiesFromCategory();
}

async function importListingRecordSource(row = {}) {
  const importKey = String(row.id || "");
  sourceImportingId.value = `listing-${importKey}`;
  try {
    const detail = row.request?.items
      ? row
      : await apiClient.get(`/api/listing/publish-records/${encodeURIComponent(importKey)}`, { noCache: true });
    applyListingRecordSource(detail || row);
    sourceDialogVisible.value = false;
    ElMessage.success("已导入上架记录商品信息");
  } catch (error) {
    ElMessage.error(error.message || "导入上架记录失败");
  } finally {
    sourceImportingId.value = "";
  }
}

function applyListingDraftSource(detail = {}) {
  const template = detail.template_payload || detail.templatePayload || {};
  const editable = template.editable_payload || template.editablePayload || {};
  const firstVariant = Array.isArray(editable.variants) ? editable.variants[0] : (Array.isArray(template.variants) ? template.variants[0] : {});
  const images = normalizeImageList([
    detail.source_images,
    detail.sourceImages,
    editable.images,
    template.images,
    firstVariant?.images
  ]);
  const title = detail.product_name || editable.title || template.title || firstVariant?.name || detail.internal_code || task.title;
  const description = detail.manual_facts?.description || editable.description || template.description || firstVariant?.description || task.summary;
  const tags = detail.manual_facts?.tags || detail.manual_facts?.hashtags || editable.tags || template.tags || firstVariant?.tags || task.productTags;
  task.productName = title || task.productName;
  task.title = title || task.title;
  task.brand = normalizeImportedBrand(detail.manual_facts?.brand || editable.brand || template.brand || task.brand);
  task.vehicleModel = resolveImportedVehicleModel({ raw: detail.manual_facts || editable || {}, detail });
  task.material = cleanImportedField(detail.manual_facts?.material || editable.material || template.material) || task.material;
  task.color = normalizeTextValue(detail.color || detail.manual_facts?.color || editable.color || template.color, task.color);
  task.quantity = detail.quantity || detail.manual_facts?.quantity || editable.quantity || task.quantity;
  task.categoryName = detail.category_name || template.category_name || editable.category_name || task.categoryName;
  task.productType = detail.category_name || template.type_name || editable.type_name || task.productType;
  task.sellingPoints = description || task.sellingPoints;
  task.productTags = normalizeTextValue(tags, task.productTags);
  task.summary = description || task.summary;
  task.richContent = detail.rich_content_json || detail.richContentJson || editable.rich_content_json || editable.richContentJson || task.richContent;
  task.packageWeightG = detail.weight_g || editable.weight || task.packageWeightG;
  task.lengthCm = detail.length_cm || editable.length_cm || task.lengthCm;
  task.widthCm = detail.width_cm || editable.width_cm || task.widthCm;
  task.heightCm = detail.height_cm || editable.height_cm || task.heightCm;
  task.salePrice = detail.sale_price ?? firstVariant?.price ?? task.salePrice;
  task.sourceImageUrl = normalizeInternalImageUrl(images[0] || task.sourceImageUrl);
  task.sourceImageOriginalUrl = task.sourceImageUrl;
  task.detailImageCount = Math.max(images.length - 1, 0);
  task.videoCount = normalizeImageList(detail.video_urls || detail.videoUrls || editable.video_urls || editable.videoUrls).length;
  task.sourceType = "material_asset";
  task.sourceId = String(detail.id || "");
  task.sourceSelectionId = null;
  task.sourceCollectorSku = "";
  task.sourceListingRecordId = "";
  task.sourcePackageId = "";
  task.sourceLabel = `草稿 #${detail.id || ""}${detail.internal_code ? ` / ${detail.internal_code}` : ""}`;
  sourceSubmitMode.value = "asset_only";
  sourceImageRenderKey.value += 1;
  refreshRecommendedStrategiesFromCategory();
}

async function importSelectionFromRoute() {
  const selectionId = String(route.query.baseSelectionId || "").trim();
  if (!selectionId || importedRouteSelectionId.value === selectionId || routeSelectionImporting.value) return;
  routeSelectionImporting.value = true;
  try {
    const detail = await apiClient.get(`/api/products/${encodeURIComponent(selectionId)}`, { noCache: true });
    const row = detail?.data || detail || {};
    if (!row?.id) return;
    applySelectionSource(row);
    importedRouteSelectionId.value = selectionId;
    ElMessage.success(`已导入选品 ${row.selection_id || row.id} 到 AI 内容优化`);
  } catch (error) {
    ElMessage.error(error.message || "导入选品到 AI 内容优化失败");
  } finally {
    routeSelectionImporting.value = false;
  }
}

async function importCollectorFromRoute() {
  const sku = String(route.query.collectorSku || "").trim();
  if (!sku || importedRouteCollectorSku.value === sku || routeSelectionImporting.value) return;
  routeSelectionImporting.value = true;
  try {
    const detail = await apiClient.get(`/api/listing/collector-box/${encodeURIComponent(sku)}`, { noCache: true });
    applyCollectorSource(detail || {});
    importedRouteCollectorSku.value = sku;
    ElMessage.success(`已从采集箱 ${sku} 返回 AI 内容优化`);
  } catch (error) {
    ElMessage.error(error.message || "导入采集箱到 AI 内容优化失败");
  } finally {
    routeSelectionImporting.value = false;
  }
}

async function importOnlineProductFromRoute() {
  const onlineProductId = String(route.query.onlineProductId || "").trim();
  const signature = `${onlineProductId}:${String(route.query.source || "")}:${String(route.query.autoImport || "")}:${String(route.query.importAt || "")}`;
  const alreadyImportedCurrentProduct = task.sourceType === "online_product" && String(task.sourceId || "") === onlineProductId;
  if (!onlineProductId || routeSelectionImporting.value) return;
  if (importedRouteOnlineProductSignature.value === signature && alreadyImportedCurrentProduct) return;
  routeSelectionImporting.value = true;
  try {
    const detail = await apiClient.get(`/api/online-products/${encodeURIComponent(onlineProductId)}/edit-draft`, { noCache: true });
    applyOnlineProductSource(detail || {});
    importedRouteOnlineProductSignature.value = signature;
    ElMessage.success(`已从在线商品 ${onlineProductId} 返回 AI 内容优化`);
  } catch (error) {
    ElMessage.error(error.message || "导入在线商品到 AI 内容优化失败");
  } finally {
    routeSelectionImporting.value = false;
  }
}

async function importListingDraftFromRoute() {
  const draftId = firstRouteId(route.query.draftId || route.query.draftIds);
  const signature = `${draftId}:${String(route.query.source || "")}:${String(route.query.autoImport || "")}:${String(route.query.importAt || "")}`;
  const alreadyImportedCurrentDraft = task.sourceType === "material_asset" && String(task.sourceId || "") === draftId && String(task.sourceLabel || "").startsWith("草稿 #");
  if (!draftId || routeSelectionImporting.value) return;
  if (importedRouteDraftSignature.value === signature && alreadyImportedCurrentDraft) return;
  routeSelectionImporting.value = true;
  try {
    const detail = await apiClient.get(`/api/listing/drafts/${encodeURIComponent(draftId)}`, { noCache: true });
    applyListingDraftSource(detail || {});
    importedRouteDraftSignature.value = signature;
    ElMessage.success(`已从草稿 ${draftId} 返回 AI 内容优化`);
  } catch (error) {
    ElMessage.error(error.message || "导入草稿到 AI 内容优化失败");
  } finally {
    routeSelectionImporting.value = false;
  }
}

async function importListingRecordFromRoute() {
  const recordId = String(route.query.listingRecordId || "").trim();
  const signature = `${recordId}:${String(route.query.source || "")}:${String(route.query.autoImport || "")}:${String(route.query.importAt || "")}`;
  const alreadyImportedCurrentRecord = task.sourceType === "listing_record" && String(task.sourceListingRecordId || "") === recordId;
  if (!recordId || routeSelectionImporting.value) return;
  if (importedRouteListingRecordSignature.value === signature && alreadyImportedCurrentRecord) return;
  routeSelectionImporting.value = true;
  try {
    const detail = await apiClient.get(`/api/listing/publish-records/${encodeURIComponent(recordId)}`, { noCache: true });
    if (!detail?.id && !detail?.request?.items?.length) throw new Error("Listing record detail is empty");
    applyListingRecordSource(detail || {});
    importedRouteListingRecordId.value = recordId;
    importedRouteListingRecordSignature.value = signature;
    ElMessage.success(`已从上架记录 ${recordId} 返回 AI 内容优化`);
  } catch (error) {
    ElMessage.error(error.message || "导入上架记录到 AI 内容优化失败");
  } finally {
    routeSelectionImporting.value = false;
  }
}

function firstRouteId(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",").map((item) => item.trim()).find(Boolean) || "";
}

function importAssetSource(asset = {}) {
  task.productName = asset.product_name || asset.assetVariantSourceTitle || asset.title || task.productName;
  task.title = asset.metadata?.title || asset.title || task.title;
  task.brand = asset.target_brand || task.brand;
  task.vehicleModel = asset.target_model || task.vehicleModel;
  task.material = asset.metadata?.material || task.material;
  task.color = normalizeTextValue(asset.metadata?.color, task.color);
  task.quantity = asset.metadata?.quantity || task.quantity;
  task.categoryName = asset.metadata?.categoryName || asset.metadata?.ozonCategory || task.categoryName;
  task.productType = asset.metadata?.productType || task.productType;
  task.sellingPoints = asset.metadata?.sellingPoints || task.sellingPoints;
  task.productTags = normalizeTextValue(asset.metadata?.tags, task.productTags);
  task.summary = asset.metadata?.summary || asset.metadata?.description || task.summary;
  task.richContent = asset.metadata?.richContent || task.richContent;
  task.packageWeightG = asset.metadata?.packageWeightG || task.packageWeightG;
  task.lengthCm = asset.metadata?.lengthCm || task.lengthCm;
  task.widthCm = asset.metadata?.widthCm || task.widthCm;
  task.heightCm = asset.metadata?.heightCm || task.heightCm;
  task.logisticsRuleName = asset.metadata?.logisticsRuleName || task.logisticsRuleName;
  task.sourcePlatform = asset.metadata?.sourcePlatform || task.sourcePlatform;
  task.supplierName = asset.metadata?.supplierName || task.supplierName;
  task.purchaseUrl = asset.metadata?.purchaseUrl || task.purchaseUrl;
  task.purchaseCost = asset.metadata?.purchaseCost ?? task.purchaseCost;
  task.domesticShipping = asset.metadata?.domesticShipping ?? task.domesticShipping;
  task.handlingFee = asset.metadata?.handlingFee ?? task.handlingFee;
  task.salePrice = asset.metadata?.salePrice ?? task.salePrice;
  task.labelPrice = asset.metadata?.labelPrice ?? task.labelPrice;
  task.exchangeRate = asset.metadata?.exchangeRate ?? task.exchangeRate;
  task.supplierNote = asset.metadata?.supplierNote || task.supplierNote;
  task.sourceImageUrl = normalizeInternalImageUrl(asset.thumbnail_url || asset.url || task.sourceImageUrl);
  task.sourceImageOriginalUrl = normalizeInternalImageUrl(asset.url || asset.thumbnail_url || task.sourceImageUrl);
  task.sourceType = "material_asset";
  task.sourceId = String(asset.id || "");
  task.sourceSelectionId = asset.source_selection_id || null;
  task.sourceCollectorSku = "";
  task.sourceListingRecordId = "";
  task.sourcePackageId = asset.source_package_id || asset.source_id || "";
  task.sourceLabel = `统一素材资产 #${asset.id || ""}`;
  sourceSubmitMode.value = "asset_only";
  refreshRecommendedStrategiesFromCategory();
  sourceDialogVisible.value = false;
  ElMessage.success("已导入统一素材资产");
}

function refreshRecommendedStrategiesFromCategory() {
  task.selectedStrategies = selectedGoalStrategies.value[0] ? [selectedGoalStrategies.value[0]] : [];
  applyCategoryStrategyDefaults();
}

function sourceModeLabel(mode = sourceSubmitMode.value) {
  return writebackStrategies.value[mode]?.actionLabel || "仅保存结果";
}

function applyTemplate(template) {
  selectedTemplateId.value = template.id;
  task.ratio = template.default_ratio || "3:4";
  task.imageCount = Number(template.default_count || 1);
  task.promptModules.styleRule = template.positive_prompt || "";
  task.promptModules.negativePrompt = template.negative_prompt || "";
}

function addTargetFromInput() {
  const rows = task.targetInput.split(/[\n,，;；]/).map((item) => item.trim()).filter(Boolean);
  if (!rows.length) {
    ElMessage.warning("请输入车型，例如 TENET T4");
    return;
  }
  rows.forEach((item) => {
    if (!task.targets.includes(item)) task.targets.push(item);
  });
  task.targetInput = "";
}

function removeTarget(index) {
  task.targets.splice(index, 1);
}

function quickTargets(values) {
  values.forEach((item) => {
    if (!task.targets.includes(item)) task.targets.push(item);
  });
}

function clearTargets() {
  task.targets = [];
}

function triggerReferenceUpload() {
  referenceUploadInputRef.value?.click();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

async function handleReferenceUpload(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  if (!file.type?.startsWith("image/")) {
    ElMessage.warning("请上传图片文件");
    event.target.value = "";
    return;
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    task.sourceImageUrl = dataUrl;
    task.sourceImageOriginalUrl = dataUrl;
    task.sourceType = "local_reference_image";
    task.sourceId = file.name;
    task.sourceSelectionId = null;
    task.sourceCollectorSku = "";
    task.sourceListingRecordId = "";
    task.sourcePackageId = "";
    task.sourceLabel = `本地上传参考图：${file.name}`;
    task.useSourceImageAsReference = true;
    ElMessage.success("参考图已上传，可作为 image2 参考图使用");
  } catch (error) {
    ElMessage.error(error.message || "参考图读取失败");
  } finally {
    event.target.value = "";
  }
}

function selectOptimizationTarget(item) {
  task.optimizationTarget = item.key;
  const fallbackVariantMode = item.key?.startsWith("multi_") ? "multi_model_variant" : item.key === "low_exposure" ? "title_generation" : item.key === "low_conversion" ? "detail_image" : "main_image_variant";
  task.variantMode = item.variantMode || fallbackVariantMode || task.variantMode;
  const nextStrategies = strategyGroups[
    ["title_optimize", "low_exposure"].includes(item.key) ? "title"
      : item.key === "tag_optimize" ? "tags"
        : ["detail_image_redo", "installation_scene", "low_conversion", "high_cart_low_order", "description_optimize", "selling_point_extract"].includes(item.key) ? "detail"
          : item.groupType === "copy" ? "title" : "image"
  ] || strategyGroups.image;
  task.strategyKey = nextStrategies[0]?.key || "premium";
  if (item.variantMode === "detail_image") task.outputs = Array.from(new Set([...task.outputs, "详情图", "描述"]));
  if (item.variantMode === "title_generation") task.outputs = Array.from(new Set([...task.outputs, "标题", "标签"]));
  if (["main_image_variant", "multi_model_variant", "logo_text_replace"].includes(item.variantMode)) task.outputs = Array.from(new Set([...task.outputs, "主图"]));
  if (isTextWorkbench.value) {
    task.outputs = [...TEXT_OUTPUT_ITEMS];
  }
  syncImageStyleFromStrategy();
  task.selectedStrategies = selectedGoalStrategies.value[0] ? [selectedGoalStrategies.value[0]] : [];
  applyCategoryStrategyDefaults();
}

function selectStrategy(item) {
  task.strategyKey = item.key;
  syncImageStyleFromStrategy();
}

function toggleRecommendedStrategy(title) {
  if (isTextWorkbench.value) {
    task.selectedStrategies = [title];
    return;
  }
  if (isVariantWorkflow.value) {
    task.selectedStrategies = [title];
    return;
  }
  const index = task.selectedStrategies.indexOf(title);
  if (index >= 0) task.selectedStrategies.splice(index, 1);
  else task.selectedStrategies.push(title);
}

function toggleTextTask(outputKey) {
  const nextOutputs = task.outputs.filter((item) => TEXT_OUTPUT_ITEMS.includes(item));
  const exists = nextOutputs.includes(outputKey);
  if (exists && nextOutputs.length === 1) return;
  task.outputs = exists
    ? nextOutputs.filter((item) => item !== outputKey)
    : [...nextOutputs, outputKey];
  task.optimizationTarget = resolveTextGoalKey(task.outputs);
  if (!goalStrategyCards.value.some((item) => item.title === task.selectedStrategies[0])) {
    task.selectedStrategies = selectedGoalStrategies.value[0] ? [selectedGoalStrategies.value[0]] : [];
  }
}

function syncImageStyleFromStrategy() {
  if (styleOptions.some((item) => item.key === task.strategyKey)) {
    task.style = task.strategyKey;
  }
}

function applyCategoryStrategyDefaults() {
  if (isTextWorkbench.value) return;
  const rule = activeCategoryGoalRule.value;
  if (!rule) return;
  if (Array.isArray(rule.recommendedAssets) && rule.recommendedAssets.length) {
    const outputAssets = rule.recommendedAssets.map((item) => {
      if (["安装图", "场景图", "白底图", "对比图", "尺寸图", "材质图"].includes(item)) return "详情图";
      if (item === "卖点") return "描述";
      return item;
    }).filter((item) => ["主图", "详情图"].includes(item));
    task.outputs = Array.from(new Set([...task.outputs, ...outputAssets]));
    const detailTypes = rule.recommendedAssets.filter((item) => ["安装图", "场景图", "白底图", "对比图", "尺寸图", "材质图"].includes(item));
    if (detailTypes.length) {
      const normalized = detailTypes.map((item) => ({
        安装图: "安装图",
        场景图: "使用场景图",
        白底图: "白底说明图",
        对比图: "对比图",
        尺寸图: "尺寸说明图",
        材质图: "材质细节图"
      }[item] || item));
      task.detailImageTypes = Array.from(new Set([...task.detailImageTypes, ...normalized]));
    }
  }
  const preferredStyle = (rule.imageStyles?.includes("high_click") ? "high_click" : null)
    || rule.imageStyles?.find((key) => styleOptions.some((item) => item.key === key));
  if (preferredStyle && currentStrategyType.value !== "title" && currentStrategyType.value !== "tags") {
    task.style = preferredStyle;
    task.strategyKey = preferredStyle;
  }
}

function openDiagnosis() {
  diagnosisDrawer.value = true;
}

function applyDiagnosis(item) {
  const target = flatOptimizationTargets.value.find((option) => option.key === item.key);
  if (target) selectOptimizationTarget(target);
  diagnosisDrawer.value = false;
  ElMessage.success(`已切换到：${item.title}`);
}

function buildVariables(targetModel = "") {
  return {
    product_name: task.productName,
    title: task.title,
    brand: task.brand,
    vehicle_model: task.vehicleModel,
    material: task.material,
    color: task.color,
    quantity: task.quantity,
    category_name: task.categoryName,
    product_type: task.productType,
    selling_points: task.sellingPoints,
    product_tags: task.productTags,
    summary: task.summary,
    package_weight_g: task.packageWeightG,
    package_size: `${task.lengthCm || "-"}x${task.widthCm || "-"}x${task.heightCm || "-"}cm`,
    logistics_rule: task.logisticsRuleName,
    source_platform: task.sourcePlatform,
    supplier: task.supplierName,
    target_model: targetModel,
    main_image_style: selectedStyle.value.title,
    user_prompt: task.customPrompt,
    ratio: task.ratio
  };
}

async function renderPromptForTarget(targetModel = task.targets[0] || "", strategyTitles = selectedStrategyTitles.value, job = {}) {
  const template = activeTemplate.value;
  const positivePrompt = buildPositivePrompt(strategyTitles, job);
  const negativePrompt = buildNegativePrompt(strategyTitles);
  if (!template) {
    return {
      finalPositivePrompt: renderText(positivePrompt, buildVariables(targetModel)),
      finalNegativePrompt: renderText(negativePrompt, buildVariables(targetModel)),
      missingVariables: []
    };
  }
  return renderAiPromptTemplate({
    templateId: template.id,
    positivePrompt,
    negativePrompt,
    variables: buildVariables(targetModel),
    assetKind: resolvePromptAssetKind(job),
    detailImageType: job.detailType || ""
  });
}

function resolvePromptAssetKind(job = {}) {
  if (job.type === "主图") return "main_image";
  if (job.type === "详情图") return "detail_image";
  if (job.type === "标题") return "title";
  if (job.type === "标签") return "tags";
  if (job.type === "描述") return "description";
  return task.outputs.includes("主图") ? "main_image" : "title";
}

async function previewPrompt() {
  strategyDrawer.value = true;
  try {
    const firstJob = buildGenerationJobs()[0];
    previewContext.targetModel = firstJob?.targetModel || task.targets[0] || "";
    previewContext.strategyTitles = firstJob?.strategyTitles?.length ? [...firstJob.strategyTitles] : selectedStrategyTitles.value.slice(0, 1);
    previewContext.job = firstJob ? { ...firstJob } : {};
    const result = await renderPromptForTarget(firstJob?.targetModel || "", firstJob?.strategyTitles || selectedStrategyTitles.value.slice(0, 1));
    previewPositivePrompt.value = result.finalPositivePrompt;
    previewNegativePrompt.value = result.finalNegativePrompt;
    promptEditorState.positivePrompt = "";
    promptEditorState.negativePrompt = "";
    promptEditorState.variablesJson = JSON.stringify(buildVariables(firstJob?.targetModel || task.targets[0] || ""), null, 2);
  } catch (error) {
    ElMessage.error(error.message || "Prompt 预览失败");
  }
}

async function startGenerate() {
  if (isVariantWorkflow.value && task.variantMode === "multi_model_variant" && !task.targets.length) {
    ElMessage.warning("请先添加目标车型");
    return;
  }
  if (!task.outputs.length) {
    ElMessage.warning(isTextWorkbench.value ? "请先选择要优化的文本任务" : "请先选择要生成的图片资产");
    return;
  }
  const jobs = buildGenerationJobs();
  if (!jobs.length) {
    ElMessage.warning(isVariantWorkflow.value ? "请先选择裂变策略并添加变量" : "请先选择至少一个独立策略");
    return;
  }
  results.value = [];
  generating.value = true;
  taskStatus.value = "生成中";
  activeResultTab.value = currentStrategyType.value === "tags" ? "tags" : currentStrategyType.value === "title" ? "titles" : "images";
  try {
    const resultJobs = jobs.map((queueItem) => createResultShell(queueItem));
    results.value = [...resultJobs].reverse();
    const concurrency = jobs.some(isImageJob) ? IMAGE_GENERATION_CONCURRENCY : COPY_GENERATION_CONCURRENCY;
    const settled = await runGenerationQueue(resultJobs, concurrency);
    const failedCount = settled.filter((item) => item.status === "rejected").length;
    taskStatus.value = failedCount ? "部分失败" : "已完成";
    if (failedCount) ElMessage.warning(`生成完成，${failedCount} 个任务失败`);
    else ElMessage.success(isTextWorkbench.value ? "文本生成完成" : "图片生成完成");
  } catch (error) {
    taskStatus.value = "失败";
    ElMessage.error(error.message || "生成失败");
  } finally {
    generating.value = false;
  }
}

async function runGenerationQueue(jobs = [], concurrency = 2) {
  const settled = new Array(jobs.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(Number(concurrency || 1), 1), jobs.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      try {
        await generateOne(jobs[index]);
        settled[index] = { status: "fulfilled" };
      } catch (error) {
        settled[index] = { status: "rejected", reason: error };
      }
    }
  });
  await Promise.all(workers);
  return settled;
}

function buildGenerationJobs() {
  const strategies = selectedStrategyTitles.value.filter(Boolean);
  const copyOutputs = ["标题", "标签", "描述"].filter((item) => task.outputs.includes(item));
  const imageOutputs = [];
  if (task.outputs.includes("主图")) imageOutputs.push({ type: "主图", assetKind: "image" });
  if (task.outputs.includes("详情图")) {
    const detailTypes = task.detailImageTypes.length ? task.detailImageTypes : ["详情图"];
    detailTypes.forEach((detailType) => imageOutputs.push({ type: "详情图", detailType, assetKind: "image" }));
  }
  const buildForUnit = ({ targetModel = "", strategyTitle = "" }) => {
    const groupKey = [targetModel || "base", strategyTitle || "default"].join("::");
    return [
      ...imageOutputs.map((output) => ({
        targetModel,
        strategyTitle,
        strategyTitles: [strategyTitle].filter(Boolean),
        writeBackGroupKey: groupKey,
        ...output
      })),
      ...(copyOutputs.length ? [{
        targetModel,
        strategyTitle,
        strategyTitles: [strategyTitle].filter(Boolean),
        writeBackGroupKey: groupKey,
        type: "文案",
        assetKind: "copy",
        copyOutputs
      }] : [])
    ];
  };
  if (isVariantWorkflow.value) {
    const strategyTitle = strategies[0] || selectedGoalStrategies.value[0] || selectedOptimizationTarget.value?.title || "裂变策略";
    const variables = task.variantMode === "multi_model_variant"
      ? task.targets
      : (task.targets.length ? task.targets : [selectedOptimizationTarget.value?.title || "裂变变量"]);
    return variables.filter(Boolean).flatMap((targetModel) => buildForUnit({ targetModel, strategyTitle }));
  }
  return strategies.flatMap((strategyTitle) => buildForUnit({ targetModel: task.targets[0] || "", strategyTitle }));
}

async function generateOne(job) {
  job.status = "生成中";
  job.pendingTaskId = "";
  job.progress = 30;
  const prompt = await renderPromptForTarget(job.targetModel, job.strategyTitles, job);
  const strategyPlan = resolveStrategyPlanForTitles(job.strategyTitles);
  job.strategyPlan = strategyPlan;
  job.finalPositivePrompt = prompt.finalPositivePrompt;
  job.finalNegativePrompt = prompt.finalNegativePrompt;
  if (isCopyJob(job)) {
    await fillCopyResults(job);
    await persistCopyAsset(job);
    job.status = "已完成";
    job.pendingTaskId = "";
    job.progress = 100;
    logs.value.unshift({
      time: new Date().toLocaleString(),
      status: "success",
      message: "文案素材已生成",
      model: "Mock copy generator"
    });
    return;
  }
  job.progress = 58;
  const startedAt = new Date();
  try {
    const sourceImageUrl = shouldUseReferenceImage() ? (task.sourceImageOriginalUrl || task.sourceImageUrl) : "";
    const sourceImageForRequest = sourceImageUrl && !sourceImageUrl.startsWith("data:")
      ? withImageToken(sourceImageUrl)
      : sourceImageUrl;
    let result;
    try {
      result = await generateAiImages({
        finalPrompt: [prompt.finalPositivePrompt, prompt.finalNegativePrompt ? `Negative: ${prompt.finalNegativePrompt}` : ""].filter(Boolean).join("\n\n"),
        ratio: task.ratio,
        imageCount: 1,
        autoCrop: false,
        sourceImageUrl: sourceImageForRequest,
        mode: sourceImageForRequest ? "image_to_image" : "text_to_image"
      });
    } catch (error) {
      if (error?.code === "AI_TASK_STILL_RUNNING") throw error;
      if (!sourceImageForRequest) throw error;
      logs.value.unshift({
        time: new Date().toLocaleString(),
        status: "warning",
        message: `参考图读取或图生图失败，已自动改用文生图：${error.message || "未知错误"}`,
        model: "CCTQ-image2"
      });
      result = await generateAiImages({
        finalPrompt: [
          prompt.finalPositivePrompt,
          "No source image was available. Recreate the product faithfully from the provided product information.",
          prompt.finalNegativePrompt ? `Negative: ${prompt.finalNegativePrompt}` : ""
        ].filter(Boolean).join("\n\n"),
        ratio: task.ratio,
        imageCount: 1,
        autoCrop: false,
        mode: "text_to_image"
      });
    }
    const image = result.generatedImages?.[0];
    job.imageUrl = image?.url || "";
    job.downloadUrl = image?.url || "";
    if (job.imageUrl) {
      const taskSnapshot = createAiTaskSnapshot({
        task: { ...task, selectedTemplateId: selectedTemplateId.value },
        job,
        strategyPlan,
        prompt,
        targetModel: job.targetModel,
        result: {
          imageUrl: job.imageUrl,
          generationMode: result.generationMode || (sourceImageForRequest ? "image_to_image" : "text_to_image"),
          provider: "cctq-image2",
          model: "gpt-image-2"
        }
      });
      const asset = await createMaterialAsset({
        asset_type: "image",
        role: job.type === "详情图" ? "detail_image" : "main_image",
        title: `${task.productName} ${job.targetModel || job.strategyTitle} ${job.detailType || selectedStyle.value.title}`,
        url: job.imageUrl,
        thumbnail_url: job.imageUrl,
        source_type: "ai_generated",
        source_id: job.id,
        source_selection_id: task.sourceSelectionId,
        source_package_id: task.sourcePackageId,
        variant_task_id: task.sourceId,
        variant_result_id: job.id,
        target_brand: task.brand,
        target_model: job.targetModel,
        product_name: task.productName,
        style: `${selectedStyle.value.title} / ${job.strategyTitle || ""}`.trim(),
        ratio: task.ratio,
        prompt_template_id: selectedTemplateId.value,
        final_prompt: job.finalPositivePrompt,
        negative_prompt: job.finalNegativePrompt,
        provider: "cctq-image2",
        model: "gpt-image-2",
        status: "pending_review",
        metadata: {
          taskSnapshot,
          strategyLibraryVersion: strategyPlan.version,
          businessMode: strategyPlan.businessMode,
          strategyIds: strategyPlan.strategyIds,
          strategyTitles: strategyPlan.strategyTitles,
          strategyLayers: strategyPlan.layers,
          promptModules: strategyPlan.positiveModules,
          negativePromptModules: strategyPlan.negativeModules,
          sourceType: task.sourceType,
          sourceLabel: task.sourceLabel,
          outputs: task.outputs,
          outputType: job.type,
          detailType: job.detailType || "",
          sourceImageUrl,
          generationMode: result.generationMode || (sourceImageForRequest ? "image_to_image" : "text_to_image"),
          generatedTitles: job.generatedTitles,
          generatedTags: job.generatedTags,
          generatedDescription: job.generatedDescription
        }
      });
      job.assetId = asset.id;
      job.assetStatus = asset.status;
    }
    job.status = "已完成";
    job.progress = 100;
    logs.value.unshift({
      time: startedAt.toLocaleString(),
      status: "success",
      message: `image2 ${result.generationMode === "image_to_image" ? "图生图" : "文生图"} 返回 ${result.generatedImages?.length || 0} 张图片`,
      model: "CCTQ-image2"
    });
  } catch (error) {
    job.status = error?.code === "AI_TASK_STILL_RUNNING" ? "等待服务商" : "失败";
    job.pendingTaskId = error?.taskId || job.pendingTaskId || "";
    job.errorMessage = error.message || "生成失败";
    logs.value.unshift({
      time: startedAt.toLocaleString(),
      status: "failed",
      message: job.errorMessage,
      model: "CCTQ-image2"
    });
    throw error;
  }
}

async function persistCopyAsset(job) {
  const strategyPlan = job.strategyPlan || aiStrategyPlan.value;
  const taskSnapshot = createAiTaskSnapshot({
    task: { ...task, selectedTemplateId: selectedTemplateId.value },
    job,
    strategyPlan,
    prompt: {
      finalPositivePrompt: job.finalPositivePrompt,
      finalNegativePrompt: job.finalNegativePrompt
    },
    targetModel: job.targetModel,
    result: {
      generatedTitles: job.generatedTitles,
      generatedTags: job.generatedTags,
      generatedDescription: job.generatedDescription,
      provider: "cctq-text",
      model: "mock-copy-generator"
    }
  });
  const asset = await createMaterialAsset({
    asset_type: "copy",
    role: "commerce_copy",
    title: `${task.productName} ${job.targetModel || job.strategyTitle} 文案素材`,
    content_text: JSON.stringify({
      titles: job.generatedTitles,
      tags: job.generatedTags,
      description: job.generatedDescription
    }, null, 2),
    source_type: "ai_generated",
    source_id: job.id,
    source_selection_id: task.sourceSelectionId,
    source_package_id: task.sourcePackageId,
    variant_task_id: task.sourceId,
    variant_result_id: job.id,
    target_brand: task.brand,
    target_model: job.targetModel,
    product_name: task.productName,
    style: job.strategyTitle || selectedStrategy.value?.title || "",
    prompt_template_id: selectedTemplateId.value,
    final_prompt: job.finalPositivePrompt,
    negative_prompt: job.finalNegativePrompt,
    provider: "cctq-text",
    model: "mock-copy-generator",
    status: "pending_review",
    metadata: {
      taskSnapshot,
      strategyLibraryVersion: strategyPlan.version,
      businessMode: strategyPlan.businessMode,
      strategyIds: strategyPlan.strategyIds,
      strategyTitles: strategyPlan.strategyTitles,
      strategyLayers: strategyPlan.layers,
      promptModules: strategyPlan.positiveModules,
      negativePromptModules: strategyPlan.negativeModules,
      sourceType: task.sourceType,
      sourceLabel: task.sourceLabel,
      outputs: task.outputs,
      generatedTitles: job.generatedTitles,
      generatedTags: job.generatedTags,
      generatedDescription: job.generatedDescription
    }
  });
  job.assetId = asset.id;
  job.assetStatus = asset.status;
}

function shouldUseReferenceImage() {
  return Boolean(task.useSourceImageAsReference && task.sourceImageUrl && task.sourceType !== "demo");
}

function hasImageOutput() {
  return task.outputs.some((item) => ["主图", "详情图"].includes(item));
}

function hasCopyOutput() {
  return ["标题", "标签", "描述"].some((item) => task.outputs.includes(item));
}

function isCopyJob(job = {}) {
  return job.assetKind === "copy" || job.type === "文案";
}

function isImageJob(job = {}) {
  return job.assetKind === "image" || ["主图", "详情图"].includes(job.type);
}

function jobCopyOutputs(job = {}) {
  return Array.isArray(job.copyOutputs) && job.copyOutputs.length
    ? job.copyOutputs
    : ["标题", "标签", "描述"].filter((item) => task.outputs.includes(item));
}

function normalizeCopyOutputs(job) {
  const outputs = jobCopyOutputs(job);
  if (!outputs.includes("标题")) job.generatedTitles = [];
  if (!outputs.includes("标签")) job.generatedTags = [];
  if (!outputs.includes("描述")) job.generatedDescription = "";
}

function ruCopy(value) {
  if (!value || typeof value !== "object") return String(value || "");
  return String(value.ru || value.russian || value.title || value.value || "").trim();
}

function zhCopy(value) {
  if (!value || typeof value !== "object") return "";
  return String(value.zh || value.cn || value.chinese || value.meaning || value.translation || "").trim();
}

function normalizeCopyForWrite(value) {
  return ruCopy(value) || String(value || "");
}

function containsChineseCopy(value) {
  const text = normalizeCopyForWrite(value);
  return /[\u4e00-\u9fff]/.test(text);
}

function hasRussianCopy(value) {
  const items = Array.isArray(value) ? value : [value];
  return items.some((item) => /[А-Яа-яЁё]/.test(ruCopy(item) || String(item || "")));
}

function countCopyWords(value) {
  return (normalizeCopyForWrite(value).match(/[A-Za-zА-Яа-яЁё0-9-]+/g) || []).length;
}

function normalizeBrandForRussianCopy(value) {
  const text = normalizedTextForCompare(value);
  if (!text || /^(no brand|без бренда|нет бренда|无品牌)$/i.test(text)) return "";
  return containsChineseCopy(text) ? "" : text;
}

function normalizeRussianSafeText(value, fallback = "") {
  const text = normalizeCopyForWrite(value).replace(/\s+/g, " ").trim();
  if (!text || containsChineseCopy(text) || !hasRussianCopy(text)) return fallback;
  return text;
}

function primaryProductSignals() {
  const text = `${task.title || ""} ${task.productName || ""} ${task.productType || ""}`.toLowerCase();
  if (text.includes("门槛")) return ["порог", "наклад"];
  if (text.includes("钥匙") || text.includes("key")) return ["ключ", "чех"];
  if (text.includes("保护壳")) return ["чех", "защит"];
  if (text.includes("脚垫") || text.includes("垫")) return ["ковр", "наклад"];
  const typeRu = productTypeRu(task.productType || task.productName || task.title);
  return typeRu.split(/\s+/).map((item) => item.toLowerCase()).filter((item) => item.length > 4).slice(0, 2);
}

function titleMatchesProductFocus(value) {
  const text = normalizeCopyForWrite(value).toLowerCase();
  const signals = primaryProductSignals();
  return !signals.length || signals.some((item) => text.includes(item));
}

function scoreClickTitleCandidate(value, job = {}) {
  const text = normalizeCopyForWrite(value);
  const lower = text.toLowerCase();
  let score = 0;
  if (titleMatchesProductFocus(text)) score += 5;
  if (job.targetModel && lower.includes(String(job.targetModel).toLowerCase())) score += 3;
  if (task.brand && lower.includes(String(task.brand).toLowerCase())) score += 2;
  if (task.material && lower.includes(String(task.material).toLowerCase())) score += 1;
  if (/защит|против|стиль|прочный|эффектив/i.test(lower)) score += 3;
  const length = text.length;
  if (length >= 70 && length <= 140) score += 3;
  return score;
}

function scoreSearchTitleCandidate(value, job = {}) {
  const text = normalizeCopyForWrite(value);
  const lower = text.toLowerCase();
  let score = 0;
  if (titleMatchesProductFocus(text)) score += 6;
  if (task.brand && lower.includes(String(task.brand).toLowerCase())) score += 2;
  if (job.targetModel && lower.includes(String(job.targetModel).toLowerCase())) score += 4;
  if (task.material && lower.includes(String(task.material).toLowerCase())) score += 2;
  if (/для|автомобил|ozon|комплект|наклад|чехол/i.test(lower)) score += 2;
  const length = text.length;
  if (length >= 80 && length <= 155) score += 3;
  return score;
}

function uniqueCopyList(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeCopyForWrite(item).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatRussianTag(value) {
  const text = normalizeCopyForWrite(value)
    .replace(/^#+/, "")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .trim();
  if (!text) return "";
  const tag = `#${text}`;
  if (tag.length >= 30) return "";
  if (containsChineseCopy(tag)) return "";
  return tag;
}

function buildFallbackRussianTags(job = {}) {
  const modelText = normalizeCopyForWrite(job.targetModel || task.vehicleModel || "");
  const brandText = normalizeBrandForRussianCopy(task.brand);
  const materialRu = normalizeCopyForWrite(productMaterialRu(task.material));
  const typeRu = normalizeCopyForWrite(productTypeRu(task.productType || task.productName || task.title));
  const colorText = normalizeRussianSafeText(task.color);
  const base = [
    brandText,
    modelText,
    typeRu,
    materialRu,
    colorText,
    "автоаксессуары",
    "накладки_на_порог",
    "защита_порога",
    "защита_автомобиля",
    "аксессуары_для_авто",
    "легкая_установка",
    "прочный_материал",
    "защита_от_царапин",
    "внутренний_тюнинг",
    "декор_салона",
    "стильный_аксессуар",
    "защитная_накладка",
    "тюнинг_авто",
    "комплект_для_авто"
  ];
  return uniqueCopyList(base.map(formatRussianTag).filter(Boolean)).slice(0, 20);
}

function normalizeRussianTags(value, job = {}) {
  const list = Array.isArray(value)
    ? value.flatMap((item) => normalizeCopyForWrite(item).split(/[\n,，]+/))
    : String(value || "").split(/[\n,，]+/);
  const normalized = uniqueCopyList(list.map(formatRussianTag).filter(Boolean));
  const fallback = buildFallbackRussianTags(job);
  return uniqueCopyList([...normalized, ...fallback]).slice(0, 20);
}

function buildLongRussianDescription(job = {}) {
  const modelText = normalizeCopyForWrite(job.targetModel || task.vehicleModel || "универсальной модели");
  const brandText = normalizeBrandForRussianCopy(task.brand) || "автомобиля";
  const materialRu = normalizeCopyForWrite(productMaterialRu(task.material));
  const typeRu = normalizeCopyForWrite(productTypeRu(task.productType || task.productName || task.title));
  const selling = normalizeRussianSafeText(task.sellingPoints, "Аккуратный внешний вид, защита от царапин и простая установка без сложного инструмента.");
  const colorText = normalizeRussianSafeText(task.color);
  const text = [
    `${typeRu} для ${brandText} ${modelText} подходит для ежедневного использования и помогает сохранить аккуратный вид автомобиля. Аксессуар закрывает наиболее уязвимую зону, которая часто страдает от обуви, мелкой пыли, песка и постоянного контакта при посадке и высадке.`,
    `Материал ${materialRu}${colorText ? `, цвет ${colorText},` : ","} выглядит аккуратно, не перегружает интерьер и хорошо сочетается с заводской отделкой. Поверхность помогает снизить риск появления мелких царапин, потертостей и следов эксплуатации, а также делает салон визуально более ухоженным.`,
    `Изделие рассчитано на практичное применение: его удобно разместить, оно не требует сложного обслуживания и подходит для тех, кто хочет совместить защитную функцию с более аккуратной подачей автомобиля. Такой вариант особенно полезен для машин, которые регулярно используются в городе, в поездках и в семейном режиме.`,
    `Комплект можно использовать как для обновления внешнего вида, так и для дополнительной защиты зоны порога от ежедневного износа. ${selling} Благодаря продуманной форме аксессуар поддерживает общий стиль автомобиля и подходит для оптимизации карточки товара на Ozon, где важны понятный сценарий использования, конкретная выгода и естественное описание без переспама ключевыми словами.`
  ].join(" ");
  return countCopyWords(text) >= 150
    ? text
    : `${text} Такой формат описания помогает покупателю быстрее понять назначение товара, его практическую пользу, особенности установки и повседневный эффект от использования без лишнего повторения одинаковых ключевых слов.`;
}

function normalizeRussianDescription(value, job = {}) {
  const text = normalizeCopyForWrite(value).replace(/\s+/g, " ").trim();
  if (!text || containsChineseCopy(text)) return buildLongRussianDescription(job);
  const words = countCopyWords(text);
  if (!hasRussianCopy(text) || words < 150 || words > 250) return buildLongRussianDescription(job);
  return text;
}

function buildSourceAwareCopyContext(job = {}) {
  const sourceFacts = {
    sourceType: task.sourceType,
    sourceLabel: task.sourceLabel,
    sourceRichness: task.sourceType === "listing_record"
      ? "high"
      : task.sourceType === "collector_box"
        ? "medium_high"
        : task.sourceType === "selection"
          ? "medium"
          : "low",
    existingTitle: task.title,
    existingTags: task.productTags,
    existingSummary: task.summary,
    existingRichContent: task.richContent,
    productName: task.productName,
    categoryName: task.categoryName || task.productType,
    sellingPoints: task.sellingPoints,
    brand: task.brand,
    targetModel: job.targetModel || task.vehicleModel,
    material: task.material,
    color: task.color,
    quantity: task.quantity
  };
  const sourceRules = task.sourceType === "listing_record"
    ? [
      "Optimize the existing listing copy instead of rebuilding the product identity from category only.",
      "Preserve the original product focus from the imported listing title."
    ]
    : task.sourceType === "collector_box"
      ? [
        "Use the imported collector title and selling points as the primary source of truth.",
        "Do not drift from the imported product focus."
      ]
      : task.sourceType === "selection"
        ? [
          "Use the selection product name and selling points as the main source of truth.",
          "Keep the product noun consistent with the imported selection data."
        ]
        : [
          "Information may be incomplete; stay conservative and do not invent unsupported facts.",
          "If source details are sparse, keep the copy generic but still Russian-only."
        ];
  return { sourceFacts, sourceRules };
}

function buildTitleFallbacks(job = {}) {
  const modelText = normalizeRussianSafeText(job.targetModel || task.vehicleModel || task.brand, "автомобиля");
  const brandText = normalizeBrandForRussianCopy(task.brand);
  const materialRu = normalizeRussianSafeText(productMaterialRu(task.material), "прочный материал");
  const typeRu = normalizeRussianSafeText(productTypeRu(task.title || task.productType || task.productName), "автоаксессуар");
  return [
    `${typeRu} для ${brandText} ${modelText}, ${materialRu}, защита и стиль салона`,
    `${typeRu} ${brandText} ${modelText}, защитный аксессуар для автомобиля`
  ].map((item) => item.replace(/\s+/g, " ").trim()).filter((item) => item && !containsChineseCopy(item) && hasRussianCopy(item));
}

function normalizeRussianTitles(value, job = {}) {
  const incoming = Array.isArray(value) ? value : [value];
  const cleaned = uniqueCopyList(incoming
    .map((item) => normalizeCopyForWrite(item).replace(/\s+/g, " ").trim())
    .filter((item) => item && !containsChineseCopy(item) && hasRussianCopy(item) && titleMatchesProductFocus(item)));
  const pool = uniqueCopyList([...cleaned, ...buildTitleFallbacks(job)]).filter((item) => item && !containsChineseCopy(item) && hasRussianCopy(item));
  const clickTitle = [...pool].sort((a, b) => scoreClickTitleCandidate(b, job) - scoreClickTitleCandidate(a, job))[0];
  const searchTitle = [...pool]
    .sort((a, b) => scoreSearchTitleCandidate(b, job) - scoreSearchTitleCandidate(a, job))
    .find((item) => item !== clickTitle) || [...pool].sort((a, b) => scoreSearchTitleCandidate(b, job) - scoreSearchTitleCandidate(a, job))[0];
  return [clickTitle, searchTitle].filter(Boolean).slice(0, 2);
}

function validateCopyBundle(bundle = {}) {
  const errors = [];
  if (shouldWriteAsset("标题")) {
    const titles = normalizeRussianTitles(bundle.generatedTitles || [], bundle);
    if (titles.length < 2) errors.push("标题结果不足 2 条俄语候选");
    if (titles.some((item) => containsChineseCopy(item))) errors.push("标题包含中文");
  }
  if (shouldWriteAsset("标签")) {
    const tags = normalizeRussianTags(bundle.generatedTags || [], bundle);
    if (tags.length < 15) errors.push("标签少于 15 个");
    if (tags.some((item) => item.length >= 30)) errors.push("存在超过 30 个字符的标签");
    if (tags.some((item) => containsChineseCopy(item))) errors.push("标签包含中文");
  }
  if (shouldWriteAsset("描述")) {
    const description = normalizeRussianDescription(bundle.generatedDescription || "", bundle);
    const words = countCopyWords(description);
    if (containsChineseCopy(description)) errors.push("描述包含中文");
    if (words < 150 || words > 250) errors.push("描述词数不在 150-250 之间");
  }
  return errors;
}

function buildLocalRussianCopy(job) {
  const tags = buildFallbackRussianTags(job);
  return {
    titles: normalizeRussianTitles(buildTitleFallbacks(job), job),
    tags,
    description: normalizeRussianDescription(buildLongRussianDescription(job), job)
  };
}

function productMaterialRu(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("tpu")) return "TPU";
  if (text.includes("abs")) return "ABS";
  if (text.includes("不锈钢")) return "нержавеющая сталь";
  if (text.includes("皮") || text.includes("革")) return "искусственная кожа";
  if (text.includes("硅胶")) return "силикон";
  return value || "прочный материал";
}

function productTypeRu(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("钥匙") || text.includes("ключ")) return "чехол для ключа";
  if (text.includes("门槛")) return "накладка на порог";
  if (text.includes("保护壳")) return "защитный чехол";
  if (text.includes("垫")) return "защитная накладка";
  return "автоаксессуар";
}

async function fillCopyResults(job) {
  if (!isCopyJob(job) || !jobCopyOutputs(job).length) {
    normalizeCopyOutputs(job);
    return;
  }
  try {
    const sourceContext = buildSourceAwareCopyContext(job);
    const result = await generateAiCommerceCopy({
      productName: task.productName,
      categoryName: task.categoryName,
      brand: task.brand,
      targetModel: job.targetModel || task.vehicleModel,
      material: task.material,
      color: task.color,
      productType: task.productType,
      sellingPoints: task.sellingPoints,
      tags: task.productTags,
      title: task.title,
      summary: task.summary,
      richContent: task.richContent,
      optimizationTarget: selectedOptimizationTarget.value?.title,
      strategies: (job.strategyPlan || aiStrategyPlan.value).strategyTitles,
      language: "Russian",
      titleModes: ["high_click", "high_search"],
      rules: [
        "Return Russian only. Do not output Chinese characters.",
        "Preserve the imported product focus from the existing source title and product name.",
        "Generate exactly two Russian title candidates: one for click-through and one for search coverage.",
        "Tags must be at least 15 items, each shorter than 30 characters, deduplicated, and formatted with leading #.",
        "Description must be 150-250 Russian words and read like a natural Ozon product description."
      ],
      sourceContext
    });
    job.generatedTitles = normalizeRussianTitles(result.titles || result.title || [], job);
    job.generatedTags = normalizeRussianTags(result.tags || result.keywords || [], job);
    job.generatedDescription = normalizeRussianDescription(result.description || result.summary || "", job);
    if (validateCopyBundle(job).length || (!hasRussianCopy(job.generatedTitles) && !hasRussianCopy(job.generatedTags) && !hasRussianCopy(job.generatedDescription))) {
      const fallback = buildLocalRussianCopy(job);
      job.generatedTitles = fallback.titles;
      job.generatedTags = fallback.tags;
      job.generatedDescription = fallback.description;
    }
    normalizeCopyOutputs(job);
    if (job.generatedTitles.length || job.generatedTags.length || job.generatedDescription) return;
  } catch (error) {
    logs.value.unshift({
      time: new Date().toLocaleString(),
      status: "warning",
      message: `文案AI生成失败，已使用本地策略：${error.message || "未知错误"}`,
      model: "Commerce copy fallback"
    });
  }

  const fallback = buildLocalRussianCopy(job);
  job.generatedTitles = fallback.titles;
  job.generatedTags = fallback.tags;
  job.generatedDescription = fallback.description;
  normalizeCopyOutputs(job);
}

async function regenerateResult(item) {
  try {
    await generateOne(item);
    ElMessage.success("已重新生成");
  } catch (error) {
    ElMessage.error(error.message || "重新生成失败");
  }
}

function editPromptForItem(item) {
  previewContext.targetModel = item.targetModel || task.targets[0] || "";
  previewContext.strategyTitles = item.strategyTitles?.length ? [...item.strategyTitles] : [item.strategyTitle].filter(Boolean);
  previewContext.job = { ...item };
  promptEditorState.positivePrompt = item.finalPositivePrompt || finalPrompt.value;
  promptEditorState.negativePrompt = item.finalNegativePrompt || finalNegativePrompt.value;
  promptEditorState.variablesJson = JSON.stringify(buildVariables(item.targetModel || task.targets[0] || ""), null, 2);
  strategyDrawer.value = true;
}

async function pullPendingResult(item) {
  if (!item.pendingTaskId) return;
  item.status = "拉回中";
  try {
    const result = await pullAiImageTaskResult(item.pendingTaskId);
    const image = result.generatedImages?.[0] || result.croppedImages?.[0];
    if (!image?.url) throw new Error("任务已完成，但未返回可用图片");
    item.imageUrl = image.url;
    item.downloadUrl = image.url;
    if (!item.assetId) {
      const asset = await createMaterialAsset({
        asset_type: "image",
        role: item.type === "详情图" ? "detail_image" : "main_image",
        title: `${task.productName} ${item.targetModel || item.strategyTitle || "AI 图片"}`,
        url: item.imageUrl,
        thumbnail_url: item.imageUrl,
        source_type: "ai_generated",
        source_id: item.id,
        source_selection_id: task.sourceSelectionId,
        source_package_id: task.sourcePackageId,
        variant_task_id: task.sourceId,
        variant_result_id: item.id,
        target_brand: task.brand,
        target_model: item.targetModel,
        product_name: task.productName,
        style: `${selectedStyle.value.title} / ${item.strategyTitle || ""}`.trim(),
        ratio: task.ratio,
        prompt_template_id: selectedTemplateId.value,
        final_prompt: item.finalPositivePrompt,
        negative_prompt: item.finalNegativePrompt,
        provider: result.provider || "cctq-image2",
        model: result.model || "gpt-image-2",
        status: "pending_review",
        metadata: {
          recoveredTaskId: item.pendingTaskId,
          generationMode: result.generationMode || "image_to_image",
          recoveredAt: new Date().toISOString()
        }
      });
      item.assetId = asset.id;
      item.assetStatus = asset.status;
    }
    item.status = "已完成";
    item.progress = 100;
    item.errorMessage = "";
    item.pendingTaskId = "";
    ElMessage.success("已从后台任务拉回图片");
  } catch (error) {
    item.status = error?.code === "AI_TASK_STILL_RUNNING" ? "等待服务商" : "失败";
    item.errorMessage = error.message || "拉回图片失败";
    if (error?.code === "AI_TASK_STILL_RUNNING") ElMessage.info("服务商仍在生成，任务会继续保留，可稍后再次拉回");
    else ElMessage.error(item.errorMessage);
  }
}

function applyGeneratedTitle(value) {
  const next = normalizeCopyForWrite(value);
  if (!next || containsChineseCopy(next)) {
    ElMessage.warning("标题包含中文，暂不可回写");
    return;
  }
  task.title = next;
  ElMessage.success("已回写标题");
}

function applyGeneratedTags(tags = []) {
  const normalized = normalizeRussianTags(tags);
  if (normalized.length < 15) {
    ElMessage.warning("标签少于 15 个，暂不可回写");
    return;
  }
  task.productTags = normalized.join(", ");
  ElMessage.success("已回写标签");
}

function applyGeneratedDescription(value) {
  const next = normalizeRussianDescription(value);
  if (containsChineseCopy(next)) {
    ElMessage.warning("描述包含中文，暂不可回写");
    return;
  }
  const words = countCopyWords(next);
  if (words < 150 || words > 250) {
    ElMessage.warning("描述词数需在 150-250 之间");
    return;
  }
  task.summary = next;
  ElMessage.success("已回写描述");
}

function setAsMain(item) {
  results.value.forEach((row) => {
    row.isMain = row.id === item.id;
  });
  ElMessage.success("已设为主图");
}

async function writeBack(item, options = {}) {
  if (!sourceSubmitReady.value) {
    ElMessage.warning("请先导入来源");
    return;
  }
  const strategy = activeWritebackStrategy.value;
  if (!strategy?.ready) {
    ElMessage.warning(strategy?.actionLabel || "当前来源暂不支持提交");
    return;
  }
  const previewBundle = buildWriteBackBundle(item);
  const copyErrors = validateCopyBundle(previewBundle);
  if (copyErrors.length) {
    ElMessage.warning(`当前结果暂不可回写：${copyErrors[0]}`);
    return;
  }
  if (item.writeBackStatus === "已提交") {
    ElMessage.warning("该结果已提交过");
    return;
  }
  if (strategy.requiresConfirm && !options.skipConfirm) {
    const confirmDetail = typeof strategy.confirmDetail === "function"
      ? strategy.confirmDetail(previewBundle, writebackContext.value)
      : strategy.confirmDetail;
    await ElMessageBox.confirm(
      confirmDetail,
      strategy.confirmTitle || "提交结果",
      { type: "warning", confirmButtonText: `${strategy.confirmLabel || "确认"}并提交`, cancelButtonText: "取消" }
    );
  }
  item.writeBackStatus = "处理中";
  try {
    const bundle = buildWriteBackBundle(item);
    const created = await submitWriteBackBundle(bundle);
    item.createdSelectionId = created?.id || created?.product?.id || created?.selectionId || null;
    item.createdSelectionCode = created?.product?.selection_id || created?.selection_id || created?.selectionCode || "";
    if (item.assetId) {
      await updateMaterialAsset(item.assetId, {
        status: "used",
        usage_count: Number(item.usageCount || 0) + 1,
        metadata: {
          writeBackTarget: sourceSubmitMode.value,
          sourceSelectionId: task.sourceSelectionId,
          sourceCollectorSku: task.sourceCollectorSku,
          sourceListingRecordId: task.sourceListingRecordId,
          createdSelectionId: item.createdSelectionId,
          createdSelectionCode: item.createdSelectionCode,
          sourceResultIds: bundle.sourceResultIds,
          mainImageUrl: bundle.mainImageUrl,
          detailImageUrls: bundle.detailImageUrls,
          title: normalizeCopyForWrite(bundle.generatedTitles?.[0]),
          tags: (bundle.generatedTags || []).map(normalizeCopyForWrite).filter(Boolean),
          description: normalizeCopyForWrite(bundle.generatedDescription)
        }
      }).catch(() => null);
      item.assetStatus = "used";
    }
    ElMessage.success(created?.message || `已提交 ${item.createdSelectionCode || item.createdSelectionId || ""}`);
    markWriteBackGroupDone(item, created || {});
  } catch (error) {
    item.writeBackStatus = "待提交";
    ElMessage.error(error.message || "提交失败");
    throw error;
  }
}

async function loadSelectionTemplateRecord() {
  const detail = await apiClient.get(`/api/products/${encodeURIComponent(task.sourceSelectionId)}`, { noCache: true }).catch(() => ({}));
  return detail?.data || detail || {};
}

async function createDerivedSelectionRecord(item) {
  const current = await loadSelectionTemplateRecord();
  const payload = buildDerivedSelectionPayload(current, item);
  return await apiClient.post("/api/products", payload);
}

async function submitWriteBackBundle(bundle = {}) {
  const strategy = activeWritebackStrategy.value;
  if (!strategy?.ready) throw new Error(strategy?.actionLabel || "当前来源暂不支持提交");
  return await strategy.submit(bundle, writebackContext.value);
}

function buildTaskSelectionBasePayload() {
  return {
    name: task.productName || task.title,
    title: task.title || task.productName,
    ozon_category_name: task.categoryName || task.productType,
    category_name: task.categoryName || task.productType,
    product_type: task.productType || "selection",
    vehicle_brand: task.brand,
    vehicle_model: task.vehicleModel,
    material: task.material,
    color: task.color,
    purchase_quantity: task.quantity,
    selling_points: task.sellingPoints,
    product_tags: task.productTags,
    tags: task.productTags,
    summary: task.summary,
    rich_content: task.richContent,
    package_weight_g: task.packageWeightG,
    length_cm: task.lengthCm,
    width_cm: task.widthCm,
    height_cm: task.heightCm,
    logistics_rule_name: task.logisticsRuleName,
    source_platform: task.sourcePlatform,
    supplier_name: task.supplierName,
    purchase_url: task.purchaseUrl,
    purchase_cost: task.purchaseCost,
    domestic_shipping: task.domesticShipping,
    handling_fee: task.handlingFee,
    sale_price_rmb: task.salePrice,
    listing_price_rub: task.labelPrice || task.salePrice,
    exchange_rate: task.exchangeRate,
    supplier_note: task.supplierNote,
    image_url: task.sourceImageUrl
  };
}

function selectionAiSuggestionNote(bundle = {}) {
  const lines = [
    task.supplierNote || "",
    `AI优化时间：${new Date().toLocaleString()}`,
    bundle.generatedTitles?.[0] && shouldWriteAsset("标题") ? `AI建议标题：${normalizeCopyForWrite(bundle.generatedTitles[0])}` : "",
    bundle.generatedTags?.length && shouldWriteAsset("标签") ? `AI建议标签：${bundle.generatedTags.map(normalizeCopyForWrite).filter(Boolean).join(" / ")}` : "",
    bundle.generatedDescription && shouldWriteAsset("描述") ? `AI建议描述：${normalizeCopyForWrite(bundle.generatedDescription)}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function normalizedTextForCompare(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function resolvePayloadMainImage(payload = {}) {
  return String(
    payload.image_url
    || payload.imageUrl
    || payload.primary_image
    || payload.primaryImage
    || ""
  ).trim();
}

function resolvePayloadDescription(payload = {}) {
  return normalizedTextForCompare(
    payload.summary
    || payload.description
    || payload.selling_points
    || payload.sellingPoints
    || ""
  );
}

function shouldRebuildRichContent(payload = {}, bundle = {}) {
  const nextMainImage = bundle.mainImageUrl && shouldWriteAsset("主图")
    ? String(bundle.mainImageUrl).trim()
    : "";
  const nextDescription = bundle.generatedDescription && shouldWriteAsset("描述")
    ? normalizeCopyForWrite(bundle.generatedDescription)
    : "";
  const currentDetailImages = normalizeImageList(payload.detail_image_urls || payload.images);
  const nextDetailImages = bundle.detailImageUrls?.length && shouldWriteAsset("详情图")
    ? bundle.detailImageUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const mainImageChanged = Boolean(nextMainImage) && nextMainImage !== resolvePayloadMainImage(payload);
  const descriptionChanged = Boolean(nextDescription) && normalizedTextForCompare(nextDescription) !== resolvePayloadDescription(payload);
  const detailImagesChanged = Boolean(nextDetailImages.length) && (
    nextDetailImages.length !== currentDetailImages.length
    || nextDetailImages.some((item, index) => item !== currentDetailImages[index])
  );
  return mainImageChanged || descriptionChanged || detailImagesChanged;
}

function buildRichContentParagraphs(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const lines = raw
    .split(/\n+|[；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (lines.length > 1) return lines.slice(0, 4);
  return raw
    .split(/[。.!！?？]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function bundleMaySyncRichContent(bundle = {}) {
  return Boolean(
    (bundle.mainImageUrl && shouldWriteAsset("主图"))
    || (bundle.detailImageUrls?.length && shouldWriteAsset("详情图"))
    || (bundle.generatedDescription && shouldWriteAsset("描述"))
  );
}

function buildRichContentTemplate(payload = {}, bundle = {}) {
  const title = normalizeCopyForWrite(bundle.generatedTitles?.[0]) || payload.title || task.title || task.productName || "";
  const description = normalizeCopyForWrite(bundle.generatedDescription) || payload.summary || payload.description || task.summary || task.sellingPoints || "";
  const mainImageUrl = bundle.mainImageUrl || resolvePayloadMainImage(payload) || task.sourceImageUrl || "";
  const detailImages = bundle.detailImageUrls?.length
    ? bundle.detailImageUrls
    : normalizeImageList(payload.detail_image_urls || payload.images);
  const tags = (bundle.generatedTags?.length ? bundle.generatedTags : String(payload.tags || payload.product_tags || task.productTags || "").split(/[\n,，]+/))
    .map(normalizeCopyForWrite)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
  const summaryItems = buildRichContentParagraphs(description)
    .map((content) => ({ type: "text", content }));
  const rich = {
    content: [
      {
        widgetName: "raShowcase",
        type: "billboard",
        blocks: [
          {
            imgLink: "",
            img: {
              src: mainImageUrl,
              srcMobile: mainImageUrl,
              alt: title,
              position: "width_full",
              positionMobile: "width_full",
              widthMobile: 1024,
              heightMobile: 1536
            },
            title: {
              items: title ? [{ type: "text", content: title }] : [],
              size: "size4",
              align: "left",
              color: "color1"
            },
            text: {
              size: "size2",
              align: "left",
              color: "color1",
              items: summaryItems.length ? summaryItems : [{ type: "text", content: description }]
            }
          }
        ]
      },
      ...(detailImages.length ? [{
        widgetName: "raShowcase",
        type: "tile",
        blocks: detailImages.slice(0, 8).map((url, index) => ({
          imgLink: "",
          img: {
            src: url,
            srcMobile: url,
            alt: `${title || task.productName || "商品"} ${index + 1}`,
            position: "width_full",
            positionMobile: "width_full",
            widthMobile: 1024,
            heightMobile: 1024
          },
          title: {
            items: [{ type: "text", content: `细节展示 ${index + 1}` }],
            size: "size3",
            align: "left",
            color: "color1"
          },
          text: {
            size: "size2",
            align: "left",
            color: "color2",
            items: [{ type: "text", content: description || (tags[index] || "") }]
          }
        }))
      }] : [])
    ],
    version: 0.3,
    metadata: {
      template: "ai_rich_content_v2",
      tags
    }
  };
  return JSON.stringify(rich, null, 2);
}

function applyBundleToSelectionPayload(payload = {}, bundle = {}) {
  return applyBundleToSelectionPayloadByMode(payload, bundle, { mode: "safe" });
}

function applyBundleToSelectionPayloadByMode(payload = {}, bundle = {}, options = {}) {
  const mode = options.mode === "force" ? "force" : "safe";
  const generatedTitle = bundle.generatedTitles?.[0] ? normalizeCopyForWrite(bundle.generatedTitles[0]) : "";
  const generatedTags = (bundle.generatedTags || []).map(normalizeCopyForWrite).filter(Boolean);
  const generatedDescription = bundle.generatedDescription ? normalizeCopyForWrite(bundle.generatedDescription) : "";
  const next = { ...payload };
  if (bundle.mainImageUrl && shouldWriteAsset("主图")) next.image_url = bundle.mainImageUrl;
  if (bundle.detailImageUrls?.length && shouldWriteAsset("详情图")) {
    next.detail_image_urls = bundle.detailImageUrls.reduce(
      (list, url) => appendUnique(list, url),
      normalizeImageList(payload.detail_image_urls)
    );
  }
  if (generatedTitle && shouldWriteAsset("标题")) next.generated_title = generatedTitle;
  if (generatedTags.length && shouldWriteAsset("标签")) next.generated_tags = generatedTags;
  if (generatedDescription && shouldWriteAsset("描述")) next.generated_description = generatedDescription;
  next.supplier_note = selectionAiSuggestionNote(bundle);
  if (mode === "force") {
    if (generatedTitle && shouldWriteAsset("标题")) {
      next.name = generatedTitle;
      next.title = generatedTitle;
    }
    if (generatedTags.length && shouldWriteAsset("标签")) {
      const joinedTags = generatedTags.join(", ");
      next.tags = joinedTags;
      next.product_tags = joinedTags;
    }
    if (generatedDescription && shouldWriteAsset("描述")) {
      next.selling_points = generatedDescription;
      next.summary = generatedDescription;
      next.description = generatedDescription;
    }
  }
  if (shouldRebuildRichContent(payload, bundle)) {
    next.rich_content = buildRichContentTemplate(next, bundle);
  }
  if (bundle.targetModel) next.vehicle_model = bundle.targetModel;
  return next;
}

async function overwriteSelectionSource(bundle = {}) {
  return await safeOverwriteSelectionSource(bundle);
}

async function safeOverwriteSelectionSource(bundle = {}) {
  if (!task.sourceSelectionId) throw new Error("缺少选品池商品 ID");
  const current = await loadSelectionTemplateRecord();
  const payload = applyBundleToSelectionPayloadByMode({
    ...current,
    ...buildTaskSelectionBasePayload()
  }, bundle, { mode: "safe" });
  await apiClient.put(`/api/products/${encodeURIComponent(task.sourceSelectionId)}`, payload);
  return await apiClient.get(`/api/products/${encodeURIComponent(task.sourceSelectionId)}`, { noCache: true }).catch(() => ({ id: task.sourceSelectionId }));
}

async function forceOverwriteSelectionSource(bundle = {}) {
  if (!task.sourceSelectionId) throw new Error("缺少选品池商品 ID");
  const current = await loadSelectionTemplateRecord();
  const payload = applyBundleToSelectionPayloadByMode({
    ...current,
    ...buildTaskSelectionBasePayload()
  }, bundle, { mode: "force" });
  await apiClient.put(`/api/products/${encodeURIComponent(task.sourceSelectionId)}`, payload);
  return await apiClient.get(`/api/products/${encodeURIComponent(task.sourceSelectionId)}`, { noCache: true }).catch(() => ({ id: task.sourceSelectionId }));
}

function buildTaskEditPayload() {
  return {
    internal_product_name: task.productName,
    title: task.title || task.productName,
    category_name: task.categoryName || task.productType,
    product_type: task.productType,
    brand: task.brand,
    model: task.vehicleModel,
    material: task.material,
    color: task.color,
    quantity: task.quantity,
    purchase_quantity: task.quantity,
    weight_g: task.packageWeightG,
    package_weight_g: task.packageWeightG,
    length_cm: task.lengthCm,
    width_cm: task.widthCm,
    height_cm: task.heightCm,
    selling_points: task.sellingPoints,
    tags: task.productTags,
    summary: task.summary,
    description: task.summary || task.sellingPoints,
    rich_content: task.richContent,
    source_platform: task.sourcePlatform,
    supplier_name: task.supplierName,
    purchase_url: task.purchaseUrl,
    purchase_cost: task.purchaseCost,
    domestic_shipping: task.domesticShipping,
    handling_fee: task.handlingFee,
    price: task.salePrice,
    old_price: task.labelPrice,
    exchange_rate: task.exchangeRate,
    operation_note: task.supplierNote,
    image_url: task.sourceImageUrl
  };
}

function applyBundleToEditPayload(payload = {}, bundle = {}) {
  const next = { ...payload };
  const generatedTitle = bundle.generatedTitles?.[0] ? normalizeCopyForWrite(bundle.generatedTitles[0]) : "";
  const generatedTags = (bundle.generatedTags || []).map(normalizeCopyForWrite).filter(Boolean);
  const generatedDescription = bundle.generatedDescription ? normalizeCopyForWrite(bundle.generatedDescription) : "";
  if (bundle.mainImageUrl && shouldWriteAsset("主图")) next.image_url = bundle.mainImageUrl;
  if (bundle.detailImageUrls?.length && shouldWriteAsset("详情图")) next.detail_image_urls = bundle.detailImageUrls;
  if (generatedTitle && shouldWriteAsset("标题")) next.title = generatedTitle;
  if (generatedTags.length && shouldWriteAsset("标签")) next.tags = generatedTags;
  if (generatedDescription && shouldWriteAsset("描述")) {
    next.summary = generatedDescription;
    next.description = generatedDescription;
    next.selling_points = generatedDescription;
  }
  if (shouldRebuildRichContent(payload, bundle)) {
    next.rich_content = buildRichContentTemplate(next, bundle);
  }
  if (bundle.targetModel) next.model = bundle.targetModel;
  return next;
}

async function overwriteCollectorSource(bundle = {}) {
  if (!task.sourceCollectorSku) throw new Error("缺少采集箱 SKU");
  const editPayload = applyBundleToEditPayload(buildTaskEditPayload(), bundle);
  return await apiClient.put(`/api/listing/collector-box/${encodeURIComponent(task.sourceCollectorSku)}/edit`, {
    editPayload
  });
}

function applyBundleToListingRecordPayload(payload = {}, bundle = {}) {
  const next = JSON.parse(JSON.stringify(payload || {}));
  if (!Array.isArray(next.items) || !next.items[0]) next.items = [{}];
  const item = next.items[0];
  const generatedTitle = bundle.generatedTitles?.[0] ? normalizeCopyForWrite(bundle.generatedTitles[0]) : "";
  const generatedTags = (bundle.generatedTags || []).map(normalizeCopyForWrite).filter(Boolean);
  const generatedDescription = bundle.generatedDescription ? normalizeCopyForWrite(bundle.generatedDescription) : "";
  const shouldWriteTags = generatedTags.length && shouldWriteAsset("标签");
  const shouldWriteDescription = generatedDescription && shouldWriteAsset("描述");
  item.name = generatedTitle && shouldWriteAsset("标题") ? generatedTitle : (task.title || task.productName || item.name || "");
  if (bundle.mainImageUrl && shouldWriteAsset("主图")) item.primary_image = bundle.mainImageUrl;
  if (bundle.detailImageUrls?.length && shouldWriteAsset("详情图")) {
    item.images = bundle.detailImageUrls.reduce((list, url) => appendUnique(list, url), normalizeImageList(item.images));
  }
  if (shouldWriteDescription) item.description = generatedDescription;
  if (shouldWriteTags) item.tags = generatedTags;
  if (shouldRebuildRichContent(item, bundle)) {
    const richContent = buildRichContentTemplate(item, bundle);
    item.rich_content = richContent;
    item.rich_content_json = JSON.stringify(richContent);
  }
  syncListingRecordFreeTextAttributes(item, {
    tags: shouldWriteTags ? generatedTags : null,
    description: shouldWriteDescription ? generatedDescription : null,
    richContentJson: item.rich_content_json || ""
  });
  item.weight = Number(task.packageWeightG || item.weight || 0);
  item.depth = Number(task.lengthCm || 0) ? Number(task.lengthCm) * 10 : item.depth;
  item.width = Number(task.widthCm || 0) ? Number(task.widthCm) * 10 : item.width;
  item.height = Number(task.heightCm || 0) ? Number(task.heightCm) * 10 : item.height;
  if (bundle.targetModel) item.model = bundle.targetModel;
  return next;
}

function syncListingRecordFreeTextAttributes(item = {}, fields = {}) {
  if (fields.tags?.length) {
    upsertListingRecordTextAttribute(item, 23171, "产品标签", fields.tags);
  }
  if (fields.description) {
    upsertListingRecordTextAttribute(item, 4191, "简介", [fields.description]);
  }
  if (fields.richContentJson) {
    upsertListingRecordTextAttribute(item, 11254, "JSON富内容", [fields.richContentJson]);
    upsertListingRecordRichComplexAttribute(item, fields.richContentJson);
  }
}

function upsertListingRecordTextAttribute(item = {}, id, name, values = []) {
  item.attributes = Array.isArray(item.attributes) ? item.attributes : [];
  const normalizedValues = normalizeImageList(values).map((value) => ({ value }));
  if (!normalizedValues.length) return;
  const existing = item.attributes.find((attr) => Number(attr.id || attr.attribute_id || 0) === Number(id));
  const next = {
    ...(existing || {}),
    id,
    attribute_id: id,
    name,
    values: normalizedValues
  };
  if (existing) Object.assign(existing, next);
  else item.attributes.push(next);
}

function upsertListingRecordRichComplexAttribute(item = {}, richContentJson = "") {
  const text = String(richContentJson || "").trim();
  if (!text) return;
  const groups = Array.isArray(item.complex_attributes) ? item.complex_attributes : [];
  const filtered = groups.filter((group) => {
    const attrs = Array.isArray(group?.attributes) ? group.attributes : [];
    return !attrs.some((attr) => Number(attr.id || attr.attribute_id || 0) === 11254 || String(attr.id || "").toLowerCase() === "rich_content_json");
  });
  filtered.push({
    attributes: [{ id: "rich_content_json", values: [{ value: text }] }]
  });
  item.complex_attributes = filtered;
}

async function overwriteListingRecordSource(bundle = {}) {
  if (!task.sourceListingRecordId) throw new Error("缺少上架记录 ID");
  const detail = await apiClient.get(`/api/listing/publish-records/${encodeURIComponent(task.sourceListingRecordId)}`, { noCache: true });
  const payload = applyBundleToListingRecordPayload(detail.request || {}, bundle);
  return await apiClient.post(`/api/listing/publish-records/${encodeURIComponent(task.sourceListingRecordId)}/retry`, {
    payload,
    updated_at: detail.updated_at || ""
  });
}

function buildDerivedSelectionPayload(current = {}, item = {}) {
  const generatedTitle = item.generatedTitles?.[0] ? normalizeCopyForWrite(item.generatedTitles[0]) : "";
  const generatedTags = (item.generatedTags || []).map(normalizeCopyForWrite).filter(Boolean);
  const generatedDescription = item.generatedDescription ? normalizeCopyForWrite(item.generatedDescription) : "";
  const sourceNotes = [
    current.supplier_note,
    `AI派生自选品 ${current.selection_id || task.sourceSelectionId}`,
    item.strategyTitle ? `AI策略：${item.strategyTitle}` : "",
    item.targetModel ? `裂变变量：${item.targetModel}` : "",
    generatedTags.length && shouldWriteAsset("标签") ? `AI标签：${generatedTags.join(" / ")}` : "",
    generatedDescription && shouldWriteAsset("描述") ? `AI描述：${generatedDescription}` : ""
  ].filter(Boolean).join("；");
  const payload = {
    ...current,
    id: undefined,
    selection_id: undefined,
    code: undefined,
    active: undefined,
    product_type: "selection",
    selection_status: "draft",
    source_selection_id: Number(task.sourceSelectionId),
    variant_task_id: task.sourceId || item.id,
    variant_result_id: item.id,
    variant_type: task.optimizationTarget || task.variantMode,
    is_variant_generated: 1,
    material_asset_status: "generated",
    supplier_note: sourceNotes
  };

  if (item.mainImageUrl && shouldWriteAsset("主图")) {
    payload.image_url = item.mainImageUrl;
  }
  if (item.detailImageUrls?.length && shouldWriteAsset("详情图")) {
    payload.detail_image_urls = item.detailImageUrls.reduce(
      (list, url) => appendUnique(list, url),
      normalizeImageList(current.detail_image_urls)
    );
  }
  if (generatedTitle && shouldWriteAsset("标题")) {
    payload.name = generatedTitle;
    payload.title = generatedTitle;
    payload.generated_title = generatedTitle;
  }
  if (generatedTags.length && shouldWriteAsset("标签")) {
    payload.tags = generatedTags.join(", ");
    payload.product_tags = generatedTags.join(", ");
    payload.generated_tags = generatedTags;
  }
  if (generatedDescription && shouldWriteAsset("描述")) {
    payload.selling_points = generatedDescription;
    payload.summary = generatedDescription;
    payload.description = generatedDescription;
    payload.generated_description = generatedDescription;
  }
  if (shouldRebuildRichContent(current, item)) {
    payload.rich_content = buildRichContentTemplate(payload, item);
  }
  if (item.targetModel) payload.vehicle_model = item.targetModel;

  return payload;
}

function shouldWriteAsset(label) {
  return task.outputs.includes(label);
}

function resultHasWritableContent(item = {}) {
  return Boolean(
    (item.type === "主图" && item.imageUrl)
    || (item.type === "详情图" && item.imageUrl)
    || item.generatedTitles?.length
    || item.generatedTags?.length
    || item.generatedDescription
  );
}

function buildWriteBackBundle(seed = {}) {
  const groupKey = seed.writeBackGroupKey || seed.id;
  const siblings = displayResults.value.filter((item) => (
    item.writeBackGroupKey === groupKey
    && item.status === "已完成"
    && resultHasWritableContent(item)
  ));
  const bundle = {
    ...seed,
    id: groupKey,
    sourceResultIds: siblings.map((item) => item.id),
    mainImageUrl: "",
    detailImageUrls: [],
    generatedTitles: [],
    generatedTags: [],
    generatedDescription: ""
  };
  siblings.forEach((item) => {
    if (item.type === "主图" && item.imageUrl && !bundle.mainImageUrl) bundle.mainImageUrl = item.imageUrl;
    if (item.type === "详情图" && item.imageUrl) bundle.detailImageUrls = appendUnique(bundle.detailImageUrls, item.imageUrl);
    if (!bundle.generatedTitles.length && item.generatedTitles?.length) bundle.generatedTitles = item.generatedTitles;
    if (!bundle.generatedTags.length && item.generatedTags?.length) bundle.generatedTags = item.generatedTags;
    if (!bundle.generatedDescription && item.generatedDescription) bundle.generatedDescription = item.generatedDescription;
  });
  if (!bundle.mainImageUrl && seed.type === "主图" && seed.imageUrl) bundle.mainImageUrl = seed.imageUrl;
  if (!bundle.detailImageUrls.length && seed.type === "详情图" && seed.imageUrl) bundle.detailImageUrls = [seed.imageUrl];
  if (!bundle.generatedTitles.length && seed.generatedTitles?.length) bundle.generatedTitles = seed.generatedTitles;
  if (!bundle.generatedTags.length && seed.generatedTags?.length) bundle.generatedTags = seed.generatedTags;
  if (!bundle.generatedDescription && seed.generatedDescription) bundle.generatedDescription = seed.generatedDescription;
  return bundle;
}

function mergeWriteBackBundles(items = []) {
  const bundles = items.map((item) => buildWriteBackBundle(item));
  return bundles.reduce((merged, bundle) => ({
    ...merged,
    id: merged.id || `merged-${Date.now()}`,
    sourceResultIds: [...new Set([...(merged.sourceResultIds || []), ...(bundle.sourceResultIds || [])])],
    mainImageUrl: merged.mainImageUrl || bundle.mainImageUrl || "",
    detailImageUrls: [...new Set([...(merged.detailImageUrls || []), ...(bundle.detailImageUrls || [])])],
    generatedTitles: merged.generatedTitles?.length ? merged.generatedTitles : bundle.generatedTitles,
    generatedTags: merged.generatedTags?.length ? merged.generatedTags : bundle.generatedTags,
    generatedDescription: merged.generatedDescription || bundle.generatedDescription || "",
    targetModel: merged.targetModel || bundle.targetModel || ""
  }), {
    id: "",
    sourceResultIds: [],
    mainImageUrl: "",
    detailImageUrls: [],
    generatedTitles: [],
    generatedTags: [],
    generatedDescription: "",
    targetModel: ""
  });
}

function normalizeImageList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {
      // The selection editor also accepts manually pasted URL lists.
    }
    return trimmed.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function appendUnique(list, value) {
  return list.includes(value) ? list : [...list, value];
}

function markWriteBackGroupDone(item = {}, created = {}) {
  const groupKey = item.writeBackGroupKey || item.id;
  displayResults.value.forEach((row) => {
    if ((row.writeBackGroupKey || row.id) !== groupKey) return;
    row.writeBackStatus = "已提交";
    row.createdSelectionId = created.id || created.product?.id || null;
    row.createdSelectionCode = created.product?.selection_id || created.selection_id || "";
  });
}

  const writable = Array.from(
    new Map(displayResults.value
      .filter((item) => item.status === "已完成" && item.writeBackStatus !== "已提交" && resultHasWritableContent(item))
      .map((item) => [item.writeBackGroupKey || item.id, item])).values()
  );
async function batchWriteBack() {
  if (!sourceSubmitReady.value) {
    ElMessage.warning("请先导入来源");
    return;
  }
  const strategy = activeWritebackStrategy.value;
  if (!strategy?.ready) {
    ElMessage.warning(strategy?.actionLabel || "当前来源暂不支持提交");
    return;
  }
  const writable = Array.from(
    new Map(displayResults.value
      .filter((item) => item.status === "已完成" && item.writeBackStatus !== "已提交" && resultHasWritableContent(item))
      .map((item) => [item.writeBackGroupKey || item.id, item])).values()
  );
  if (!writable.length) {
    ElMessage.warning("没有可提交的结果");
    return;
  }
  const confirmMessage = String(strategy.batchLabel || "将提交当前结果。").replace("{count}", String(writable.length));
  const mergedBundlePreview = mergeWriteBackBundles(writable);
  const copyErrors = validateCopyBundle(mergedBundlePreview);
  if (copyErrors.length) {
    ElMessage.warning(`当前结果暂不可回写：${copyErrors[0]}`);
    return;
  }
  const confirmDetail = strategy.requiresConfirm
    ? (typeof strategy.confirmDetail === "function" ? strategy.confirmDetail(mergedBundlePreview, writebackContext.value) : strategy.confirmDetail)
    : (
      bundleMaySyncRichContent(mergedBundlePreview)
        ? `${confirmMessage} 如首图、详情图或描述发生变化，将同步更新富文本。`
        : confirmMessage
    );
  await ElMessageBox.confirm(confirmDetail, "提交结果", {
    type: "warning",
    confirmButtonText: strategy.confirmLabel || (sourceSubmitMode.value === "new_selection" ? "生成" : "更新"),
    cancelButtonText: "取消"
  });
  if (sourceSubmitMode.value !== "new_selection") {
    writable.forEach((item) => { item.writeBackStatus = "处理中"; });
    try {
      const result = await submitWriteBackBundle(mergeWriteBackBundles(writable));
      writable.forEach((item) => markWriteBackGroupDone(item, result || {}));
      ElMessage.success(result?.message || "已更新");
    } catch (error) {
      writable.forEach((item) => { item.writeBackStatus = "待提交"; });
      ElMessage.error(error.message || "提交失败");
    }
    return;
  }
  const settled = await runWriteBackQueue(writable, WRITEBACK_CONCURRENCY);
  const failedCount = settled.filter((item) => item.status === "rejected").length;
  if (failedCount) ElMessage.warning(`已提交 ${writable.length - failedCount} 组，${failedCount} 组失败，可单独重试`);
  else ElMessage.success(`已提交 ${writable.length} 组结果`);
}

async function runWriteBackQueue(items = [], concurrency = WRITEBACK_CONCURRENCY) {
  const settled = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        await writeBack(items[index], { skipConfirm: true });
        settled[index] = { status: "fulfilled" };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return settled;
}

function saveDraft(options = {}) {
  localStorage.setItem(workbenchDraftStorageKey.value, JSON.stringify(createWorkbenchDraftSnapshot()));
  if (!options.silent) ElMessage.success("草稿已保存");
}

function createResultShell(queueItem = {}) {
  const targetModel = typeof queueItem === "string" ? queueItem : queueItem.targetModel || "";
  const strategyTitle = typeof queueItem === "string"
    ? selectedStrategyTitles.value[0] || selectedStyle.value.title
    : queueItem.strategyTitle || selectedStrategyTitles.value[0] || selectedStyle.value.title;
  const type = queueItem.type || (task.outputs.includes("主图") ? "主图" : task.outputs.includes("详情图") ? "详情图" : "文案");
  return {
    id: `result-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    targetModel,
    type,
    detailType: queueItem.detailType || "",
    assetKind: queueItem.assetKind || (["主图", "详情图"].includes(type) ? "image" : "copy"),
    copyOutputs: queueItem.copyOutputs || [],
    writeBackGroupKey: queueItem.writeBackGroupKey || [targetModel || "base", strategyTitle || "default"].join("::"),
    optimizationTitle: selectedOptimizationTarget.value?.title || "",
    strategyTitle,
    strategyTitles: [strategyTitle].filter(Boolean),
    ratio: task.ratio,
    status: "待生成",
    progress: 0,
    imageUrl: "",
    downloadUrl: "",
    generatedTitles: [],
    generatedTags: [],
    generatedDescription: "",
    assetId: null,
    assetStatus: "pending_review",
    writeBackStatus: "待提交",
    createdAt: new Date().toLocaleString(),
    isMain: false,
    errorMessage: "",
    pendingTaskId: "",
    finalPositivePrompt: "",
    finalNegativePrompt: ""
  };
}

function openTemplateCenter() {
  templateCenterVisible.value = true;
  if (!templateForm.id && templates.value[0]) selectTemplateForEdit(templates.value[0]);
}

async function openStrategyLibrary() {
  strategyLibraryVisible.value = true;
  strategyEditorMode.value = task.optimizationTarget?.startsWith("multi_") ? "variant" : "optimization";
  strategyEditorGoalKey.value = task.optimizationTarget || "low_ctr";
  strategyEditorPlanTitle.value = selectedStrategyTitles.value[0] || "";
  await Promise.all([loadStrategyLibrary(), loadStrategyLayerRules()]);
  if (!strategyForm.id && strategyLibraryRows.value[0]) selectStrategyForEdit(strategyLibraryRows.value[0]);
}

async function loadSourceListingRecords() {
  sourceLoading.value = true;
  try {
    const pager = sourceFilters.listing_records;
    const params = new URLSearchParams({
      paged: "1",
      page: String(pager.page),
      pageSize: String(pager.pageSize),
      includePayload: "0"
    });
    if (pager.keyword.trim()) params.set("query", pager.keyword.trim());
    const result = await apiClient.get(`/api/listing/publish-records?${params.toString()}`, { noCache: true });
    sourceListingRecords.value = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
    sourceFilters.listing_records.total = Number(result?.total ?? sourceListingRecords.value.length);
    sourceFilters.listing_records.page = Number(result?.page || pager.page);
    sourceFilters.listing_records.pageSize = Number(result?.pageSize || pager.pageSize);
    sourceListingRecordsLoaded.value = true;
  } catch (error) {
    ElMessage.error(error.message || "上架记录加载失败");
  } finally {
    sourceLoading.value = false;
  }
}

function selectEditorGoal(item = {}) {
  strategyEditorGoalKey.value = item.key || "low_ctr";
  strategyEditorMode.value = strategyEditorGoalKey.value.startsWith("multi_") ? "variant" : "optimization";
  strategyEditorPlanTitle.value = "";
}

function selectEditorPlan(title) {
  strategyEditorPlanTitle.value = title || "";
}

async function deleteSelectedTree() {
  ElMessage.info("默认策略树不可删除，可以通过编辑覆盖当前类目的策略树内容。");
}

async function deleteSelectedGoal() {
  const goal = editorSelectedGoal.value;
  if (!goal?.custom) {
    ElMessage.info("内置 GOAL 不可删除，可以通过编辑覆盖当前类目的 GOAL 内容。");
    return;
  }
  await ElMessageBox.confirm(`确认删除自定义 GOAL「${goal.title}」？关联的 PLAN 绑定也会一起移除。`, "删除 GOAL", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  const rule = await ensureCurrentCategoryLayerRule();
  const metadata = { ...(rule.metadata || {}) };
  const goalMap = { ...(rule.goal_strategy_map || {}) };
  metadata.customGoals = (Array.isArray(metadata.customGoals) ? metadata.customGoals : []).filter((item) => item.key !== goal.key);
  delete goalMap[goal.key];
  await saveLayerRulePatch(rule, { metadata, goal_strategy_map: goalMap });
  const fallback = flatOptimizationTargets.value.find((item) => (item.key || "").startsWith(strategyEditorMode.value === "variant" ? "multi_" : ""))
    || flatOptimizationTargets.value[0];
  strategyEditorGoalKey.value = fallback?.key || "low_ctr";
  strategyEditorPlanTitle.value = "";
  ElMessage.success("已删除自定义 GOAL");
}

async function deleteSelectedPlan() {
  const plan = editorSelectedPlan.value;
  if (!plan?.custom || !plan?.strategyKey) {
    ElMessage.info("内置 PLAN 不可删除，可以通过编辑覆盖当前类目的 PLAN 内容。");
    return;
  }
  await ElMessageBox.confirm(`确认从当前 GOAL 移除 PLAN「${plan.title}」？`, "删除 PLAN", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  const rule = await ensureCurrentCategoryLayerRule();
  const metadata = { ...(rule.metadata || {}) };
  const goalMap = { ...(rule.goal_strategy_map || {}) };
  const currentKeys = Array.isArray(goalMap[strategyEditorGoalKey.value]) ? goalMap[strategyEditorGoalKey.value] : [];
  goalMap[strategyEditorGoalKey.value] = currentKeys.filter((key) => key !== plan.strategyKey);
  const strategy = strategyLibraryRows.value.find((item) => item.strategy_key === plan.strategyKey);
  if (strategy?.id && strategy.metadata?.custom) {
    await deleteAiStrategy(strategy.id);
  }
  await saveLayerRulePatch(rule, { metadata, goal_strategy_map: goalMap });
  await loadStrategyLibrary();
  strategyEditorPlanTitle.value = "";
  ElMessage.success("已移除当前 PLAN");
}

async function loadStrategyLibrary() {
  strategyLibraryLoading.value = true;
  try {
    strategyLibraryRows.value = await listAiStrategies({ enabled: "" });
  } catch (error) {
    ElMessage.error(error.message || "策略库加载失败");
  } finally {
    strategyLibraryLoading.value = false;
  }
}

async function loadStrategyLayerRules() {
  try {
    strategyLayerRules.value = await listAiStrategyLayerRules({ enabled: "" });
  } catch (error) {
    ElMessage.error(error.message || "类目策略树加载失败");
  }
}

function findLayerRuleForCategory(categoryName) {
  const category = normalizeKey(categoryName);
  if (!category) return null;
  return strategyLayerRules.value.find((item) => {
    if (item.scope !== "category") return false;
    const aliases = [item.title, ...(item.aliases || [])].map(normalizeKey);
    return aliases.some((alias) => alias && (category.includes(alias) || alias.includes(category)));
  }) || null;
}

function currentCategoryName() {
  return importedCategoryName.value || categoryStrategyRule.value.category || "通用类目";
}

function buildLayerRulePayload(rule = {}, patch = {}) {
  const baseRule = rule || {};
  const category = currentCategoryName();
  const aliases = uniquePromptLines([
    ...(baseRule.aliases || []),
    category,
    categoryStrategyRule.value.category
  ]);
  return {
    scope: patch.scope || baseRule.scope || "category",
    rule_key: patch.rule_key || baseRule.rule_key || `category-${slugify(category)}`,
    title: patch.title || baseRule.title || `${category}类目树`,
    aliases,
    goal_strategy_map: patch.goal_strategy_map || baseRule.goal_strategy_map || {},
    sort_order: patch.sort_order ?? baseRule.sort_order ?? 0,
    enabled: patch.enabled ?? baseRule.enabled ?? 1,
    metadata: patch.metadata || baseRule.metadata || {}
  };
}

async function ensureCurrentCategoryLayerRule() {
  await loadStrategyLayerRules();
  const category = currentCategoryName();
  const existing = findLayerRuleForCategory(category);
  if (existing && existing.rule_key !== "global-default") return existing;
  const created = await createAiStrategyLayerRule(buildLayerRulePayload(null, {
    title: `${category}类目树`,
    metadata: {
      createdFrom: "goal-plan-editor",
      category
    }
  }));
  await loadStrategyLayerRules();
  return created;
}

async function saveLayerRulePatch(rule, patch = {}) {
  const payload = buildLayerRulePayload(rule, patch);
  const saved = rule?.id
    ? await updateAiStrategyLayerRule(rule.id, payload)
    : await createAiStrategyLayerRule(payload);
  await loadStrategyLayerRules();
  return saved;
}

function resetStrategyNodeForm(type = "plan") {
  Object.assign(strategyNodeForm, {
    strategyId: null,
    type,
    title: "",
    key: "",
    text: "",
    positivePrompt: "",
    negativePrompt: ""
  });
}

async function openStrategyNodeDialog(type = "plan", item = null) {
  strategyLibraryVisible.value = true;
  await Promise.all([loadStrategyLibrary(), loadStrategyLayerRules()]);
  resetStrategyNodeForm(type);
  strategyNodeMode.value = type;
  strategyNodeForm.type = type;

  if (type === "tree") {
    const rule = findLayerRuleForCategory(currentCategoryName()) || currentLayerRule.value;
    const metadata = rule?.metadata || {};
    Object.assign(strategyNodeForm, {
      title: rule?.title || `${currentCategoryName()}类目树`,
      key: rule?.rule_key || `category-${slugify(currentCategoryName())}`,
      positivePrompt: metadata.categoryPrompt || defaultTreePositivePrompt(rule || {}),
      negativePrompt: metadata.negativePrompt || defaultTreeNegativePrompt()
    });
  } else if (type === "goal") {
    const goal = item || {};
    Object.assign(strategyNodeForm, {
      title: goal.title || "",
      key: goal.key || "",
      text: goal.text || "",
      positivePrompt: item ? (goal.positivePrompt || defaultGoalPositivePrompt(goal)) : "",
      negativePrompt: item ? (goal.negativePrompt || defaultGoalNegativePrompt()) : ""
    });
  } else {
    const strategy = item?.strategyKey
      ? strategyLibraryRows.value.find((row) => row.strategy_key === item.strategyKey)
      : strategyLibraryRows.value.find((row) => row.title === item?.title);
    Object.assign(strategyNodeForm, {
      strategyId: strategy?.id || null,
      title: strategy?.title || item?.title || "",
      key: strategy?.strategy_key || item?.strategyKey || "",
      positivePrompt: item ? (arrayToLines(strategy?.positive_modules || strategy?.positiveModules || []) || defaultPlanPositivePrompt(item)) : "",
      negativePrompt: item ? (uniquePromptLines([
        ...globalNegativePromptRules,
        ...(strategy?.negative_modules || strategy?.negativeModules || [])
      ]).join("\n") || defaultPlanNegativePrompt(item)) : ""
    });
  }
  strategyNodeDialogVisible.value = true;
}

async function saveStrategyNode() {
  if (!strategyNodeForm.title.trim()) {
    ElMessage.warning("请先填写名称");
    return;
  }
  strategyNodeSaving.value = true;
  try {
    const rule = await ensureCurrentCategoryLayerRule();
    const metadata = { ...(rule.metadata || {}) };
    const goalMap = { ...(rule.goal_strategy_map || {}) };

    if (strategyNodeMode.value === "tree") {
      metadata.categoryPrompt = strategyNodeForm.positivePrompt;
      metadata.negativePrompt = strategyNodeForm.negativePrompt;
      await saveLayerRulePatch(rule, {
        title: strategyNodeForm.title,
        rule_key: strategyNodeForm.key || rule.rule_key,
        metadata
      });
    } else if (strategyNodeMode.value === "goal") {
      const goalKey = strategyNodeForm.key || slugify(strategyNodeForm.title);
      const goals = Array.isArray(metadata.customGoals) ? [...metadata.customGoals] : [];
      const nextGoal = {
        key: goalKey,
        title: strategyNodeForm.title,
        text: strategyNodeForm.text,
        mode: strategyEditorMode.value,
        positivePrompt: strategyNodeForm.positivePrompt,
        negativePrompt: strategyNodeForm.negativePrompt,
        enabled: true
      };
      const existingIndex = goals.findIndex((item) => item.key === goalKey);
      if (existingIndex >= 0) goals.splice(existingIndex, 1, nextGoal);
      else goals.push(nextGoal);
      metadata.customGoals = goals;
      goalMap[goalKey] = goalMap[goalKey] || [];
      await saveLayerRulePatch(rule, { goal_strategy_map: goalMap, metadata });
      strategyEditorGoalKey.value = goalKey;
      strategyEditorMode.value = nextGoal.mode;
    } else {
      const strategyKey = strategyNodeForm.key || `custom-${slugify(currentCategoryName())}-${slugify(strategyEditorGoalKey.value)}-${slugify(strategyNodeForm.title)}`;
      const strategyPayload = {
        strategy_key: strategyKey,
        title: strategyNodeForm.title,
        business_modes: [editorGoalBusinessMode.value],
        applicable_goals: [strategyEditorGoalKey.value],
        applicable_assets: ["main_image"],
        aliases: [strategyNodeForm.title],
        positive_modules: linesToArray(strategyNodeForm.positivePrompt),
        negative_modules: uniquePromptLines([
          ...globalNegativePromptRules,
          ...linesToArray(strategyNodeForm.negativePrompt)
        ]),
        conflict_strategy_keys: [],
        priority: 100,
        enabled: 1,
        version: 1,
        metadata: {
          categoryTreeId: rule.id,
          category: currentCategoryName(),
          custom: true
        }
      };
      const savedStrategy = strategyNodeForm.strategyId
        ? await updateAiStrategy(strategyNodeForm.strategyId, strategyPayload)
        : await createAiStrategy(strategyPayload);
      const currentKeys = Array.isArray(goalMap[strategyEditorGoalKey.value]) ? goalMap[strategyEditorGoalKey.value] : [];
      goalMap[strategyEditorGoalKey.value] = uniquePromptLines([
        ...currentKeys.filter((key) => key !== savedStrategy.strategy_key),
        savedStrategy.strategy_key
      ]);
      await saveLayerRulePatch(rule, { goal_strategy_map: goalMap, metadata });
      await loadStrategyLibrary();
      strategyEditorPlanTitle.value = savedStrategy.title;
    }

    strategyNodeDialogVisible.value = false;
    ElMessage.success("已保存到当前类目树");
  } catch (error) {
    ElMessage.error(error.message || "保存失败");
  } finally {
    strategyNodeSaving.value = false;
  }
}

function selectStrategyForEdit(item = {}) {
  Object.assign(strategyForm, {
    id: item.id || null,
    strategy_key: item.strategy_key || item.strategyKey || "",
    title: item.title || "",
    business_modes: [...(item.business_modes || item.businessModes || ["product_optimization", "product_variant"])],
    applicable_goals: [...(item.applicable_goals || item.applicableGoals || [])],
    applicable_assets: [...(item.applicable_assets || item.applicableAssets || [])],
    aliases_text: arrayToLines(item.aliases),
    positive_modules_text: arrayToLines(item.positive_modules || item.positiveModules),
    negative_modules_text: arrayToLines(item.negative_modules || item.negativeModules),
    conflict_strategy_keys: [...(item.conflict_strategy_keys || item.conflictStrategyKeys || [])],
    priority: Number(item.priority || 0),
    enabled: Boolean(item.enabled),
    version: Number(item.version || 1),
    updated_at: item.updated_at || item.updatedAt || "",
    metadata_json: JSON.stringify(item.metadata || {}, null, 2)
  });
}

function newStrategy() {
  Object.assign(strategyForm, createBlankStrategy());
}

async function saveStrategy() {
  savingStrategy.value = true;
  try {
    const payload = {
      strategy_key: strategyForm.strategy_key,
      title: strategyForm.title,
      business_modes: strategyForm.business_modes,
      applicable_goals: strategyForm.applicable_goals,
      applicable_assets: strategyForm.applicable_assets,
      aliases: linesToArray(strategyForm.aliases_text),
      positive_modules: linesToArray(strategyForm.positive_modules_text),
      negative_modules: linesToArray(strategyForm.negative_modules_text),
      conflict_strategy_keys: strategyForm.conflict_strategy_keys,
      priority: strategyForm.priority,
      enabled: strategyForm.enabled ? 1 : 0,
      version: strategyForm.version,
      updated_at: strategyForm.updated_at || "",
      metadata: parseJsonSafe(strategyForm.metadata_json, {})
    };
    const saved = strategyForm.id
      ? await updateAiStrategy(strategyForm.id, payload)
      : await createAiStrategy(payload);
    await loadStrategyLibrary();
    selectStrategyForEdit(saved);
    remoteStrategyPlan.value = null;
    await refreshRemoteStrategyPlan();
    ElMessage.success("策略已保存");
  } catch (error) {
    ElMessage.error(error.message || "策略保存失败");
  } finally {
    savingStrategy.value = false;
  }
}

async function removeStrategy(item) {
  await ElMessageBox.confirm(`确定停用「${item.title}」吗？`, "停用策略", { type: "warning" });
  await deleteAiStrategy(item.id);
  await loadStrategyLibrary();
  newStrategy();
  remoteStrategyPlan.value = null;
  await refreshRemoteStrategyPlan();
  ElMessage.success("策略已停用");
}

function selectTemplateForEdit(item) {
  Object.assign(templateForm, {
    id: item.id,
    name: item.name || "",
    scene: item.scene || "main_image_variant",
    mode: item.mode || "image_to_image",
    description: item.description || "",
    positive_prompt: item.positive_prompt || "",
    negative_prompt: item.negative_prompt || "",
    main_image_prompt: item.main_image_prompt || "",
    detail_image_prompt_json: typeof item.detail_image_prompt_json === "string"
      ? item.detail_image_prompt_json
      : JSON.stringify(item.detailImagePrompts || {}, null, 2),
    title_prompt: item.title_prompt || "",
    tags_prompt: item.tags_prompt || "",
    description_prompt: item.description_prompt || "",
    variables_json: JSON.stringify(item.variables || [], null, 2),
    default_ratio: item.default_ratio || "3:4",
    default_count: Number(item.default_count || 1),
    is_default: Boolean(item.is_default),
    enabled: Boolean(item.enabled),
    sort_order: Number(item.sort_order || 0),
    updated_at: item.updated_at || item.updatedAt || ""
  });
}

function newTemplate() {
  Object.assign(templateForm, createBlankTemplate());
}

async function saveTemplate() {
  savingTemplate.value = true;
  try {
    const payload = { ...templateForm };
    const saved = templateForm.id
      ? await updateAiPromptTemplate(templateForm.id, payload)
      : await createAiPromptTemplate(payload);
    ElMessage.success("模板已保存");
    await loadTemplates();
    selectTemplateForEdit(saved);
  } catch (error) {
    ElMessage.error(error.message || "模板保存失败");
  } finally {
    savingTemplate.value = false;
  }
}

async function removeTemplate(item) {
  await ElMessageBox.confirm(`确定删除「${item.name}」吗？`, "删除模板", { type: "warning" });
  await deleteAiPromptTemplate(item.id);
  ElMessage.success("模板已删除");
  await loadTemplates();
  newTemplate();
}

async function copyTemplate(item) {
  const saved = await duplicateAiPromptTemplate(item.id);
  await loadTemplates();
  selectTemplateForEdit(saved);
  ElMessage.success("已复制模板");
}

async function makeDefault(item) {
  const saved = await setDefaultAiPromptTemplate(item.id);
  await loadTemplates();
  selectTemplateForEdit(saved);
  ElMessage.success("已设为默认");
}

async function saveCurrentAsTemplate() {
  Object.assign(templateForm, {
    id: null,
    name: `${selectedStyle.value.title} ${task.productType} 模板`,
    scene: "main_image_variant",
    mode: task.sourceImageUrl ? "image_to_image" : "text_to_image",
    positive_prompt: promptEditorState.positivePrompt || finalPrompt.value,
    negative_prompt: promptEditorState.negativePrompt || finalNegativePrompt.value,
    default_ratio: task.ratio,
    default_count: task.imageCount,
    enabled: true
  });
  templateCenterVisible.value = true;
  await saveTemplate();
}

function openMaterialCenter() {
  router.push({
    name: "settings-materials",
    query: {
      source: "main-image",
      returnTo: router.currentRoute.value.fullPath,
      returnLabel: "AI商品内容优化工作台"
    }
  });
}

function createBlankTemplate() {
  return {
    id: null,
    name: "",
    scene: "main_image_variant",
    mode: "image_to_image",
    description: "",
    positive_prompt: "",
    negative_prompt: "",
    main_image_prompt: "",
    detail_image_prompt_json: "{}",
    title_prompt: "",
    tags_prompt: "",
    description_prompt: "",
    variables_json: JSON.stringify(["product_name", "target_model", "material", "selling_points", "ratio"], null, 2),
    default_ratio: "3:4",
    default_count: 1,
    is_default: false,
    enabled: true,
    sort_order: 0,
    updated_at: ""
  };
}

function createBlankStrategy() {
  return {
    id: null,
    strategy_key: "",
    title: "",
    business_modes: ["product_optimization"],
    applicable_goals: ["low_ctr"],
    applicable_assets: ["main_image"],
    aliases_text: "",
    positive_modules_text: "",
    negative_modules_text: "",
    conflict_strategy_keys: [],
    priority: 50,
    enabled: true,
    version: 1,
    updated_at: "",
    metadata_json: "{}"
  };
}

function arrayToLines(value = []) {
  return (Array.isArray(value) ? value : []).join("\n");
}

function linesToArray(value = "") {
  return String(value || "").split(/\r?\n|，|,/).map((item) => item.trim()).filter(Boolean);
}

function parseJsonSafe(value, fallback = {}) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function renderText(template, variables) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => variables[key] || "");
}

function uniquePromptLines(lines = []) {
  const seen = new Set();
  const result = [];
  for (const block of lines) {
    String(block || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push(line);
    });
  }
  return result;
}

function slugify(value) {
  return String(value || "category")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "category";
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function openNewWorkbench() {
  openAiVariantLabWindow({ source: "prompt_library" });
}
</script>

<template>
  <div v-loading="loading" class="visual-workbench">
    <input ref="referenceUploadInputRef" class="reference-upload-input" type="file" accept="image/*" @change="handleReferenceUpload" />
    <header class="workbench-topbar">
      <div>
        <h1>AI商品内容优化工作台</h1>
        <p>当前商品 → AI优化目标 → 推荐策略 → 生成内容 → 回写素材与上架数据。</p>
      </div>
      <div class="topbar-actions">
        <el-button class="erp-btn erp-btn-secondary" :icon="MagicStick" @click="openNewWorkbench">新开工作台</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="Setting" @click="strategyDrawer = true">AI策略预览</el-button>
        <el-button class="erp-btn erp-btn-secondary" @click="openStrategyLibrary">GOAL / PLAN编辑</el-button>
        <el-button class="erp-btn erp-btn-secondary" @click="openTemplateCenter">图片风格配置</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="View" @click="openMaterialCenter">查看素材</el-button>
      </div>
    </header>

    <section class="workbench-flow">
      <div class="workbench-columns">
        <section class="config-card product-card">
          <section class="product-context-card">
            <div class="context-thumb">
              <ProductImagePreview
                v-if="task.sourceImageUrl"
                :key="`${workbenchId || 'default'}:${sourceImageRenderKey}:${sourceImagePreviewUrl}`"
                :src="sourceImagePreviewUrl"
                :preview-list="sourceImagePreviewList"
                size="large"
                fit="cover"
                proxy-remote
              />
              <div v-else class="context-empty-thumb">
                <Picture />
                <span>暂无参考图</span>
              </div>
            </div>
            <div class="context-info">
              <el-tag v-if="task.sourceType === 'demo'" size="small" type="warning" effect="light">演示案例</el-tag>
              <strong>{{ task.productName || "未命名商品" }}</strong>
              <div class="context-grid">
                <p><span>产品类目</span><em>{{ task.categoryName || task.productType || "-" }}</em></p>
                <p><span>品牌</span><em>{{ task.brand || "-" }}</em></p>
                <p><span>型号</span><em>{{ task.vehicleModel || "-" }}</em></p>
                <p><span>材质</span><em>{{ task.material || "-" }}</em></p>
                <p><span>颜色</span><em>{{ task.color || "-" }}</em></p>
                <p><span>核心卖点</span><em>{{ task.sellingPoints || "待补充" }}</em></p>
              </div>
            </div>
            <div class="context-actions">
              <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="openSourceDialog">导入素材</el-button>
              <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="triggerReferenceUpload">上传参考图</el-button>
              <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="openProductInfoEditor('preview')">预览完整商品信息</el-button>
              <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="openProductInfoEditor('edit')">编辑完整商品信息</el-button>
            </div>
            <div class="context-status-bar">
              <span>详情图：{{ task.detailImageCount || 0 }}张</span>
              <span>视频：{{ task.videoCount || 0 }}个</span>
              <span>标题：{{ task.title ? "已有" : "待生成" }}</span>
              <span>标签：{{ task.productTags ? "已有" : "待生成" }}</span>
              <span>描述：{{ task.summary ? "已有" : "待生成" }}</span>
              <el-checkbox v-model="task.useSourceImageAsReference">作为 image2 参考图</el-checkbox>
            </div>
          </section>
          <div class="card-title">
            <div>
              <strong>当前商品</strong>
              <span>{{ task.productName }} · {{ task.brand || "未填品牌" }} {{ task.vehicleModel || "" }}</span>
            </div>
            <div class="card-actions">
              <el-popover placement="bottom-end" width="260" trigger="click">
                <template #reference>
                  <el-button class="erp-btn-link" link>显示字段</el-button>
                </template>
                <div class="field-preferences">
                  <div class="field-preferences-head">
                    <strong>我的字段显示</strong>
                    <el-button class="erp-btn-link" link type="primary" @click="resetSourceFieldPreferences">恢复默认</el-button>
                  </div>
                  <el-checkbox-group v-model="visibleSourceFieldKeys" @change="saveSourceFieldPreferences">
                    <el-checkbox v-for="field in sourceFieldOptions" :key="field.key" :value="field.key">
                      {{ field.label }}
                    </el-checkbox>
                  </el-checkbox-group>
                </div>
              </el-popover>
              <el-button class="erp-btn-link" link type="primary" @click="openProductInfoEditor('preview')">预览完整商品信息</el-button>
              <el-button class="erp-btn-link" link type="primary" @click="openProductInfoEditor('edit')">编辑完整商品信息</el-button>
              <el-button class="erp-btn-link" link type="primary" :icon="UploadFilled" @click="openSourceDialog">导入素材</el-button>
            </div>
          </div>
          <el-alert v-if="task.sourceLabel" type="success" :closable="false" :title="`当前来源：${task.sourceLabel}`" />
          <section class="product-summary-strip">
            <p><span>商品名称</span><strong>{{ task.productName || "-" }}</strong></p>
            <p><span>类目</span><strong>{{ task.categoryName || task.productType || "-" }}</strong></p>
            <p><span>品牌型号</span><strong>{{ task.brand || "-" }} {{ task.vehicleModel || "" }}</strong></p>
            <p><span>材质/颜色</span><strong>{{ task.material || "-" }} / {{ task.color || "-" }}</strong></p>
            <p><span>核心卖点</span><strong>{{ task.sellingPoints || "待补充" }}</strong></p>
          </section>
          <div class="source-field-grid">
            <label
              v-for="field in visibleSourceFields"
              :key="field.key"
              class="source-field"
              :class="{ wide: field.span === 2 }"
            >
              <span>
                <strong>{{ field.label }}</strong>
                <em>{{ field.hint }}</em>
              </span>
              <template v-if="field.custom === 'brandModel'">
                <div class="inline-fields">
                  <el-input v-model="task.brand" placeholder="汽车品牌，例如 TENET" />
                  <el-input v-model="task.vehicleModel" placeholder="当前型号，例如 T4 / 通用" />
                </div>
              </template>
              <template v-else-if="field.custom === 'materialColor'">
                <div class="inline-fields">
                  <el-input v-model="task.material" placeholder="材质，例如不锈钢" />
                  <el-input v-model="task.color" placeholder="颜色，例如黑色 / 银色" />
                </div>
              </template>
              <template v-else-if="field.custom === 'package'">
                <div class="inline-fields package-fields">
                  <el-input v-model="task.packageWeightG" placeholder="包装克重 g" />
                  <el-input v-model="task.lengthCm" placeholder="长 cm" />
                  <el-input v-model="task.widthCm" placeholder="宽 cm" />
                  <el-input v-model="task.heightCm" placeholder="高 cm" />
                </div>
              </template>
              <template v-else-if="field.custom === 'supplier'">
                <div class="inline-fields">
                  <el-input v-model="task.supplierName" placeholder="供应商名称" />
                  <el-input v-model="task.purchaseUrl" placeholder="采购链接" />
                </div>
              </template>
              <template v-else-if="field.custom === 'cost'">
                <div class="inline-fields">
                  <el-input v-model="task.purchaseCost" placeholder="采购成本" />
                  <el-input v-model="task.domesticShipping" placeholder="国内运费" />
                  <el-input v-model="task.handlingFee" placeholder="打包费" />
                </div>
              </template>
              <template v-else-if="field.custom === 'price'">
                <div class="inline-fields">
                  <el-input v-model="task.salePrice" placeholder="售价" />
                  <el-input v-model="task.labelPrice" placeholder="标价" />
                  <el-input v-model="task.exchangeRate" placeholder="汇率" />
                </div>
              </template>
              <el-input
                v-else
                v-model="task[field.model]"
                :type="field.type || 'text'"
                :rows="field.type === 'textarea' ? 2 : undefined"
                :placeholder="field.placeholder"
              />
            </label>
          </div>
          <section class="current-assets-card featured-assets">
            <div class="current-assets-head">
              <div>
                <strong>当前素材</strong>
                <span>识别当前已有素材，决定是否作为 image2 参考图或回写对象。</span>
              </div>
              <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="openSourceDialog">替换</el-button>
            </div>
            <div class="current-assets-body featured-assets-body">
              <div class="current-thumb">
                <el-image v-if="task.sourceImageUrl" :src="sourceImagePreviewUrl" fit="cover" lazy :preview-src-list="sourceImagePreviewList" />
                <div v-else class="compact-empty-thumb">
                  <Picture />
                  <span>暂无主图，可导入商品素材或上传参考图</span>
                </div>
              </div>
              <div class="current-asset-meta">
                <p><span>详情图</span><strong>{{ task.detailImageCount || 0 }} 张</strong></p>
                <p><span>视频</span><strong>{{ task.videoCount || 0 }} 个</strong></p>
                <p><span>标题</span><strong>{{ task.title || "待生成" }}</strong></p>
                <p><span>标签</span><strong>{{ task.productTags || "待生成" }}</strong></p>
                <p><span>描述</span><strong>{{ task.summary || "待生成" }}</strong></p>
              </div>
            </div>
            <div class="current-asset-actions">
              <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="openSourceDialog">导入素材</el-button>
              <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="openSourceDialog">上传参考图</el-button>
              <el-button class="erp-btn-link" size="small" text type="primary" @click="task.useSourceImageAsReference = !task.useSourceImageAsReference">
                {{ task.useSourceImageAsReference ? "已作为 image2 参考图" : "选择为 image2 参考图" }}
              </el-button>
              <el-button class="erp-btn-link" size="small" text type="primary" @click="previewPrompt">查看</el-button>
            </div>
          </section>
          <section class="category-tree-card">
            <div>
              <span>{{ categoryTreeStatus.mode }}</span>
              <strong>{{ categoryTreeStatus.treeName }}</strong>
              <p>当前类目：{{ categoryTreeStatus.category }}</p>
              <em>{{ categoryTreeStatus.description }}</em>
            </div>
            <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="openStrategyNodeDialog('tree')">
              {{ hasSpecificCategoryTree ? "编辑当前类目树" : "创建当前类目树" }}
            </el-button>
          </section>
          <section class="ai-plan-card">
            <div>
              <span>AI优化方案</span>
              <strong>当前选择目标：{{ selectedOptimizationTarget.title }}</strong>
            </div>
            <div class="ai-plan-pills">
              <el-tag type="info" effect="plain">{{ selectedStrategyCountText }}</el-tag>
              <el-tag
                v-for="item in selectedStrategyTitles"
                :key="item"
                type="primary"
                effect="light"
              >
                {{ item }}
              </el-tag>
            </div>
          </section>
          <el-collapse class="more-fields-collapse">
            <el-collapse-item title="更多字段：采购、物流、成本、备注" name="more">
              <div class="more-fields-grid">
                <el-input v-model="task.logisticsRuleName" placeholder="物流规则" />
                <el-input v-model="task.sourcePlatform" placeholder="来源平台" />
                <el-input v-model="task.supplierName" placeholder="供应商" />
                <el-input v-model="task.purchaseUrl" placeholder="采购链接" />
                <el-input v-model="task.purchaseCost" placeholder="采购成本" />
                <el-input v-model="task.domesticShipping" placeholder="国内运费" />
                <el-input v-model="task.handlingFee" placeholder="打包费" />
                <el-input v-model="task.supplierNote" placeholder="内部/供应商备注" />
              </div>
            </el-collapse-item>
          </el-collapse>
        </section>

        <section class="strategy-config-band">
          <section class="ai-flow-card goal-card">
            <div class="flow-step-head">
              <span>GOAL</span>
              <div>
                <strong>选择优化方向</strong>
              </div>
            </div>
            <el-segmented v-model="workbenchTaskMode" class="workbench-mode-switch" :options="WORKBENCH_MODE_OPTIONS" />
            <el-tabs v-if="!isTextWorkbench" v-model="activeCommerceMode" class="assistant-tabs">
              <el-tab-pane label="商品优化 AI" name="optimization" />
              <el-tab-pane label="商品裂变 AI" name="variant" />
            </el-tabs>
            <div class="commerce-mode-stack">
              <div
                v-for="mode in activeWorkbenchModes"
                :key="mode.title"
                class="commerce-mode-card"
              >
                <div v-if="isTextWorkbench" class="hero-objective-grid">
                  <button
                    v-for="item in TEXT_TASK_OPTIONS"
                    :key="item.key"
                    :class="{ active: task.outputs.includes(item.key) }"
                    @click="toggleTextTask(item.key)"
                  >
                    <strong>{{ item.title }}</strong>
                    <span>{{ item.text }}</span>
                  </button>
                </div>
                <div v-else class="hero-objective-grid">
                  <button
                    v-for="item in mode.items"
                    :key="item.key"
                    :class="{ active: task.optimizationTarget === item.key }"
                    @click="selectOptimizationTarget(flatOptimizationTargets.find(target => target.key === item.key) || item)"
                  >
                    <strong>{{ item.title }}</strong>
                    <span>{{ item.text }}</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section class="ai-flow-card recommendation-card">
            <div class="flow-step-head">
              <span>PLAN</span>
              <div>
                <strong>{{ isTextWorkbench ? "选择文本策略" : (isVariantWorkflow ? "选择裂变策略" : "选择生成策略") }}</strong>
              </div>
            </div>
            <div class="recommendation-list">
              <button
                v-for="item in goalStrategyCards"
                :key="item.title"
                :class="{ active: task.selectedStrategies[0] === item.title, recommended: item.recommended }"
                @click="toggleRecommendedStrategy(item.title)"
              >
                <strong>{{ task.selectedStrategies[0] === item.title ? "✓" : "+" }} {{ item.title }}</strong>
                <span>{{ isTextWorkbench ? "单一执行策略" : (isVariantWorkflow ? "单一裂变策略" : (item.recommended ? "独立方案" : "可选方案")) }}</span>
              </button>
            </div>
          </section>
          <section class="generation-config-workbench">
            <div class="generation-config-head">
              <div>
                <span>CONFIG</span>
                <strong>{{ isTextWorkbench ? "文本生成配置" : "生成配置工作台" }}</strong>
              </div>
              <div class="canvas-tools">
                <template v-if="!isTextWorkbench">
                  <el-segmented v-model="task.ratio" :options="ratioOptions" />
                  <el-select v-model="task.style" placeholder="图片风格" style="width: 180px">
                    <el-option v-for="item in styleOptions" :key="item.key" :label="item.title" :value="item.key" @click="selectStrategy(item)" />
                  </el-select>
                </template>
                <el-button class="erp-btn erp-btn-secondary" :icon="View" @click="previewPrompt">预览 Prompt</el-button>
              </div>
            </div>
            <div class="inline-output-layout" :class="{ 'text-output-layout': isTextWorkbench }">
              <div class="inline-targets" :class="{ 'text-targets-panel': isTextWorkbench }">
                <div class="target-tab-head">
                  <strong>{{ isTextWorkbench ? "关键词 / 车型补充" : (isVariantWorkflow ? "裂变变量" : "车型变量（可选）") }}</strong>
                  <el-button class="erp-btn-link-danger" link type="danger" :disabled="!task.targets.length" @click="clearTargets">清空</el-button>
                </div>
                <div class="target-tags">
                  <el-tag v-for="(item, index) in task.targets" :key="item" closable @close="removeTarget(index)">{{ item }}</el-tag>
                  <span v-if="!task.targets.length" class="target-empty">{{ isTextWorkbench ? "还没有补充关键词" : "还没有车型变量" }}</span>
                </div>
                <div class="target-input-row">
                  <el-input
                    v-model="task.targetInput"
                    type="textarea"
                    :rows="1"
                    resize="none"
                    :placeholder="isTextWorkbench ? '可补充品牌、车型、材质、场景词，帮助文本更准确' : (isVariantWorkflow ? '输入或粘贴车型变量，每个车型生成一张独立主图' : '可选：输入参考车型，用于优化文案或主图')"
                    @keyup.enter.exact.prevent="addTargetFromInput"
                    @keyup.ctrl.enter="addTargetFromInput"
                  />
                  <el-button class="erp-btn erp-btn-primary" type="primary" @click="addTargetFromInput">添加</el-button>
                </div>
                <div class="quick-row" :class="{ 'text-quick-row': isTextWorkbench }">
                  <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['TENET T4', 'TENET T7', 'TENET T8'])">TENET</el-button>
                  <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['BELGEE X50', 'BELGEE X70'])">BELGEE</el-button>
                  <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['HAVAL Jolion', 'HAVAL F7', 'HAVAL Dargo'])">HAVAL</el-button>
                  <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['CHERY TIGGO 4', 'CHERY TIGGO 7', 'CHERY TIGGO 8'])">CHERY</el-button>
                  <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['JAECOO J7', 'JAECOO J8'])">JAECOO</el-button>
                </div>
              </div>
              <div class="asset-check-groups inline-asset-groups" :class="{ 'text-asset-groups': isTextWorkbench }">
                <template v-if="!isTextWorkbench">
                <div class="asset-check-group">
                  <span>图片资产</span>
                  <el-checkbox-group v-model="task.outputs">
                    <el-checkbox value="主图">主图</el-checkbox>
                    <el-checkbox value="详情图">详情图</el-checkbox>
                  </el-checkbox-group>
                  <div v-if="task.outputs.includes('详情图')" class="detail-type-picker">
                    <em>详情图模块</em>
                    <el-checkbox-group v-model="task.detailImageTypes">
                      <el-checkbox v-for="item in detailImageTypeOptions" :key="item" :value="item">
                        {{ item }}
                      </el-checkbox>
                    </el-checkbox-group>
                  </div>
                </div>
                <div class="asset-check-group writeback-auto-group">
                  <span>回写资产</span>
                  <div class="writeback-tags">
                    <el-tag v-for="item in selectedWriteBackAssets" :key="item" size="small" type="success" effect="light">{{ item }}</el-tag>
                    <span v-if="!selectedWriteBackAssets.length">暂未选择回写内容</span>
                  </div>
                </div>
                <div v-if="task.sourceType === 'selection'" class="asset-check-group writeback-mode-group">
                  <span>选品池回写策略</span>
                  <el-radio-group v-model="sourceSubmitMode" class="selection-writeback-modes">
                    <el-radio-button
                      v-for="item in selectionWritebackModeOptions"
                      :key="item.value"
                      :label="item.value"
                      :value="item.value"
                    >
                      {{ item.label }}
                    </el-radio-button>
                  </el-radio-group>
                  <div class="selection-writeback-mode-list">
                    <article
                      v-for="item in selectionWritebackModeOptions"
                      :key="`${item.value}-desc`"
                      :class="{ active: sourceSubmitMode === item.value }"
                    >
                      <strong>{{ item.label }}</strong>
                      <p>{{ item.description }}</p>
                    </article>
                  </div>
                  <p class="selection-writeback-mode-help">{{ selectionWritebackModeHelp }}</p>
                </div>
                </template>
                <template v-else>
                  <div class="asset-check-group text-logic-group">
                    <span>文本输出逻辑</span>
                    <div class="writeback-tags">
                      <el-tag v-for="item in TEXT_WRITEBACK_ITEMS" :key="item" size="small" type="success" effect="light">{{ item }}</el-tag>
                    </div>
                    <p class="text-logic-copy">默认优化标题、标签、描述，描述变化时自动同步富文本。</p>
                  </div>
                  <div class="asset-check-group writeback-auto-group text-writeback-group">
                    <span>回写提示</span>
                    <div class="text-config-summary">
                      <p>{{ textWriteBackHint }}</p>
                      <p>文本任务不依附图片策略，生成后可直接在底部结果区确认并回写。</p>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </section>
        </section>

        <main class="canvas-area">
          <section class="canvas-status">
            <div>
              <span class="status-dot" :class="{ running: taskStatus === '生成中', done: taskStatus === '已完成', failed: taskStatus === '失败' }"></span>
              <span class="result-area-title">AI生成结果区</span>
              <strong>{{ taskStatus }}</strong>
              <em>{{ displayResults.length }} 个结果</em>
            </div>
            <div class="canvas-status-actions">
              <el-button class="erp-btn erp-btn-secondary" size="small" @click="saveDraft">保存草稿</el-button>
              <el-button class="erp-btn erp-btn-primary" size="small" type="primary" :icon="MagicStick" :loading="generating" @click="startGenerate">
                {{ currentModeHasResults ? "重新生成" : "开始AI优化" }}
              </el-button>
              <el-tooltip :content="writeBackGateText" placement="top">
                <span>
                  <el-button
                    class="erp-btn erp-btn-secondary"
                    size="small"
                    type="success"
                    plain
                    :disabled="!currentModeHasResults || !sourceSubmitReady"
                    @click="batchWriteBack"
                  >
                    最终提交
                  </el-button>
                </span>
              </el-tooltip>
            </div>
          </section>

          <section class="canvas-frame result-workspace" :class="`ratio-${task.ratio.replace(':', '-')}`">
            <div v-if="!currentModeHasResults && !generating" class="ai-suggestion-panel">
            <div class="result-task-summary">
              <p><span>本次任务</span><strong>{{ selectedOptimizationTarget.title }}</strong></p>
              <p><span>{{ isVariantWorkflow ? "裂变方式" : "优化目标" }}</span><strong>{{ selectedOptimizationTarget.text }}</strong></p>
              <p><span>{{ isVariantWorkflow ? "裂变策略" : "独立策略" }}</span><strong>{{ selectedStrategyCountText }}：{{ selectedStrategyTitles.join(" / ") }}</strong></p>
              <p><span>输出内容</span><strong>{{ selectedWriteBackAssets.slice(0, 5).join(" + ") }}</strong></p>
            </div>
            <div class="pending-task-list">
              <article v-for="item in pendingGenerationTasks" :key="item.title">
                <span>{{ item.type }}</span>
                <strong>{{ item.title }}</strong>
                <em>{{ item.desc }}</em>
              </article>
            </div>
            <el-empty class="light-empty-result" description="选择右侧目标和输出内容后，点击开始AI优化。生成完成后这里会展示真实素材卡片。" />
            <el-button type="primary" :icon="MagicStick" @click="startGenerate">开始AI优化</el-button>
          </div>
          <div v-if="generating" class="generating-state">
            <el-skeleton :rows="5" animated />
            <el-progress :percentage="Math.max(...displayResults.map(item => item.progress), 12)" />
          </div>

          <div
            v-if="currentModeHasResults && !generating"
            class="asset-result-sections"
            :class="{
              'image-only-results': imageResultSectionVisible && !copyResultWorkbenchVisible && !writebackResultSectionVisible,
              'copy-only-results': !imageResultSectionVisible && copyResultWorkbenchVisible
            }"
          >
            <section v-if="imageResultSectionVisible" class="result-section image-result-section">
              <div class="result-section-head">
                <div>
                  <strong>图片素材</strong>
                  <span>主图和详情图素材，生成后可预览、重新生成、下载或回写。</span>
                </div>
                <el-tag type="primary" effect="light">{{ imageResults.length }} 个</el-tag>
              </div>
              <div v-if="imageResults.length" class="image-grid">
                <article v-for="item in imageResults" :key="item.id" class="asset-card">
                  <div class="asset-image">
                    <el-image v-if="item.imageUrl" :src="withImageToken(item.imageUrl)" fit="cover" :preview-src-list="[withImageToken(item.imageUrl)]" />
                    <el-skeleton v-else animated>
                      <template #template><el-skeleton-item variant="image" /></template>
                    </el-skeleton>
                    <el-tag class="asset-status" :type="item.status === '已完成' ? 'success' : item.status === '失败' ? 'danger' : 'warning'">{{ item.status }}</el-tag>
                  </div>
                  <div class="asset-meta">
                    <strong>{{ item.targetModel || item.strategyTitle }}</strong>
                    <span>{{ item.type }}{{ item.detailType ? ` / ${item.detailType}` : "" }} · {{ item.strategyTitle }} · {{ item.ratio }} · {{ item.createdAt }}</span>
                    <span v-if="item.assetId">素材资产 #{{ item.assetId }} · {{ item.assetStatus }}</span>
                  </div>
                  <div v-if="['失败', '等待服务商'].includes(item.status)" class="asset-error">{{ item.errorMessage }}</div>
                  <div class="asset-actions">
                    <el-button class="erp-btn erp-btn-secondary" size="small" :icon="Refresh" @click="regenerateResult(item)">重新生成</el-button>
                    <el-button v-if="item.pendingTaskId" class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="pullPendingResult(item)">继续等待 / 拉回</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="editPromptForItem(item)">编辑Prompt</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" :icon="Download" tag="a" :href="item.downloadUrl ? downloadUrl(item.downloadUrl) : undefined" :disabled="!item.downloadUrl">下载</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="setAsMain(item)">设为主图</el-button>
                    <el-tooltip :content="writeBackGateText" placement="top">
                      <span>
                        <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain :disabled="!sourceSubmitReady" @click="writeBack(item)">最终提交</el-button>
                      </span>
                    </el-tooltip>
                  </div>
                </article>
              </div>
              <el-empty v-else class="compact-result-empty" description="本次还没有生成图片素材" />
            </section>

            <section v-if="copyResultWorkbenchVisible" class="result-section copy-result-section">
              <div class="result-section-head">
                <div>
                  <strong>文案素材</strong>
                  <span>标题、标签、描述统一展示，方便复制、编辑和回写。</span>
                </div>
                <el-tag type="success" effect="light">{{ titleResults.length + tagResults.length + descriptionResults.length }} 组</el-tag>
              </div>
              <div v-if="titleResults.length || tagResults.length || descriptionResults.length" class="copy-asset-grid">
                <article v-for="item in titleResults" :key="`title-${item.id}`" class="copy-result-card">
                  <strong>{{ item.targetModel }} 标题方案</strong>
                  <div v-for="(title, index) in item.generatedTitles" :key="`${ruCopy(title)}-${index}`" class="copy-row">
                    <span>{{ ["高点击标题", "高搜索标题"][index] || "标题方案" }}</span>
                    <p>{{ ruCopy(title) }}</p>
                     <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="applyGeneratedTitle(title)">回写</el-button>
                  </div>
                </article>
                <article v-for="item in tagResults" :key="`tag-${item.id}`" class="copy-result-card">
                  <strong>{{ item.targetModel }} 标签方案</strong>
                  <div class="generated-tags">
                    <el-tooltip v-for="tag in item.generatedTags" :key="ruCopy(tag)" :content="ruCopy(tag)" placement="top">
                      <el-check-tag checked>{{ ruCopy(tag) }}</el-check-tag>
                    </el-tooltip>
                  </div>
                  <p class="tag-tip">共 {{ item.generatedTags.length }} 个标签，已自动去重。要求至少 15 个，单个标签少于 30 个字符。</p>
                  <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="applyGeneratedTags(item.generatedTags)">回写</el-button>
                </article>
                <article v-for="item in descriptionResults" :key="`desc-${item.id}`" class="copy-result-card">
                  <strong>{{ item.targetModel }} 描述方案</strong>
                  <p>{{ ruCopy(item.generatedDescription) }}</p>
                  <span class="copy-meta-tip">{{ countCopyWords(item.generatedDescription) }} 词</span>
                  <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="applyGeneratedDescription(item.generatedDescription)">回写</el-button>
                </article>
              </div>
              <el-empty v-else class="compact-result-empty" description="本次还没有生成文案素材" />
            </section>

            <section v-if="writebackResultSectionVisible" class="result-section writeback-result-section">
              <div class="result-section-head">
                <div>
                  <strong>回写记录</strong>
                  <span>已生成素材会自动沉淀为资产，回写状态在这里统一跟踪。</span>
                </div>
                <el-tooltip :content="writeBackGateText" placement="top">
                  <span>
                    <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain :disabled="!currentModeHasResults || !sourceSubmitReady" @click="batchWriteBack">最终提交</el-button>
                  </span>
                </el-tooltip>
              </div>
              <div v-if="currentModeWritebackResults.length" class="writeback-list">
                <article v-for="item in currentModeWritebackResults" :key="`wb-${item.id}`">
                  <strong>{{ item.targetModel || item.strategyTitle }}{{ item.detailType ? ` / ${item.detailType}` : "" }} · {{ item.writeBackStatus }}</strong>
                  <span>
                    {{ item.createdSelectionId ? `新选品记录 #${item.createdSelectionId}` : (item.assetId ? `素材资产 #${item.assetId}` : "文案素材") }}，{{ item.status }}，{{ item.createdAt }}
                  </span>
                </article>
              </div>
              <el-empty v-else class="compact-result-empty" description="暂无回写记录" />
            </section>
            </div>
          </section>
        </main>
      </div>

    </section>

    <el-drawer v-model="diagnosisDrawer" title="数据诊断建议" size="420px">
      <div class="diagnosis-list">
        <article v-for="item in diagnosisOptions" :key="item.key" class="diagnosis-card" @click="applyDiagnosis(item)">
          <strong>{{ item.title }}</strong>
          <span>{{ item.advice }}</span>
          <el-button size="small" type="primary" plain>应用建议</el-button>
        </article>
      </div>
    </el-drawer>

    <el-dialog v-model="productInfoDrawer" :title="productInfoDialogTitle" width="1180px" align-center class="product-info-dialog">
      <div class="product-info-editor">
        <div class="product-info-actions">
          <el-button @click="productInfoDrawer = false">{{ productInfoReadonly ? "关闭" : "取消" }}</el-button>
          <el-button v-if="!productInfoReadonly" type="primary" :loading="savingProductInfo" @click="saveProductInfoEditor">
            {{ productInfoTemplateMeta.action }}
          </el-button>
        </div>
        <section class="product-info-template-layout">
          <aside class="product-info-preview-panel">
            <section class="product-info-overview product-info-template-overview">
              <ProductImagePreview
                :src="productInfoForm.sourceImageUrl"
                :preview-list="[productInfoForm.sourceImageUrl].filter(Boolean)"
                size="large"
                fit="cover"
              />
              <div>
                <span>{{ task.sourceLabel || "当前编辑桌商品" }}</span>
                <strong>{{ productInfoForm.productName || productInfoForm.title || "未命名商品" }}</strong>
                <p>{{ productInfoTemplateMeta.subtitle }}</p>
              </div>
            </section>
            <section class="product-info-template-card">
              <div class="template-card-head">
                <strong>{{ productInfoTemplateMeta.title }}</strong>
                <span>保存后会回到 AI 素材优化页面继续生成</span>
              </div>
              <div class="template-fact-list">
                <article v-for="fact in productInfoPreviewFacts" :key="`preview-fact-${fact.label}`" class="template-fact-item">
                  <span>{{ fact.label }}</span>
                  <strong>{{ fact.value || "-" }}</strong>
                </article>
              </div>
            </section>
          </aside>

          <main class="product-info-template-form" :class="{ readonly: productInfoReadonly }">
            <section
              v-for="section in productInfoSections"
              :key="section.title"
              class="product-info-template-card"
            >
              <div class="template-card-head">
                <strong>{{ section.title }}</strong>
                <span>{{ section.subtitle }}</span>
              </div>
              <div class="source-field-grid product-info-form-grid">
                <label
                  v-for="field in section.fields"
                  :key="`drawer-${section.title}-${field.key}`"
                  class="source-field"
                  :class="{ wide: field.span === 2 }"
                >
                  <span>
                    <strong>{{ field.label }}</strong>
                    <em>{{ field.hint }}</em>
                  </span>
                  <template v-if="field.custom === 'brandModel'">
                    <div class="inline-fields">
                      <el-input v-model="productInfoForm.brand" placeholder="汽车品牌，例如 TENET" />
                      <el-input v-model="productInfoForm.vehicleModel" placeholder="当前型号，例如 T4 / 通用" />
                    </div>
                  </template>
                  <template v-else-if="field.custom === 'materialColor'">
                    <div class="inline-fields">
                      <el-input v-model="productInfoForm.material" placeholder="材质，例如不锈钢" />
                      <el-input v-model="productInfoForm.color" placeholder="颜色，例如黑色 / 银色" />
                    </div>
                  </template>
                  <template v-else-if="field.custom === 'package'">
                    <div class="inline-fields package-fields">
                      <el-input v-model="productInfoForm.packageWeightG" placeholder="包装克重 g" />
                      <el-input v-model="productInfoForm.lengthCm" placeholder="长 cm" />
                      <el-input v-model="productInfoForm.widthCm" placeholder="宽 cm" />
                      <el-input v-model="productInfoForm.heightCm" placeholder="高 cm" />
                    </div>
                  </template>
                  <template v-else-if="field.custom === 'supplier'">
                    <div class="inline-fields">
                      <el-input v-model="productInfoForm.supplierName" placeholder="供应商名称" />
                      <el-input v-model="productInfoForm.purchaseUrl" placeholder="采购链接" />
                    </div>
                  </template>
                  <template v-else-if="field.custom === 'cost'">
                    <div class="inline-fields">
                      <el-input v-model="productInfoForm.purchaseCost" placeholder="采购成本" />
                      <el-input v-model="productInfoForm.domesticShipping" placeholder="国内运费" />
                      <el-input v-model="productInfoForm.handlingFee" placeholder="包装费" />
                    </div>
                  </template>
                  <template v-else-if="field.custom === 'price'">
                    <div class="inline-fields">
                      <el-input v-model="productInfoForm.salePrice" placeholder="售价" />
                      <el-input v-model="productInfoForm.labelPrice" placeholder="标价" />
                      <el-input v-model="productInfoForm.exchangeRate" placeholder="汇率" />
                    </div>
                  </template>
                  <el-input
                    v-else
                    v-model="productInfoForm[field.model]"
                    :type="field.type || 'text'"
                    :rows="field.type === 'textarea' ? 3 : undefined"
                    :placeholder="field.placeholder"
                  />
                </label>
              </div>
            </section>
          </main>
        </section>
      </div>
    </el-dialog>

    <el-dialog v-model="sourceDialogVisible" title="导入母商品 / 素材来源" width="980px" align-center>
      <div v-loading="sourceLoading" class="source-import-dialog">
        <el-tabs v-model="sourceTab">
          <el-tab-pane label="在线商品" name="online_products">
            <div class="source-list-panel">
              <div class="source-list-toolbar">
                <el-input
                  v-model="sourceFilters.online_products.keyword"
                  :prefix-icon="Search"
                  clearable
                  :placeholder="sourceSearchPlaceholder('online_products')"
                  @keyup.enter="searchSourceRows('online_products')"
                  @clear="searchSourceRows('online_products')"
                />
                <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" @click="searchSourceRows('online_products')">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="loadSourceOnlineProducts">刷新</el-button>
              </div>
              <el-table :data="sourceOnlineProducts" height="390" stripe>
              <el-table-column label="商品" min-width="300">
                <template #default="{ row }">
                  <div class="source-product-cell">
                    <ProductImagePreview
                      :src="onlineProductThumbUrl(row)"
                      :preview-list="onlineProductPreviewList(row)"
                      size="large"
                      fit="cover"
                      lazy
                      proxy-remote
                    />
                    <div>
                      <strong>{{ row.name || row.offer_id || row.ozon_sku || `在线商品 #${row.id}` }}</strong>
                      <span>{{ row.offer_id || "-" }} / {{ row.ozon_sku || "-" }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="category_name" label="类目" min-width="160" />
              <el-table-column label="价格" width="120">
                <template #default="{ row }">
                  {{ row.sale_price || "-" }}
                </template>
              </el-table-column>
              <el-table-column label="店铺" min-width="140">
                <template #default="{ row }">
                  {{ row.shop_name || "-" }}
                </template>
              </el-table-column>
              <el-table-column label="状态" width="120">
                <template #default="{ row }">
                  <el-tag :type="row.archived ? 'info' : 'success'">
                    {{ row.archived ? "已归档" : (row.status || "在线") }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right">
                <template #default="{ row }">
                  <el-button type="primary" link :loading="sourceImportingId === `online-${row.id || ''}`" @click="importOnlineProductSource(row)">导入</el-button>
                </template>
              </el-table-column>
              </el-table>
              <PageFooterPagination
                :total="sourceFilters.online_products.total"
                :page="sourceFilters.online_products.page"
                :page-size="sourceFilters.online_products.pageSize"
                :page-sizes="[10, 20, 50]"
                compact
                :summary="sourceFooterSummary('online_products')"
                @update:page="handleSourcePageChange('online_products', $event)"
                @update:pageSize="handleSourcePageSizeChange('online_products', $event)"
              />
            </div>
          </el-tab-pane>
          <el-tab-pane label="采集箱" name="collector">
            <div class="source-list-panel">
              <div class="source-list-toolbar">
                <el-input
                  v-model="sourceFilters.collector.keyword"
                  :prefix-icon="Search"
                  clearable
                  :placeholder="sourceSearchPlaceholder('collector')"
                  @keyup.enter="searchSourceRows('collector')"
                  @clear="searchSourceRows('collector')"
                />
                <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" @click="searchSourceRows('collector')">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="loadSourceCollectors">刷新</el-button>
              </div>
              <el-table :data="sourceCollectors" height="390" stripe>
              <el-table-column label="商品" min-width="280">
                <template #default="{ row }">
                  <div class="source-product-cell">
                    <ProductImagePreview
                      :src="collectorThumbUrl(row)"
                      :preview-list="collectorPreviewList(row)"
                      size="large"
                      fit="cover"
                      lazy
                      proxy-remote
                    />
                    <div>
                      <strong>{{ row.title || row.sku }}</strong>
                      <span>{{ row.sku || "-" }} / {{ row.product_id || "-" }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="category_name" label="类目" min-width="160" />
              <el-table-column prop="price" label="价格" width="110" />
              <el-table-column label="状态" width="130">
                <template #default="{ row }">
                  <el-tag :type="row.selection_product_id ? 'success' : 'warning'">
                    {{ row.selection_product_id ? "已入选品池" : "可导入" }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right">
                <template #default="{ row }">
                  <el-button type="primary" link :loading="sourceImportingId === String(row.sku || '')" @click="importCollectorSource(row)">导入</el-button>
                </template>
              </el-table-column>
              </el-table>
              <PageFooterPagination
                :total="sourceFilters.collector.total"
                :page="sourceFilters.collector.page"
                :page-size="sourceFilters.collector.pageSize"
                :page-sizes="[10, 20, 50]"
                compact
                :summary="sourceFooterSummary('collector')"
                @update:page="handleSourcePageChange('collector', $event)"
                @update:pageSize="handleSourcePageSizeChange('collector', $event)"
              />
            </div>
          </el-tab-pane>
          <el-tab-pane label="上架记录" name="listing_records">
            <div class="source-list-panel">
              <div class="source-list-toolbar">
                <el-input
                  v-model="sourceFilters.listing_records.keyword"
                  :prefix-icon="Search"
                  clearable
                  :placeholder="sourceSearchPlaceholder('listing_records')"
                  @keyup.enter="searchSourceRows('listing_records')"
                  @clear="searchSourceRows('listing_records')"
                />
                <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" @click="searchSourceRows('listing_records')">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="loadSourceListingRecords">刷新</el-button>
              </div>
              <el-table :data="sourceListingRecords" height="390" stripe>
              <el-table-column label="商品" min-width="300">
                <template #default="{ row }">
                  <div class="source-product-cell">
                    <ProductImagePreview
                      :src="listingRecordThumbUrl(row)"
                      :preview-list="listingRecordPreviewList(row)"
                      size="large"
                      fit="cover"
                      lazy
                      proxy-remote
                    />
                    <div>
                      <strong>{{ row.product_name || row.offer_id || `上架记录 #${row.id}` }}</strong>
                      <span>{{ row.offer_id || `#${row.id}` }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="category_name" label="类目" min-width="160" />
              <el-table-column label="价格" width="120">
                <template #default="{ row }">
                  {{ row.price || "-" }} {{ row.currency_code || "" }}
                </template>
              </el-table-column>
              <el-table-column label="店铺" min-width="130">
                <template #default="{ row }">
                  {{ row.shop_name || "-" }}
                </template>
              </el-table-column>
              <el-table-column label="SKU / ID" min-width="150">
                <template #default="{ row }">
                  <div class="source-meta-stack">
                    <span>{{ row.ozon_sku || row.offer_id || "-" }}</span>
                    <em>{{ row.ozon_product_id || row.id || "-" }}</em>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="120">
                <template #default="{ row }">
                  <el-tag :type="['imported', 'published', 'success'].includes(row.status) ? 'success' : (row.status === 'failed' ? 'danger' : 'warning')">
                    {{ listingRecordStatusText(row) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right">
                <template #default="{ row }">
                  <el-button type="primary" link :loading="sourceImportingId === `listing-${row.id || ''}`" @click="importListingRecordSource(row)">导入</el-button>
                </template>
              </el-table-column>
              </el-table>
              <PageFooterPagination
                :total="sourceFilters.listing_records.total"
                :page="sourceFilters.listing_records.page"
                :page-size="sourceFilters.listing_records.pageSize"
                :page-sizes="[10, 20, 50]"
                compact
                :summary="sourceFooterSummary('listing_records')"
                @update:page="handleSourcePageChange('listing_records', $event)"
                @update:pageSize="handleSourcePageSizeChange('listing_records', $event)"
              />
            </div>
          </el-tab-pane>
          <el-tab-pane label="选品池" name="selection">
            <div class="source-list-panel">
              <div class="source-list-toolbar">
                <el-input
                  v-model="sourceFilters.selection.keyword"
                  :prefix-icon="Search"
                  clearable
                  :placeholder="sourceSearchPlaceholder('selection')"
                  @keyup.enter="searchSourceRows('selection')"
                  @clear="searchSourceRows('selection')"
                />
                <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" @click="searchSourceRows('selection')">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="loadSourceSelections">刷新</el-button>
              </div>
              <el-table :data="sourceSelections" height="390" stripe>
              <el-table-column label="商品" min-width="260">
                <template #default="{ row }">
                  <div class="source-product-cell">
                    <ProductImagePreview
                      :src="selectionThumbUrl(row)"
                      :preview-list="selectionPreviewList(row)"
                      size="large"
                      fit="cover"
                      lazy
                      proxy-remote
                    />
                    <div>
                      <strong>{{ row.name || row.product_name }}</strong>
                      <span>{{ row.selection_id || row.id }} / {{ row.vehicle_model || "-" }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="material" label="材质" width="110" />
              <el-table-column prop="ozon_category_name" label="Ozon类目" min-width="160" />
              <el-table-column label="完整度" width="150">
                <template #default="{ row }">
                  <el-tag :type="row.image_url && row.selling_points ? 'success' : 'warning'">
                    {{ row.image_url && row.selling_points ? "基础完整" : "待补素材" }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right">
                <template #default="{ row }">
                  <el-button type="primary" link :loading="sourceImportingId === String(row.id || row.selection_id || '')" @click="importSelectionSource(row)">导入</el-button>
                </template>
              </el-table-column>
              </el-table>
              <PageFooterPagination
                :total="sourceFilters.selection.total"
                :page="sourceFilters.selection.page"
                :page-size="sourceFilters.selection.pageSize"
                :page-sizes="[10, 20, 50]"
                compact
                :summary="sourceFooterSummary('selection')"
                @update:page="handleSourcePageChange('selection', $event)"
                @update:pageSize="handleSourcePageSizeChange('selection', $event)"
              />
            </div>
          </el-tab-pane>
          <el-tab-pane label="统一素材资产" name="assets">
            <div class="asset-source-grid">
              <article v-for="asset in sourceAssets" :key="asset.id" class="asset-source-card">
                <ProductImagePreview
                  :src="asset.thumbnail_url || asset.url"
                  :preview-list="assetPreviewList(asset)"
                  size="large"
                  fit="cover"
                  lazy
                  proxy-remote
                />
                <div>
                  <strong>{{ asset.title || asset.product_name || `素材 #${asset.id}` }}</strong>
                  <span>{{ asset.role }} · {{ asset.target_model || "-" }} · {{ asset.status }}</span>
                </div>
                <el-button type="primary" plain @click="importAssetSource(asset)">导入这套素材</el-button>
              </article>
              <el-empty v-if="!sourceAssets.length" description="暂无统一素材资产" />
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-dialog>

    <el-drawer v-model="strategyDrawer" title="AI策略预览" size="720px" class="strategy-drawer">
      <section class="strategy-overview-card">
        <span>{{ categoryTreeStatus.mode }}</span>
        <strong>{{ categoryTreeStatus.treeName }}</strong>
        <p>{{ categoryTreeStatus.description }}</p>
      </section>

      <section class="strategy-summary compact">
        <p><span>类目</span><strong>{{ categoryTreeStatus.category }}</strong></p>
        <p><span>GOAL</span><strong>{{ strategySummary.target }}</strong></p>
        <p><span>比例</span><strong>{{ task.ratio }}</strong></p>
        <p><span>风格偏向</span><strong>{{ selectedStyle.title }}</strong></p>
        <p><span>Prompt模板</span><strong>{{ activeTemplate?.name || "自动匹配" }}</strong></p>
        <p><span>输出</span><strong>{{ strategySummary.outputs }}</strong></p>
      </section>

      <section class="strategy-template-preview">
        <div class="drawer-section-head">
          <div>
            <h3>策略预览模板</h3>
            <span>{{ workbenchPreviewTemplateType }} · {{ workbenchPreviewTemplateHint }}</span>
          </div>
        </div>
        <article class="strategy-template-card" :class="`template-${task.sourceType || 'default'}`">
          <div class="strategy-template-media">
            <el-image
              v-if="task.sourceImageUrl"
              :src="sourceImagePreviewUrl"
              fit="cover"
              lazy
              :preview-src-list="sourceImagePreviewList"
            />
            <div v-else class="strategy-template-image-empty">暂无参考图</div>
            <div class="strategy-template-badges">
              <span>{{ task.sourceLabel || "未导入来源" }}</span>
              <strong>{{ workbenchPreviewTemplateType }}</strong>
            </div>
          </div>
          <div class="strategy-template-body">
            <header>
              <span>{{ selectedOptimizationTarget.title || "商品优化" }}</span>
              <strong>{{ task.title || task.productName || "未命名商品" }}</strong>
              <p>{{ workbenchPreviewTemplateHint }}</p>
            </header>
            <div class="strategy-template-grid">
              <article
                v-for="row in workbenchPreviewTemplateRows"
                :key="`preview-template-${row.label}`"
                class="strategy-template-row"
              >
                <span>{{ row.label }}</span>
                <strong>{{ row.value || "-" }}</strong>
              </article>
            </div>
          </div>
        </article>
      </section>

      <section class="drawer-strategy-list">
        <div class="drawer-section-head">
          <h3>本次 PLAN</h3>
          <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="strategyDrawer = false">返回工作台调整</el-button>
        </div>
        <div class="drawer-strategy-grid">
          <article
            v-for="item in goalStrategyCards"
            :key="`drawer-${item.title}`"
            :class="{ active: task.selectedStrategies[0] === item.title, recommended: item.recommended }"
            @click="toggleRecommendedStrategy(item.title)"
          >
            <span>{{ item.group }}</span>
            <strong>{{ item.title }}</strong>
          </article>
        </div>
      </section>

      <section class="prompt-readonly prompt-preview-card">
        <div class="drawer-section-head">
          <h3>最终 Prompt</h3>
          <el-button class="erp-btn erp-btn-secondary" size="small" @click="previewPrompt">重新拼接</el-button>
        </div>
        <div class="advanced-template-picker">
          <span>图片风格 / 模板</span>
          <el-select v-model="selectedTemplateId" placeholder="自动匹配模板" clearable>
            <el-option v-for="item in enabledTemplates" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </div>
        <div class="prompt-preview-grid">
          <article>
            <strong>正向 Prompt</strong>
            <div class="prompt-line-list workbench-prompt-line-list">
              <p v-for="row in workbenchPositivePromptRows" :key="`workbench-positive-${row.source}-${row.line}`">
                <span>{{ row.source }}</span>
                <em>{{ row.line }}</em>
              </p>
            </div>
          </article>
          <article>
            <strong>负向 Prompt</strong>
            <div class="prompt-line-list workbench-prompt-line-list">
              <p v-for="row in workbenchNegativePromptRows" :key="`workbench-negative-${row.source}-${row.line}`">
                <span>{{ row.source }}</span>
                <em>{{ row.line }}</em>
              </p>
            </div>
          </article>
        </div>
      </section>

      <el-collapse class="strategy-advanced-collapse">
        <el-collapse-item title="高级编辑" name="advanced">
          <el-input v-model="promptEditorState.positivePrompt" type="textarea" :rows="7" placeholder="正向Prompt，留空则使用模块化拼接" />
          <el-input v-model="promptEditorState.negativePrompt" class="mt-10" type="textarea" :rows="5" placeholder="负向Prompt，留空则使用负向规则" />
          <el-input v-model="promptEditorState.variablesJson" class="mt-10" type="textarea" :rows="5" placeholder="变量JSON" />
          <div class="advanced-actions">
            <el-button class="erp-btn erp-btn-secondary" @click="promptEditorState.positivePrompt = ''; promptEditorState.negativePrompt = ''">恢复模块化Prompt</el-button>
            <el-button class="erp-btn erp-btn-primary" type="primary" @click="saveCurrentAsTemplate">保存为模板</el-button>
          </div>
        </el-collapse-item>
        <el-collapse-item title="AI生成日志" name="logs">
          <div v-for="log in logs" :key="`${log.time}-${log.message}`" class="log-item">
            <strong>{{ log.model }} · {{ log.status }}</strong>
            <span>{{ log.time }}</span>
            <p>{{ log.message }}</p>
          </div>
          <el-empty v-if="!logs.length" description="暂无生成日志" />
        </el-collapse-item>
      </el-collapse>
    </el-drawer>

    <el-dialog v-model="strategyLibraryVisible" title="GOAL / PLAN编辑" width="1280px" class="goal-plan-dialog" align-center>
      <section class="goal-plan-workbench">
        <section class="goal-plan-context">
          <article>
            <span>当前类目</span>
            <strong>{{ categoryTreeStatus.category }}</strong>
            <em>{{ categoryTreeStatus.treeName }}</em>
          </article>
          <article>
            <span>当前 GOAL</span>
            <strong>{{ editorSelectedGoal.title }}</strong>
            <em>{{ editorSelectedGoal.text }}</em>
          </article>
          <article>
            <span>当前 PLAN</span>
            <strong>{{ activePlanCards.length }} 个策略</strong>
            <em>{{ categoryTreeStatus.description }}</em>
          </article>
        </section>

        <section class="goal-plan-columns unified-goal-plan-columns">
          <aside class="strategy-select-panel">
            <header class="strategy-panel-head">
              <div>
                <strong>策略树</strong>
                <span>默认通用，可编辑为当前类目覆盖配置</span>
              </div>
              <div class="strategy-panel-actions">
                <el-button class="icon-action" size="small" @click="openStrategyNodeDialog('tree', editorSelectedTree)">编辑</el-button>
                <el-button class="icon-action danger" size="small" @click="deleteSelectedTree">删除</el-button>
              </div>
            </header>
            <div class="strategy-panel-summary">
              <strong>{{ categoryTreeStatus.treeName }}</strong>
              <span>{{ categoryTreeStatus.description }}</span>
            </div>
            <section class="strategy-option-list">
              <button class="strategy-option-card active">
                <strong>{{ categoryTreeStatus.treeName }}</strong>
                <span>{{ categoryTreeStatus.mode }}</span>
              </button>
              <button class="strategy-option-card">
                <strong>
                  通用类目树
                  <el-tooltip content="所有未配置专属类目树的类目，默认使用这套通用 GOAL / PLAN。" placement="top">
                    <span class="tree-help">?</span>
                  </el-tooltip>
                </strong>
                <span>默认通用</span>
              </button>
            </section>
          </aside>

          <main class="strategy-select-panel">
            <header class="strategy-panel-head">
              <div>
                <strong>GOAL</strong>
                <span>选择 AI 要解决的问题</span>
              </div>
              <div class="strategy-panel-actions">
                <el-button class="icon-action" size="small" @click="openStrategyNodeDialog('goal')">新增</el-button>
                <el-button class="icon-action" size="small" @click="openStrategyNodeDialog('goal', editorSelectedGoal)">编辑</el-button>
                <el-button class="icon-action danger" size="small" @click="deleteSelectedGoal">删除</el-button>
              </div>
            </header>
            <div class="strategy-panel-summary">
              <el-tabs v-model="strategyEditorMode" class="goal-editor-tabs">
                <el-tab-pane label="商品优化" name="optimization" />
                <el-tab-pane label="商品裂变" name="variant" />
              </el-tabs>
              <span>{{ editorCurrentGoalGroup?.subtitle || "选择后会刷新右侧 PLAN。" }}</span>
            </div>
            <section class="strategy-option-list">
              <template v-for="group in goalPlanGroups.filter((item) => item.modeKey === strategyEditorMode)" :key="group.modeKey">
                <div class="strategy-list-caption">
                  <strong>{{ group.title }}</strong>
                  <span>{{ group.subtitle }}</span>
                </div>
                <button
                  v-for="item in group.items"
                  :key="`goal-card-${item.key}`"
                  class="strategy-option-card"
                  :class="{ active: item.active }"
                  @click="selectEditorGoal(item)"
                >
                  <strong>{{ item.title }}</strong>
                  <span>{{ item.text }}</span>
                </button>
              </template>
            </section>
          </main>

          <aside class="strategy-select-panel">
            <header class="strategy-panel-head">
              <div>
                <strong>PLAN</strong>
                <span>当前 GOAL 下的生成策略</span>
              </div>
              <div class="strategy-panel-actions">
                <el-button class="icon-action" size="small" @click="openStrategyNodeDialog('plan')">新增</el-button>
                <el-button class="icon-action" size="small" @click="openStrategyNodeDialog('plan', editorSelectedPlan)">编辑</el-button>
                <el-button class="icon-action danger" size="small" @click="deleteSelectedPlan">删除</el-button>
              </div>
            </header>
            <div class="strategy-panel-summary">
              <strong>{{ editorSelectedPlan?.title || "未选择 PLAN" }}</strong>
              <span>{{ activePlanCards.length }} 个策略，可按当前 GOAL 单独覆盖。</span>
            </div>
            <section class="strategy-option-list">
              <button
                v-for="item in activePlanCards"
                :key="`plan-card-${item.title}`"
                class="strategy-option-card plan-option-card"
                :class="{ active: item.active, recommended: item.recommended }"
                @click="selectEditorPlan(item.title)"
              >
                <em>#{{ item.order }}</em>
                <div>
                  <strong>{{ item.title }}</strong>
                  <span>{{ item.recommended ? "推荐策略" : "可选策略" }} · Prompt模块 {{ item.promptCount }}</span>
                </div>
              </button>
            </section>
          </aside>
        </section>

        <section v-if="false" class="goal-plan-columns">
          <aside class="tree-column">
            <div class="column-head">
              <strong>策略树</strong>
              <span>默认通用，可沉淀专属类目树</span>
            </div>
            <button class="tree-card active">
              <strong>{{ categoryTreeStatus.treeName }}</strong>
              <span>{{ categoryTreeStatus.mode }}</span>
            </button>
            <button class="tree-card">
              <strong>
                通用类目树
                <el-tooltip content="所有未配置专属类目树的类目，都会默认使用这套通用 GOAL / PLAN。" placement="top">
                  <span class="tree-help">?</span>
                </el-tooltip>
              </strong>
              <span>默认通用</span>
            </button>
            <el-button class="erp-btn erp-btn-secondary" type="primary" plain @click="openStrategyNodeDialog('tree')">
              {{ hasSpecificCategoryTree ? "编辑当前类目树" : "创建当前类目树" }}
            </el-button>
          </aside>

          <main class="goal-column">
            <div class="column-head">
              <strong>GOAL</strong>
              <span>选择 AI 要解决的问题</span>
            </div>
            <el-tabs v-model="strategyEditorMode" class="goal-editor-tabs">
              <el-tab-pane label="商品优化" name="optimization" />
              <el-tab-pane label="商品裂变" name="variant" />
            </el-tabs>
            <section v-for="group in goalPlanGroups.filter((item) => item.modeKey === strategyEditorMode)" :key="group.modeKey" class="goal-group">
              <div>
                <strong>{{ group.title }}</strong>
                <span>{{ group.subtitle }}</span>
              </div>
              <button
                v-for="item in group.items"
                :key="`goal-edit-${item.key}`"
                :class="{ active: item.active }"
                @click="selectEditorGoal(item)"
              >
                <strong>{{ item.title }}</strong>
                <span>{{ item.text }}</span>
                <small class="node-edit-action" @click.stop="openStrategyNodeDialog('goal', item)">编辑</small>
              </button>
              <button class="add-card" @click="openStrategyNodeDialog('goal')">
                <strong>+ 自定义</strong>
              </button>
            </section>
          </main>

          <aside class="plan-column">
            <div class="column-head">
              <strong>PLAN</strong>
              <span>当前 GOAL 下的生成策略</span>
            </div>
            <button
              v-for="item in activePlanCards"
              :key="`plan-edit-${item.title}`"
              :class="{ active: item.active, recommended: item.recommended }"
              @click="selectEditorPlan(item.title)"
            >
              <em>#{{ item.order }}</em>
              <div>
                <strong>{{ item.title }}</strong>
                <span>{{ item.recommended ? "推荐策略" : "可选策略" }} · Prompt模块 {{ item.promptCount }}</span>
                <small class="node-edit-action" @click.stop="openStrategyNodeDialog('plan', item)">编辑</small>
              </div>
            </button>
            <button class="add-card" @click="openStrategyNodeDialog('plan')">
              <strong>+ 自定义</strong>
            </button>
          </aside>
        </section>

        <section class="goal-plan-preview">
          <div class="column-head">
            <strong>Prompt 组合预览</strong>
            <span>预览当前策略树、GOAL 和 PLAN 拼接后的执行方向</span>
          </div>
          <div class="prompt-preview-grid">
            <article>
              <strong>正向 Prompt</strong>
              <div class="prompt-line-list">
                <p v-for="row in editorPositivePromptRows" :key="`positive-${row.source}-${row.line}`">
                  <span>{{ row.source }}</span>
                  <em>{{ row.line }}</em>
                </p>
              </div>
            </article>
            <article>
              <strong>负向 Prompt</strong>
              <div class="prompt-line-list">
                <p v-for="row in editorNegativePromptRows" :key="`negative-${row.source}-${row.line}`">
                  <span>{{ row.source }}</span>
                  <em>{{ row.line }}</em>
                </p>
              </div>
            </article>
          </div>
        </section>
      </section>

      <el-collapse v-if="false" class="advanced-strategy-library">
        <el-collapse-item title="高级策略库" name="advanced-strategy-library">
      <section class="template-center strategy-library">
        <aside class="template-browser">
          <div class="template-search">
            <el-input v-model="strategyLibrarySearch" placeholder="搜索策略 / Prompt模块" clearable />
            <el-select v-model="strategyLibraryGoal" placeholder="适用目标" clearable>
              <el-option v-for="item in strategyGoalOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </div>
          <button
            v-for="item in filteredStrategyRows"
            :key="item.id"
            :class="{ active: strategyForm.id === item.id }"
            @click="selectStrategyForEdit(item)"
          >
            <strong>{{ item.title }}</strong>
            <span>{{ item.strategy_key }} · P{{ item.priority }} · v{{ item.version }}</span>
            <em>{{ item.enabled ? "启用" : "停用" }}</em>
          </button>
          <el-empty v-if="!filteredStrategyRows.length" description="暂无策略" />
        </aside>

        <main v-loading="strategyLibraryLoading" class="template-editor">
          <div class="editor-head">
            <strong>{{ strategyForm.id ? "编辑策略" : "新增策略" }}</strong>
            <div>
              <el-button class="erp-btn erp-btn-secondary" @click="newStrategy">新增</el-button>
              <el-button class="erp-btn erp-btn-danger" :disabled="!strategyForm.id" type="danger" plain @click="removeStrategy(strategyForm)">停用</el-button>
              <el-button class="erp-btn erp-btn-primary" type="primary" :loading="savingStrategy" @click="saveStrategy">保存</el-button>
            </div>
          </div>
          <el-form label-position="top">
            <div class="two-col">
              <el-form-item label="策略Key">
                <el-input v-model="strategyForm.strategy_key" placeholder="main-subject-70" />
              </el-form-item>
              <el-form-item label="策略名称">
                <el-input v-model="strategyForm.title" placeholder="主体占比70%" />
              </el-form-item>
            </div>
            <div class="two-col">
              <el-form-item label="业务模式">
                <el-select v-model="strategyForm.business_modes" multiple>
                  <el-option v-for="item in strategyBusinessModeOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </el-form-item>
              <el-form-item label="适用目标">
                <el-select v-model="strategyForm.applicable_goals" multiple filterable>
                  <el-option v-for="item in strategyGoalOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </el-form-item>
            </div>
            <div class="two-col">
              <el-form-item label="适用资产">
                <el-select v-model="strategyForm.applicable_assets" multiple>
                  <el-option v-for="item in strategyAssetOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </el-form-item>
              <el-form-item label="冲突策略">
                <el-select v-model="strategyForm.conflict_strategy_keys" multiple filterable allow-create default-first-option>
                  <el-option v-for="item in strategyLibraryRows" :key="item.strategy_key" :label="item.title" :value="item.strategy_key" />
                </el-select>
              </el-form-item>
            </div>
            <div class="two-col">
              <el-form-item label="优先级">
                <el-input-number v-model="strategyForm.priority" :min="-999" :max="999" />
              </el-form-item>
              <el-form-item label="版本号">
                <el-input-number v-model="strategyForm.version" :min="1" :max="999" />
              </el-form-item>
            </div>
            <el-form-item label="别名 / 兼容旧策略名">
              <el-input v-model="strategyForm.aliases_text" type="textarea" :rows="3" placeholder="一行一个，也支持逗号分隔" />
            </el-form-item>
            <el-form-item label="正向Prompt模块">
              <el-input v-model="strategyForm.positive_modules_text" type="textarea" :rows="7" placeholder="一行一个执行指令，会合并进最终Prompt" />
            </el-form-item>
            <el-form-item label="负向Prompt模块">
              <el-input v-model="strategyForm.negative_modules_text" type="textarea" :rows="4" placeholder="一行一个禁止项，会合并进负向Prompt" />
            </el-form-item>
            <el-form-item label="元数据JSON">
              <el-input v-model="strategyForm.metadata_json" type="textarea" :rows="3" />
            </el-form-item>
            <div class="template-switches">
              <el-switch v-model="strategyForm.enabled" active-text="启用" inactive-text="停用" />
            </div>
          </el-form>
        </main>
      </section>
        </el-collapse-item>
      </el-collapse>
    </el-dialog>

    <el-dialog v-model="strategyNodeDialogVisible" :title="strategyNodeDialogTitle" width="760px" class="strategy-node-dialog" align-center>
      <el-form label-position="top">
        <div class="two-col">
          <el-form-item label="名称">
            <el-input v-model="strategyNodeForm.title" placeholder="例如：提升点击率 / 主图主体强化" />
          </el-form-item>
          <el-form-item label="说明">
            <el-input v-model="strategyNodeForm.text" placeholder="简短说明这个配置要解决的问题" />
          </el-form-item>
          <el-form-item label="唯一标识（系统用）">
            <el-input v-model="strategyNodeForm.key" :disabled="strategyNodeMode === 'tree' && Boolean(currentLayerRule?.id)" placeholder="可不填，系统会按名称自动生成；用于保存、绑定和排序" />
            <small class="field-help">这个值只用于系统识别 GOAL / PLAN，不影响页面展示名称。</small>
          </el-form-item>
        </div>
        <el-form-item v-if="false" label="说明">
          <el-input v-model="strategyNodeForm.text" placeholder="简短说明这个 GOAL 要解决的问题" />
        </el-form-item>
        <el-form-item label="正向 Prompt">
          <el-input
            v-model="strategyNodeForm.positivePrompt"
            type="textarea"
            :rows="8"
            placeholder="一行一个策略模块，保存后会参与最终 Prompt 拼接"
          />
        </el-form-item>
        <el-form-item label="负向 Prompt">
          <el-input
            v-model="strategyNodeForm.negativePrompt"
            type="textarea"
            :rows="5"
            placeholder="一行一个禁止项；系统会自动保留 No Chinese text or Chinese characters."
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button class="erp-btn erp-btn-secondary" @click="strategyNodeDialogVisible = false">取消</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" :loading="strategyNodeSaving" @click="saveStrategyNode">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="templateCenterVisible" title="图片风格配置" size="860px">
      <section class="template-center">
        <aside class="template-browser">
          <div class="template-search">
            <el-input v-model="templateSearch" placeholder="搜索模板" clearable />
            <el-select v-model="templateCategory" placeholder="分类" clearable>
              <el-option v-for="item in sceneOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </div>
          <button v-for="item in filteredTemplates" :key="item.id" :class="{ active: templateForm.id === item.id }" @click="selectTemplateForEdit(item)">
            <strong>{{ item.name }}</strong>
            <span>{{ item.scene }} · v1 · {{ item.enabled ? "启用" : "停用" }}</span>
            <em v-if="item.is_default">默认</em>
          </button>
          <el-empty v-if="!filteredTemplates.length" description="暂无模板" />
        </aside>

        <main class="template-editor">
          <div class="editor-head">
            <strong>{{ templateForm.id ? "编辑模板" : "新增模板" }}</strong>
            <div>
              <el-button class="erp-btn erp-btn-secondary" @click="newTemplate">新增</el-button>
              <el-button class="erp-btn erp-btn-secondary" :disabled="!templateForm.id" @click="copyTemplate(templateForm)">复制</el-button>
              <el-button class="erp-btn erp-btn-secondary" :disabled="!templateForm.id" @click="makeDefault(templateForm)">默认</el-button>
              <el-button class="erp-btn erp-btn-danger" :disabled="!templateForm.id" type="danger" plain @click="removeTemplate(templateForm)">删除</el-button>
              <el-button class="erp-btn erp-btn-primary" type="primary" :loading="savingTemplate" @click="saveTemplate">保存</el-button>
            </div>
          </div>
          <el-form label-position="top">
            <el-form-item label="模板名称"><el-input v-model="templateForm.name" /></el-form-item>
            <div class="two-col">
              <el-form-item label="分类">
                <el-select v-model="templateForm.scene">
                  <el-option v-for="item in sceneOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </el-form-item>
              <el-form-item label="模式">
                <el-select v-model="templateForm.mode">
                  <el-option v-for="item in modeOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </el-form-item>
            </div>
            <div class="two-col">
              <el-form-item label="默认比例"><el-segmented v-model="templateForm.default_ratio" :options="ratioOptions" /></el-form-item>
              <el-form-item label="默认张数"><el-input-number v-model="templateForm.default_count" :min="1" :max="8" /></el-form-item>
            </div>
            <el-form-item label="说明"><el-input v-model="templateForm.description" /></el-form-item>
            <el-form-item label="正向Prompt"><el-input v-model="templateForm.positive_prompt" type="textarea" :rows="8" /></el-form-item>
            <el-form-item label="负向Prompt"><el-input v-model="templateForm.negative_prompt" type="textarea" :rows="5" /></el-form-item>
            <el-form-item label="主图 Prompt"><el-input v-model="templateForm.main_image_prompt" type="textarea" :rows="5" /></el-form-item>
            <el-form-item label="详情图 Prompt JSON"><el-input v-model="templateForm.detail_image_prompt_json" type="textarea" :rows="6" /></el-form-item>
            <el-form-item label="标题 Prompt"><el-input v-model="templateForm.title_prompt" type="textarea" :rows="5" /></el-form-item>
            <el-form-item label="标签 Prompt"><el-input v-model="templateForm.tags_prompt" type="textarea" :rows="5" /></el-form-item>
            <el-form-item label="描述 Prompt"><el-input v-model="templateForm.description_prompt" type="textarea" :rows="6" /></el-form-item>
            <el-form-item label="变量JSON"><el-input v-model="templateForm.variables_json" type="textarea" :rows="4" /></el-form-item>
            <div class="template-switches">
              <el-switch v-model="templateForm.enabled" active-text="启用" inactive-text="停用" />
              <el-switch v-model="templateForm.is_default" active-text="默认模板" inactive-text="非默认" />
            </div>
          </el-form>
        </main>
      </section>
    </el-drawer>
  </div>
</template>

<style scoped>
.visual-workbench {
  min-height: 100%;
  padding: 16px 18px 24px;
  background: linear-gradient(180deg, #f6f9ff 0%, #eef3f9 100%);
  color: #101828;
}

.reference-upload-input {
  display: none;
}

.workbench-topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: none;
  margin: -16px auto 14px;
  padding: 14px 0 12px;
  background: rgba(246, 249, 255, 0.92);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}

.workbench-topbar h1 {
  margin: 0;
  font-size: 25px;
}

.workbench-topbar p {
  margin: 6px 0 0;
  color: #667085;
}

.topbar-actions,
.canvas-tools,
.quick-row,
.asset-actions,
.advanced-actions,
.template-switches {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.workbench-flow {
  display: grid;
  gap: 14px;
  width: 100%;
  max-width: none;
  margin: 0 auto;
}

.workbench-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto minmax(560px, 1fr);
  gap: 16px;
  align-items: start;
  min-height: 0;
}

.config-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 0;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.07);
}

.product-card,
.target-card {
  align-content: start;
}

.product-card {
  grid-column: 1;
  grid-row: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
  overflow: visible;
  align-content: start;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

.product-context-card {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) 156px;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 12px;
  height: 100%;
  min-height: 196px;
  padding: 14px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.07);
}

.context-thumb {
  grid-row: 1;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: 18px;
  background:
    linear-gradient(90deg, rgba(148, 163, 184, 0.10) 1px, transparent 1px),
    linear-gradient(180deg, rgba(148, 163, 184, 0.10) 1px, transparent 1px),
    #f8fbff;
  background-size: 18px 18px;
}

.context-thumb :deep(.el-image) {
  width: 100%;
  height: 100%;
}

.context-thumb :deep(.erp-image-preview) {
  width: 108px;
  min-width: 108px;
  max-width: 108px;
  height: 144px;
  min-height: 144px;
  max-height: 144px;
  flex-basis: 108px;
  border-radius: 10px;
}

.context-empty-thumb {
  display: grid;
  gap: 6px;
  place-items: center;
  color: #98a2b3;
  font-size: 12px;
}

.context-info {
  min-width: 0;
}

.context-info > strong {
  display: block;
  overflow: hidden;
  color: #101828;
  font-size: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 12px;
  margin-top: 10px;
}

.context-grid p {
  display: grid;
  gap: 2px;
  min-width: 0;
  margin: 0;
}

.context-grid span,
.context-status-bar span {
  color: #667085;
  font-size: 11px;
}

.context-grid em {
  overflow: hidden;
  color: #344054;
  font-size: 11px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-actions {
  display: grid;
  gap: 8px;
  align-content: start;
}

.context-actions .el-button {
  width: 100%;
  justify-content: center;
}

.context-status-bar {
  grid-column: 1 / -1;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 14px;
  background: #f8fbff;
}

.context-status-bar :deep(.el-checkbox) {
  margin-left: auto;
}

.product-summary-strip {
  display: grid;
  grid-template-columns: 1.25fr 1fr 1fr 1fr 1.45fr;
  gap: 8px;
}

.product-summary-strip p {
  display: grid;
  gap: 3px;
  min-width: 0;
  margin: 0;
  padding: 6px 9px;
  border-radius: 12px;
  background: #f8fbff;
}

.product-summary-strip span {
  color: #667085;
  font-size: 11px;
}

.product-summary-strip strong {
  overflow: hidden;
  color: #344054;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.strategy-config-band {
  grid-column: 1;
  grid-row: 2;
  display: grid;
  grid-template-columns: minmax(260px, 0.78fr) minmax(340px, 0.92fr) minmax(520px, 1.5fr);
  gap: 14px;
  min-width: 0;
  min-height: 0;
  align-items: stretch;
}

.canvas-area {
  grid-column: 1;
  grid-row: 3;
}

.ai-flow-card {
  display: grid;
  gap: 10px;
  align-content: start;
  min-height: 300px;
  padding: 14px;
  border: 0;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06);
}

.flow-step-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-height: 28px;
}

.flow-step-head > span {
  padding: 5px 9px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 12px;
  font-weight: 800;
}

.flow-step-head strong {
  display: block;
  color: #101828;
  font-size: 15px;
}

.hero-objective-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  align-content: start;
}

.commerce-mode-stack,
.commerce-mode-card {
  display: grid;
  gap: 0;
}

.commerce-mode-card {
  padding: 0;
  border-radius: 0;
  background: transparent;
}

.hero-objective-grid button {
  display: grid;
  align-content: start;
  gap: 6px;
  min-height: 72px;
  padding: 10px;
  border: 1px solid #e4eaf2;
  border-radius: 12px;
  background: linear-gradient(180deg, #fff 0%, #f9fbff 100%);
  color: #344054;
  text-align: left;
  cursor: pointer;
}

.hero-objective-grid button.active {
  border-color: #409eff;
  background: linear-gradient(180deg, #eef6ff 0%, #fff 100%);
  color: #175cd3;
  box-shadow: 0 12px 28px rgba(64, 158, 255, 0.16);
}

.hero-objective-grid span {
  color: #667085;
  font-size: 11px;
}

.hero-objective-grid strong {
  font-size: 15px;
}

.recommendation-card {
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.08), rgba(18, 183, 106, 0.06)),
    #fff;
}

.recommendation-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  align-content: start;
}

.recommendation-list button {
  display: grid;
  align-content: start;
  gap: 6px;
  min-height: 60px;
  padding: 10px;
  border: 1px solid #e4eaf2;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.86);
  color: #344054;
  text-align: left;
  cursor: pointer;
}

.recommendation-list button.active {
  border-color: #409eff;
  background: #eef6ff;
  color: #175cd3;
}

.recommendation-list button.recommended:not(.active) {
  border-color: #bfdbfe;
}

.recommendation-list button span {
  color: #667085;
  font-size: 11px;
}

.recommendation-list button strong {
  font-size: 14px;
}

.output-card {
  align-content: start;
}

.card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.card-title span {
  display: block;
  margin-top: 3px;
  color: #667085;
  font-size: 12px;
  font-weight: 400;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.field-preferences {
  display: grid;
  gap: 10px;
}

.field-preferences-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-preferences :deep(.el-checkbox-group) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 10px;
}

.source-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}

.product-info-dialog :deep(.el-dialog__body) {
  padding-top: 8px;
}

.product-info-editor {
  display: grid;
  gap: 14px;
  max-height: min(74vh, 760px);
  overflow: auto;
  padding-right: 4px;
}

.product-info-template-layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.product-info-preview-panel,
.product-info-template-form {
  display: grid;
  gap: 14px;
}

.product-info-overview {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
  padding: 12px;
  border: 1px solid #e4eaf2;
  border-radius: 12px;
  background: #f8fbff;
}

.product-info-overview :deep(.erp-image-preview) {
  width: 88px;
  height: 88px;
  border-radius: 10px;
  background: #eef2f7;
}

.product-info-overview span,
.product-info-overview p {
  color: #667085;
  font-size: 13px;
}

.product-info-overview strong {
  display: block;
  margin: 4px 0;
  color: #101828;
  font-size: 18px;
}

.product-info-template-overview {
  position: sticky;
  top: 0;
}

.product-info-template-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid #e4eaf2;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
}

.template-card-head {
  display: grid;
  gap: 4px;
}

.template-card-head strong {
  color: #101828;
  font-size: 16px;
}

.template-card-head span {
  color: #667085;
  font-size: 12px;
  line-height: 1.5;
}

.template-fact-list {
  display: grid;
  gap: 10px;
}

.template-fact-item {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 12px;
  background: #f8fbff;
  border: 1px solid #edf2fa;
}

.template-fact-item span {
  color: #667085;
  font-size: 12px;
}

.template-fact-item strong {
  color: #101828;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.product-info-form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  overflow: visible;
  padding: 0;
}

.product-info-actions {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 0 0 10px;
  border-bottom: 1px solid #edf1f7;
  background: #fff;
}

.product-info-template-form.readonly {
  opacity: 0.78;
}

.product-info-template-form.readonly :deep(.el-input),
.product-info-template-form.readonly :deep(.el-textarea),
.product-info-template-form.readonly :deep(.el-input-number),
.product-info-template-form.readonly :deep(.el-select) {
  pointer-events: none;
}

.product-card > .card-title,
.product-card > .product-summary-strip,
.product-card > .source-field-grid,
.product-card > .category-tree-card,
.product-card > .ai-plan-card {
  display: none;
}

.product-card > .more-fields-collapse {
  display: none;
}

.product-card > .product-context-card {
  grid-column: 1;
}

.product-card > .el-alert {
  grid-column: 1;
  margin: 0 4px;
}

.current-assets-card,
.more-fields-collapse {
  border: 1px solid #edf1f7;
  border-radius: 14px;
  background: #fbfdff;
}

.current-assets-card {
  display: grid;
  gap: 8px;
  padding: 10px;
}

.product-card > .current-assets-card {
  display: none;
}

.featured-assets {
  order: 0;
  padding: 12px;
  border: 0;
  background:
    linear-gradient(180deg, rgba(64, 158, 255, 0.08), rgba(255, 255, 255, 0.96)),
    #fff;
  box-shadow: 0 18px 42px rgba(15, 23, 42, 0.08);
}

.current-assets-head,
.current-asset-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.current-asset-actions {
  justify-content: flex-start;
  padding-top: 2px;
}

.ai-plan-card {
  display: grid;
  grid-template-columns: minmax(180px, 0.72fr) minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 16px;
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.12), rgba(18, 183, 106, 0.08)),
    #fff;
  box-shadow: inset 0 0 0 1px rgba(64, 158, 255, 0.08);
}

.ai-plan-card span {
  display: block;
  color: #175cd3;
  font-size: 11px;
  font-weight: 800;
}

.ai-plan-card strong {
  display: block;
  margin-top: 3px;
  color: #101828;
  font-size: 13px;
}

.ai-plan-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.current-assets-head strong {
  display: block;
}

.current-assets-head span {
  display: block;
  margin-top: 3px;
  color: #667085;
  font-size: 11px;
}

.current-assets-body {
  display: grid;
  grid-template-columns: 108px minmax(0, 1fr);
  gap: 8px;
  align-items: stretch;
}

.featured-assets-body {
  grid-template-columns: 104px minmax(0, 1fr);
}

.current-thumb {
  display: grid;
  place-items: center;
  min-height: 132px;
  overflow: hidden;
  border-radius: 12px;
  background: #eef4fb;
  color: #98a2b3;
}

.featured-assets .current-thumb {
  min-height: 88px;
  border-radius: 14px;
  background:
    linear-gradient(90deg, rgba(148, 163, 184, 0.10) 1px, transparent 1px),
    linear-gradient(180deg, rgba(148, 163, 184, 0.10) 1px, transparent 1px),
    #f8fbff;
  background-size: 22px 22px;
}

.compact-empty-thumb {
  display: grid;
  gap: 5px;
  place-items: center;
  padding: 8px;
  color: #667085;
  font-size: 11px;
  text-align: center;
}

.current-thumb :deep(.el-image) {
  width: 100%;
  height: 100%;
}

.current-asset-meta {
  display: grid;
  gap: 4px;
}

.current-asset-meta p {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 6px;
  margin: 0;
  font-size: 11px;
}

.current-asset-meta span {
  color: #667085;
}

.current-asset-meta strong {
  overflow: hidden;
  color: #344054;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-mini-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.asset-mini-thumb {
  display: grid;
  gap: 5px;
  place-items: center;
  min-height: 42px;
  border-radius: 12px;
  background: #f4f8fd;
  color: #98a2b3;
  font-size: 11px;
}

.more-fields-collapse {
  padding: 0 10px;
}

.more-fields-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding-bottom: 10px;
}

.source-field {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 9px;
  border: 1px solid #edf1f7;
  border-radius: 12px;
  background: #fbfdff;
}

.source-field.wide {
  grid-column: 1 / -1;
}

.source-field > span {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.source-field > span strong {
  color: #344054;
  font-size: 12px;
}

.source-field > span em {
  overflow: hidden;
  color: #98a2b3;
  font-size: 11px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inline-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.inline-fields.package-fields {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }

.mode-grid button,
.style-grid button,
.template-browser button {
  border: 1px solid #e4eaf2;
  border-radius: 12px;
  background: #fff;
  color: #344054;
  text-align: left;
  cursor: pointer;
}

.mode-grid button {
  padding: 10px;
}

.mode-grid button strong,
.mode-grid button span {
  display: block;
}

.mode-grid button span {
  margin-top: 3px;
  color: #667085;
  font-size: 12px;
}

.mode-grid button.active,
.style-grid button.active,
.template-browser button.active {
  border-color: #409eff;
  background: #eef6ff;
  color: #175cd3;
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.12);
}

.config-select {
  width: 100%;
}

.option-row {
  display: grid;
  gap: 2px;
  line-height: 1.25;
}

.option-row span {
  color: #667085;
  font-size: 12px;
}

.selected-config-card {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid #d7e8ff;
  border-radius: 12px;
  background: #f4f9ff;
  color: #175cd3;
}

.selected-config-card.compact {
  background: #fbfdff;
  color: #344054;
}

.selected-config-card span {
  color: #667085;
  font-size: 12px;
}

.objective-groups,
.objective-group {
  display: grid;
  gap: 8px;
}

.objective-group + .objective-group {
  margin-top: 12px;
}

.objective-group-title,
.asset-check-group > span {
  color: #667085;
  font-size: 12px;
  font-weight: 700;
}

.objective-button,
.strategy-chip-grid button {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid #e4eaf2;
  border-radius: 12px;
  background: #fff;
  color: #344054;
  text-align: left;
  cursor: pointer;
}

.strategy-chip-grid button {
  min-height: 70px;
  border-radius: 16px;
  background: linear-gradient(180deg, #fff 0%, #fbfdff 100%);
}

.objective-button span,
.strategy-chip-grid button span {
  color: #667085;
  font-size: 12px;
}

.objective-button.active,
.strategy-chip-grid button.active {
  border-color: #409eff;
  background: #eef6ff;
  color: #175cd3;
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.12);
}

.strategy-chip-grid button.active {
  box-shadow: 0 12px 24px rgba(64, 158, 255, 0.14);
}

.strategy-chip-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.style-bias-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.style-bias-grid button {
  min-height: 48px;
  padding: 9px 8px;
  text-align: center;
}

.config-tabs-card {
  min-height: 0;
}

.config-tabs {
  min-height: 0;
}

.config-tabs :deep(.el-tabs__header) {
  margin-bottom: 10px;
}

.config-tabs :deep(.el-tab-pane) {
  display: grid;
  gap: 10px;
}

.target-tab-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.target-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 24px;
  max-height: 96px;
  overflow: auto;
  padding: 2px;
}

.target-empty {
  color: #98a2b3;
  font-size: 12px;
  line-height: 24px;
}

.target-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 64px;
  gap: 8px;
  align-items: start;
}

.quick-row {
  gap: 6px;
}

.quick-row .el-button {
  padding: 6px 8px;
}

.style-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.style-grid button {
  padding: 9px 10px;
  text-align: center;
}

.output-checks,
.asset-check-groups {
  display: grid;
  gap: 8px;
}

.asset-check-groups {
  grid-template-columns: 1fr;
}

.asset-check-group {
  display: grid;
  gap: 8px;
  padding: 8px;
  border: 1px solid #edf1f7;
  border-radius: 12px;
  background: #fbfdff;
}

.asset-check-group :deep(.el-checkbox-group) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 8px;
}

.target-card {
  min-height: 0;
  overflow: auto;
}

.asset-check-group > span {
  color: #667085;
  font-size: 12px;
  font-weight: 800;
}

.detail-type-picker {
  display: grid;
  gap: 6px;
  padding: 8px;
  border-radius: 10px;
  background: #f4f9ff;
}

.detail-type-picker em,
.writeback-auto-group p,
.writeback-tags span {
  margin: 0;
  color: #667085;
  font-size: 12px;
  font-style: normal;
}

.writeback-auto-group {
  align-content: start;
}

.writeback-mode-group {
  align-content: start;
}

.selection-writeback-modes {
  width: 100%;
}

.selection-writeback-modes :deep(.el-radio-button) {
  flex: 1;
}

.selection-writeback-modes :deep(.el-radio-button__inner) {
  width: 100%;
}

.selection-writeback-mode-list {
  display: grid;
  gap: 8px;
}

.selection-writeback-mode-list article {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #ffffff;
}

.selection-writeback-mode-list article.active {
  border-color: #7c3aed;
  background: #faf5ff;
  box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.08);
}

.selection-writeback-mode-list strong {
  color: #344054;
  font-size: 13px;
}

.selection-writeback-mode-list p,
.selection-writeback-mode-help {
  margin: 0;
  color: #667085;
  font-size: 12px;
  line-height: 1.5;
}

.selection-writeback-mode-help {
  padding: 8px 10px;
  border-radius: 10px;
  background: #fff7ed;
  color: #9a3412;
}

.writeback-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: flex-start;
  min-width: 0;
}

.writeback-tags :deep(.el-tag) {
  max-width: 100%;
  white-space: normal;
  word-break: break-word;
}

.sticky-actions {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  position: static;
  padding: 8px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.97);
  align-self: stretch;
  align-content: center;
  box-shadow: 0 12px 24px rgba(15, 23, 42, 0.08);
}

.canvas-area {
  min-width: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 420px;
}

.canvas-status,
.canvas-frame {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06);
}

.canvas-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.generation-config-workbench {
  display: grid;
  gap: 10px;
  min-height: 0;
  min-height: 300px;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.08), rgba(18, 183, 106, 0.05)),
    rgba(255, 255, 255, 0.96);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06);
}

.generation-config-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}

.generation-config-head > div:first-child {
  display: grid;
  gap: 2px;
}

.generation-config-head span {
  width: fit-content;
  padding: 3px 8px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 11px;
  font-weight: 800;
}

.generation-config-head strong {
  color: #101828;
  font-size: 15px;
}

.inline-style-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

.inline-output-layout {
  display: grid;
  grid-template-columns: minmax(280px, 0.82fr) minmax(0, 1.18fr);
  gap: 10px;
  align-items: start;
}

.inline-output-layout.text-output-layout {
  grid-template-columns: minmax(300px, 0.78fr) minmax(0, 1.22fr);
}

.inline-targets {
  display: grid;
  gap: 8px;
}

.text-targets-panel {
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.72);
}

.inline-asset-groups {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.text-asset-groups {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.inline-asset-groups .asset-check-group {
  align-content: start;
  min-height: 92px;
}

.text-config-note {
  min-height: 92px;
}

.text-logic-group,
.text-writeback-group {
  min-height: 112px;
}

.text-logic-copy {
  margin: 0;
  color: #475467;
  font-size: 12px;
  line-height: 1.6;
}

.text-config-summary {
  display: grid;
  gap: 8px;
}

.text-config-summary p {
  margin: 0;
  color: #475467;
  font-size: 12px;
  line-height: 1.6;
}

.text-quick-row {
  margin-top: 2px;
}

.goal-card {
  grid-column: 1;
}

.recommendation-card {
  grid-column: 2;
}

.generation-config-workbench {
  grid-column: 3;
}

.goal-card,
.recommendation-card,
.generation-config-workbench {
  min-height: 100%;
}

.canvas-tools {
  justify-content: flex-end;
}

.canvas-status > div:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
}

.canvas-status-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.result-area-title {
  color: #101828;
  font-weight: 800;
}

.canvas-status > div:first-child strong {
  color: #475467;
}

.canvas-status em {
  color: #667085;
  font-style: normal;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #98a2b3;
}

.status-dot.running {
  background: #409eff;
  box-shadow: 0 0 0 6px rgba(64, 158, 255, 0.13);
}

.status-dot.done {
  background: #12b76a;
}

.status-dot.failed {
  background: #f04438;
}

.canvas-frame {
  min-height: 0;
  height: 100%;
  padding: 14px;
  background:
    radial-gradient(circle at 20% 0%, rgba(64, 158, 255, 0.10), transparent 26%),
    linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
    linear-gradient(180deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
    #fbfdff;
  background-size: 28px 28px;
}

.result-workspace {
  overflow: auto;
}

.asset-result-sections {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-areas:
    "images copy"
    "writeback writeback";
  gap: 12px;
  min-height: 100%;
}

.asset-result-sections:has(.copy-result-section):not(:has(.image-result-section)) {
  grid-template-columns: 1fr;
  grid-template-areas:
    "copy"
    "writeback";
}

.asset-result-sections.image-only-results {
  grid-template-columns: 1fr;
  grid-template-areas: "images";
}

.asset-result-sections.copy-only-results {
  grid-template-columns: 1fr;
  grid-template-areas:
    "copy"
    "writeback";
}

.result-section {
  display: grid;
  gap: 12px;
  align-content: start;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.05);
}

.image-result-section {
  grid-area: images;
}

.copy-result-section {
  grid-area: copy;
}

.writeback-result-section {
  grid-area: writeback;
}

.result-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.result-section-head strong {
  display: block;
  color: #101828;
  font-size: 15px;
}

.result-section-head span {
  display: block;
  margin-top: 3px;
  color: #667085;
  font-size: 12px;
  line-height: 1.45;
}

.copy-asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
  max-height: 420px;
  overflow: auto;
  padding-right: 2px;
}

.writeback-list {
  display: grid;
  gap: 8px;
  max-height: 180px;
  overflow: auto;
}

.writeback-list article {
  display: grid;
  gap: 3px;
  padding: 10px;
  border: 1px solid #edf1f7;
  border-radius: 12px;
  background: #fbfdff;
}

.writeback-list strong {
  color: #344054;
  font-size: 13px;
}

.writeback-list span {
  color: #667085;
  font-size: 12px;
  line-height: 1.45;
}

.compact-result-empty {
  padding: 10px 0;
}

.compact-result-empty :deep(.el-empty__image) {
  width: 60px;
}

.result-tabs {
  margin-bottom: 12px;
  padding: 0 4px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.72);
}

.ai-suggestion-panel {
  display: grid;
  gap: 12px;
  min-height: calc(100% - 58px);
  align-content: start;
}

.result-task-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 12px;
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.12), rgba(18, 183, 106, 0.08)),
    rgba(255, 255, 255, 0.95);
  box-shadow: 0 14px 32px rgba(15, 23, 42, 0.06);
}

.result-task-summary p {
  display: grid;
  gap: 3px;
  min-width: 0;
  margin: 0;
}

.result-task-summary span {
  color: #667085;
  font-size: 11px;
}

.result-task-summary strong {
  overflow: hidden;
  color: #1d2939;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-task-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.pending-task-list article {
  display: grid;
  gap: 5px;
  padding: 12px;
  border: 1px solid #e4eaf2;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.92);
}

.pending-task-list span {
  width: max-content;
  padding: 3px 8px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 11px;
  font-weight: 800;
}

.pending-task-list strong {
  color: #101828;
}

.pending-task-list em {
  color: #667085;
  font-size: 12px;
  font-style: normal;
  line-height: 1.45;
}

.light-empty-result {
  padding: 8px 0;
}

.light-empty-result :deep(.el-empty__image) {
  width: 72px;
}

.suggestion-hero {
  padding: 16px;
  border-radius: 24px;
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.16), rgba(18, 183, 106, 0.10)),
    rgba(255, 255, 255, 0.9);
  box-shadow: 0 18px 42px rgba(15, 23, 42, 0.08);
}

.suggestion-hero span {
  display: inline-flex;
  padding: 5px 10px;
  border-radius: 999px;
  background: #fff;
  color: #175cd3;
  font-size: 12px;
  font-weight: 800;
}

.suggestion-hero h3 {
  margin: 10px 0 6px;
  font-size: 21px;
}

.suggestion-hero p {
  max-width: 560px;
  margin: 0;
  color: #475467;
}

.suggestion-list {
  display: grid;
  gap: 8px;
  padding: 14px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.9);
}

.suggestion-list p {
  margin: 0;
  color: #475467;
}

.case-placeholder-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.case-placeholder-grid article {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.06);
}

.case-placeholder-grid article > div {
  display: grid;
  place-items: center;
  min-height: 130px;
  border-radius: 14px;
  background:
    linear-gradient(90deg, rgba(148, 163, 184, 0.10) 1px, transparent 1px),
    linear-gradient(180deg, rgba(148, 163, 184, 0.10) 1px, transparent 1px),
    #f7fbff;
  background-size: 18px 18px;
  color: #98a2b3;
}

.case-placeholder-grid span {
  color: #667085;
  font-size: 12px;
}

.generating-state {
  max-width: 520px;
  margin: 120px auto;
  padding: 24px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.88);
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.asset-card {
  display: grid;
  gap: 12px;
  padding: 12px;
  border: 1px solid #e4eaf2;
  border-radius: 16px;
  background: #fff;
}

.asset-image {
  position: relative;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: 14px;
  background: #edf2f7;
}

.asset-image :deep(.el-image) {
  width: 100%;
  height: 100%;
}

.asset-status {
  position: absolute;
  top: 10px;
  left: 10px;
}

.asset-meta {
  display: grid;
  gap: 3px;
}

.asset-meta span,
.asset-error {
  color: #667085;
  font-size: 12px;
}

.asset-error {
  color: #d92d20;
}

.copy-result-list,
.tag-result-list {
  display: grid;
  gap: 12px;
}

.copy-result-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #e4eaf2;
  border-radius: 16px;
  background: #fff;
}

.copy-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 8px;
  border-radius: 12px;
  background: #f8fbff;
}

.copy-row span,
.tag-tip {
  color: #667085;
  font-size: 12px;
}

.copy-meta-tip {
  color: #667085;
  font-size: 12px;
}

.copy-row p,
.copy-result-card p {
  margin: 0;
}

.copy-row p {
  color: #101828;
  font-weight: 700;
}

.copy-translation {
  display: block;
  color: #667085;
  font-size: 12px;
  font-style: normal;
  line-height: 1.45;
}

.generated-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.diagnosis-list {
  display: grid;
  gap: 10px;
}

.diagnosis-card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid #e4eaf2;
  border-radius: 14px;
  background: #fff;
  cursor: pointer;
}

.diagnosis-card:hover {
  border-color: #409eff;
  background: #f4f9ff;
}

.diagnosis-card span {
  color: #667085;
  font-size: 12px;
}

.asset-pool {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06);
}

.asset-pool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.asset-pool-head strong,
.pool-card strong {
  display: block;
}

.asset-pool-head span,
.pool-card span,
.pool-card em {
  display: block;
  margin-top: 3px;
  color: #667085;
  font-size: 12px;
  font-style: normal;
}

.asset-pool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.pool-card {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 10px;
  border: 1px solid #e4eaf2;
  border-radius: 14px;
  background: #fff;
}

.pool-card :deep(.el-image),
.pool-placeholder {
  width: 58px;
  height: 72px;
  border-radius: 10px;
  background: #eef2f7;
}

.pool-placeholder {
  display: grid;
  place-items: center;
  color: #98a2b3;
}

.source-import-dialog {
  min-height: 480px;
}

.source-list-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 10px;
  min-height: 470px;
}

.source-list-toolbar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 10px;
  border: 1px solid #e4eaf2;
  border-radius: 8px;
  background: #f8fafc;
}

.source-list-panel :deep(.erp-footer-pagination) {
  margin-top: 0;
}

.source-product-cell {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
}

.source-product-cell :deep(.erp-image-preview) {
  width: 64px;
  min-width: 64px;
  max-width: 64px;
  height: 84px;
  min-height: 84px;
  max-height: 84px;
  flex-basis: 64px;
  border-radius: 8px;
}

.source-product-cell strong,
.source-product-cell span {
  display: block;
}

.source-product-cell span {
  color: #667085;
  font-size: 12px;
  margin-top: 3px;
}

.source-meta-stack {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.source-meta-stack span,
.source-meta-stack em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-meta-stack em {
  color: #667085;
  font-size: 12px;
  font-style: normal;
}

.asset-source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  max-height: 460px;
  overflow: auto;
}

.asset-source-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #e4eaf2;
  border-radius: 14px;
  background: #fff;
}

.asset-source-card :deep(.el-image) {
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 12px;
  background: #eef2f7;
}

.asset-source-card :deep(.erp-image-preview) {
  width: 100%;
  min-width: 0;
  max-width: none;
  height: auto;
  min-height: 0;
  max-height: none;
  aspect-ratio: 3 / 4;
  flex-basis: auto;
  border-radius: 8px;
}

.asset-source-card strong,
.asset-source-card span {
  display: block;
}

.asset-source-card span {
  color: #667085;
  font-size: 12px;
  margin-top: 3px;
}

.category-tree-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid #dbeafe;
  border-radius: 16px;
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.08), rgba(18, 183, 106, 0.05)),
    #fff;
}

.category-tree-card div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.category-tree-card span {
  color: #175cd3;
  font-size: 11px;
  font-weight: 800;
}

.category-tree-card strong {
  color: #101828;
  font-size: 14px;
}

.category-tree-card p,
.category-tree-card em {
  margin: 0;
  color: #667085;
  font-size: 12px;
  font-style: normal;
}

.strategy-summary {
  display: grid;
  gap: 10px;
}

.strategy-drawer :deep(.el-drawer__body) {
  display: grid;
  gap: 14px;
  align-content: start;
  padding: 18px;
  background: #f7f9fc;
}

.strategy-overview-card {
  display: grid;
  gap: 6px;
  padding: 16px;
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.14), rgba(18, 183, 106, 0.09)),
    #fff;
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.08);
}

.strategy-overview-card span {
  color: #175cd3;
  font-size: 12px;
  font-weight: 800;
}

.strategy-overview-card strong {
  color: #101828;
  font-size: 20px;
}

.strategy-overview-card p {
  margin: 0;
  color: #475467;
}

.strategy-summary.compact {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 12px;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
}

.strategy-summary.compact p {
  display: grid;
  gap: 3px;
  padding: 0;
  border-bottom: 0;
}

.strategy-summary.compact strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.strategy-template-preview {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
}

.strategy-template-preview .drawer-section-head {
  align-items: start;
}

.strategy-template-preview .drawer-section-head span {
  color: #667085;
  font-size: 12px;
}

.strategy-template-card {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 14px;
  padding: 14px;
  border: 1px solid #e7edf5;
  border-radius: 18px;
  background: linear-gradient(180deg, #fbfdff 0%, #f7faff 100%);
}

.strategy-template-card.template-selection,
.strategy-template-card.template-demo {
  background: linear-gradient(180deg, #fbfdff 0%, #f4f9ff 100%);
}

.strategy-template-card.template-collector_box,
.strategy-template-card.template-listing_record {
  background: linear-gradient(180deg, #fffdf8 0%, #f8fbff 100%);
}

.strategy-template-card.template-material_asset {
  background: linear-gradient(180deg, #f8fffb 0%, #f4f9ff 100%);
}

.strategy-template-media {
  display: grid;
  gap: 10px;
}

.strategy-template-media :deep(.el-image) {
  width: 100%;
  height: 190px;
  border-radius: 14px;
  overflow: hidden;
  background: #eef2f6;
}

.strategy-template-image-empty {
  display: grid;
  place-items: center;
  height: 190px;
  border-radius: 14px;
  border: 1px dashed #cfd7e6;
  background: #f8fafc;
  color: #98a2b3;
  font-size: 12px;
}

.strategy-template-badges {
  display: grid;
  gap: 6px;
}

.strategy-template-badges span,
.strategy-template-badges strong {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
}

.strategy-template-badges span {
  background: #eef4ff;
  color: #175cd3;
}

.strategy-template-badges strong {
  background: #ecfdf3;
  color: #027a48;
}

.strategy-template-body {
  display: grid;
  gap: 12px;
}

.strategy-template-body header {
  display: grid;
  gap: 4px;
}

.strategy-template-body header span {
  color: #175cd3;
  font-size: 12px;
  font-weight: 700;
}

.strategy-template-body header strong {
  font-size: 18px;
  color: #101828;
}

.strategy-template-body header p {
  margin: 0;
  color: #667085;
  line-height: 1.6;
}

.strategy-template-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.strategy-template-row {
  display: grid;
  gap: 6px;
  min-height: 72px;
  padding: 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid #e8edf5;
}

.strategy-template-row span {
  color: #667085;
  font-size: 12px;
}

.strategy-template-row strong {
  color: #101828;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.drawer-strategy-list {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
}

.drawer-strategy-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.drawer-strategy-grid article {
  display: grid;
  gap: 5px;
  padding: 10px;
  border: 1px solid #e4eaf2;
  border-radius: 14px;
  background: #fbfdff;
  cursor: pointer;
}

.drawer-strategy-grid article.active {
  border-color: #409eff;
  background: #eef6ff;
  color: #175cd3;
}

.drawer-strategy-grid article span {
  color: #667085;
  font-size: 11px;
}

.drawer-strategy-grid article strong {
  font-size: 13px;
}

.strategy-advanced-collapse {
  border-radius: 16px;
  overflow: hidden;
  background: #fff;
  padding: 0 12px;
}

.prompt-preview-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
}

.prompt-preview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}

.prompt-preview-grid article {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.prompt-preview-grid article > strong {
  color: #344054;
  font-size: 13px;
}

.goal-plan-preview .prompt-preview-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.goal-plan-workbench {
  display: grid;
  grid-template-rows: auto minmax(260px, 360px) minmax(220px, 1fr);
  gap: 10px;
  min-height: min(760px, calc(88vh - 96px));
  margin-bottom: 14px;
}

.goal-plan-dialog :deep(.el-dialog__body) {
  max-height: 88vh;
  overflow: hidden;
  padding: 14px 18px 18px;
  background: #f7f9fc;
}

.goal-plan-context {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.goal-plan-context article,
.tree-column,
.goal-column,
.plan-column {
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
}

.goal-plan-context span,
.column-head span {
  color: #667085;
  font-size: 12px;
}

.goal-plan-context strong,
.column-head strong {
  color: #101828;
  font-size: 15px;
}

.goal-plan-context em {
  overflow: hidden;
  color: #667085;
  font-size: 12px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-plan-columns {
  display: grid;
  grid-template-columns: minmax(180px, 0.72fr) minmax(280px, 1.18fr) minmax(260px, 1fr);
  gap: 12px;
  align-items: start;
  min-height: 0;
  overflow: hidden;
}

.unified-goal-plan-columns {
  align-items: stretch;
}

.column-head {
  display: grid;
  gap: 3px;
}

.strategy-select-panel {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  max-height: 360px;
  overflow: hidden;
  padding: 12px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
}

.strategy-panel-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  background: #fff;
}

.strategy-panel-head > div:first-child {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.strategy-panel-head strong,
.strategy-panel-summary strong {
  color: #101828;
  font-size: 15px;
}

.strategy-panel-head span,
.strategy-panel-summary span,
.strategy-list-caption span {
  color: #667085;
  font-size: 12px;
  line-height: 1.4;
}

.strategy-panel-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

.icon-action {
  min-width: 44px;
  padding: 5px 8px;
  border-radius: 8px;
}

.icon-action.danger {
  color: #d92d20;
}

.strategy-panel-summary {
  display: grid;
  gap: 5px;
  min-height: 58px;
  margin-bottom: 8px;
  padding: 10px;
  border: 1px solid #edf1f7;
  border-radius: 10px;
  background: #f8fbff;
}

.strategy-option-list {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.strategy-list-caption {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  gap: 3px;
  padding: 6px 0;
  background: #fff;
}

.strategy-list-caption strong {
  color: #344054;
  font-size: 13px;
}

.strategy-option-card {
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid #e4eaf2;
  border-radius: 10px;
  background: #fbfdff;
  color: #344054;
  text-align: left;
  cursor: pointer;
}

.strategy-option-card.active {
  border-color: #409eff;
  background: #eef6ff;
  color: #175cd3;
}

.strategy-option-card strong {
  font-size: 14px;
}

.strategy-option-card span {
  color: #667085;
  font-size: 12px;
}

.plan-option-card {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
}

.plan-option-card em {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 12px;
  font-style: normal;
  font-weight: 800;
}

.tree-card,
.goal-group button,
.plan-column button {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #e4eaf2;
  border-radius: 10px;
  background: #fbfdff;
  color: #344054;
  text-align: left;
  cursor: pointer;
  line-height: 1.25;
}

.tree-column,
.goal-column,
.plan-column {
  max-height: 360px;
  overflow: auto;
}

.goal-group button strong,
.plan-column button strong,
.tree-card strong {
  font-size: 14px;
}

.tree-card.active,
.goal-group button.active,
.plan-column button.active {
  border-color: #409eff;
  background: #eef6ff;
  color: #175cd3;
}

.tree-card span,
.goal-group button span,
.plan-column button span {
  color: #667085;
  font-size: 12px;
}

.node-edit-action {
  width: fit-content;
  margin-top: 0;
  color: #175cd3;
  font-size: 12px;
  font-style: normal;
  font-weight: 700;
}

.node-edit-action:hover {
  text-decoration: underline;
}

.tree-help {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  margin-left: 5px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 11px;
  font-weight: 800;
}

.goal-editor-tabs :deep(.el-tabs__header) {
  margin-bottom: 4px;
}

.goal-group {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid #edf1f7;
  border-radius: 12px;
  background: #f8fbff;
}

.goal-group > div {
  display: grid;
  gap: 3px;
  padding-bottom: 2px;
}

.goal-group > div strong {
  color: #344054;
  font-size: 13px;
}

.goal-group > div span {
  color: #667085;
  font-size: 12px;
}

.plan-column button {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
}

.plan-column button em {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 12px;
  font-style: normal;
  font-weight: 800;
}

.goal-group .add-card,
.plan-column .add-card {
  border-style: dashed;
  background: #fff;
}

.advanced-strategy-library {
  border-radius: 16px;
  overflow: hidden;
  background: #fff;
  padding: 0 12px;
}

.goal-plan-preview {
  display: grid;
  gap: 10px;
  min-height: 0;
  max-height: 300px;
  overflow: auto;
  padding: 12px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
}

.prompt-source-list {
  display: grid;
  gap: 8px;
  min-height: 0;
}

.prompt-source-group {
  display: grid;
  gap: 5px;
  padding: 8px 10px;
  border: 1px solid #edf1f7;
  border-radius: 10px;
  background: #f8fbff;
}

.prompt-source-group span {
  width: fit-content;
  padding: 2px 7px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 11px;
  font-weight: 800;
}

.prompt-source-group p {
  margin: 0;
  color: #344054;
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
}

.prompt-line-list {
  display: grid;
  gap: 6px;
}

.prompt-line-list p {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid #edf1f7;
  border-radius: 9px;
  background: #f8fbff;
}

.prompt-line-list span {
  width: fit-content;
  max-width: 74px;
  padding: 2px 7px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 11px;
  font-weight: 800;
  line-height: 1.35;
}

.prompt-line-list em {
  min-width: 0;
  color: #344054;
  font-size: 12px;
  font-style: normal;
  line-height: 1.45;
  word-break: break-word;
}

.workbench-prompt-line-list {
  max-height: 320px;
  overflow: auto;
  padding-right: 4px;
}

.field-help {
  display: block;
  margin-top: 6px;
  color: #667085;
  font-size: 12px;
  line-height: 1.4;
}

.strategy-node-dialog :deep(.el-dialog__body) {
  padding-top: 12px;
}

.strategy-node-dialog .two-col > .el-form-item:nth-child(3) {
  display: none;
}

.advanced-template-picker {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}

.advanced-template-picker > span {
  color: #667085;
  font-size: 12px;
  font-weight: 700;
}

.strategy-summary h3,
.prompt-readonly h3 {
  margin: 0;
}

.strategy-summary p {
  display: flex;
  justify-content: space-between;
  margin: 0;
  padding: 10px 0;
  border-bottom: 1px solid #eef2f7;
}

.strategy-summary span {
  color: #667085;
}

.drawer-section-head,
.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 12px;
  border-radius: 12px;
  background: #f6f8fb;
  color: #344054;
  font-size: 12px;
  line-height: 1.6;
}

.mt-10 {
  margin-top: 10px;
}

.log-item {
  display: grid;
  gap: 3px;
  padding: 10px;
  border: 1px solid #eef2f7;
  border-radius: 12px;
  margin-bottom: 8px;
}

.log-item span,
.log-item p {
  margin: 0;
  color: #667085;
  font-size: 12px;
}

.template-center {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
}

.template-browser {
  display: grid;
  align-content: start;
  gap: 8px;
}

.template-search {
  display: grid;
  gap: 8px;
  margin-bottom: 8px;
}

.template-browser button {
  display: grid;
  gap: 4px;
  padding: 12px;
}

.template-browser button span,
.template-browser button em {
  color: #667085;
  font-size: 12px;
  font-style: normal;
}

.template-editor {
  min-width: 0;
}

.editor-head {
  margin-bottom: 14px;
}

@media (max-width: 1280px) {
  .template-center {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .product-info-template-layout {
    grid-template-columns: 1fr;
  }

  .product-card,
  .strategy-config-band,
  .workbench-columns {
    grid-template-columns: 1fr;
  }

  .strategy-template-card,
  .strategy-template-grid {
    grid-template-columns: 1fr;
  }

  .goal-plan-columns,
  .goal-plan-preview .prompt-preview-grid {
    grid-template-columns: 1fr;
  }

  .goal-plan-workbench {
    grid-template-rows: auto auto auto;
    min-height: 0;
  }

  .product-info-template-overview {
    position: static;
  }

  .goal-card,
  .recommendation-card,
  .generation-config-workbench,
  .canvas-area,
  .product-card > .product-context-card,
  .product-card > .el-alert,
  .product-card > .current-assets-card {
    grid-column: 1;
  }

  .asset-result-sections {
    grid-template-columns: 1fr;
    grid-template-areas:
      "images"
      "copy"
      "writeback";
  }
}

@media (max-width: 860px) {
  .template-center {
    grid-template-columns: 1fr;
  }

  .product-context-card,
  .strategy-config-band,
  .recommendation-list,
  .inline-asset-groups {
    grid-template-columns: 1fr;
  }

  .source-field-grid,
  .inline-fields,
  .inline-fields.package-fields {
    grid-template-columns: 1fr;
  }
}
</style>

