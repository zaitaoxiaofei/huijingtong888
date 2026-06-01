<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Download, MagicStick, Picture, Refresh, Setting, UploadFilled, View } from "@element-plus/icons-vue";
import { downloadUrl, generateAiCommerceCopy, generateAiImages, withImageToken } from "../../api/tools/aiImageGenerator";
import { createMaterialAsset, listMaterialAssets, updateMaterialAsset } from "../../api/materialAssets";
import { apiClient } from "../../utils/api";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import {
  createAiTaskSnapshot,
  resolveAiStrategyPlan as resolveLocalAiStrategyPlan
} from "../../config/aiStrategyLibrary";
import {
  createAiStrategy,
  deleteAiStrategy,
  listAiStrategies,
  resolveAiStrategyPlan as resolveRemoteAiStrategyPlan,
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

const router = useRouter();
const route = useRoute();

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

const loading = ref(false);
const generating = ref(false);
const templates = ref([]);
const selectedTemplateId = ref(null);
const activeImage = ref("");
const previewPositivePrompt = ref("");
const previewNegativePrompt = ref("");

const strategyDrawer = ref(false);
const diagnosisDrawer = ref(false);
const productInfoDrawer = ref(false);
const activeCommerceMode = ref("optimization");
const activeConfigTab = ref("output");
const templateCenterVisible = ref(false);
const strategyLibraryVisible = ref(false);
const sourceDialogVisible = ref(false);
const sourceSelections = ref([]);
const sourceAssets = ref([]);
const sourceTab = ref("assets");
const sourceLoading = ref(false);
const remoteStrategyPlan = ref(null);
const strategyPlanLoading = ref(false);
const sourceImportingId = ref("");
const routeSelectionImporting = ref(false);
const importedRouteSelectionId = ref("");
const sourceSelectionsLoaded = ref(false);
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
  sourceType: "demo",
  sourceId: "",
  sourceSelectionId: null,
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

const templateForm = reactive(createBlankTemplate());
const strategyForm = reactive(createBlankStrategy());

const selectedStyle = computed(() => styleOptions.find((item) => item.key === task.style) || styleOptions[0]);
const selectedVariantMode = computed(() => variantModes.find((item) => item.key === task.variantMode) || variantModes[0]);
const flatOptimizationTargets = computed(() => optimizationGroups.flatMap((group) => group.items.map((item) => ({ ...item, groupType: group.type, groupTitle: group.title }))));
const selectedOptimizationTarget = computed(() => flatOptimizationTargets.value.find((item) => item.key === task.optimizationTarget) || flatOptimizationTargets.value[0]);
const currentStrategyType = computed(() => {
  const key = task.optimizationTarget;
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
const strategyBusinessMode = computed(() => task.optimizationTarget?.startsWith("multi_") ? "product_variant" : "product_optimization");
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
  goalKey: task.optimizationTarget,
  selectedTitles: task.selectedStrategies,
  fallbackTitles: selectedGoalStrategies.value,
  categoryText: strategyCategoryText.value
}));
const aiStrategyPlan = computed(() => remoteStrategyPlan.value || localAiStrategyPlan.value);
function resolveStrategyPlanForTitles(strategyTitles = []) {
  return resolveLocalAiStrategyPlan({
    businessMode: strategyBusinessMode.value,
    goalKey: task.optimizationTarget,
    selectedTitles: strategyTitles,
    fallbackTitles: strategyTitles.length ? [] : selectedGoalStrategies.value.slice(0, 1),
    categoryText: strategyCategoryText.value
  });
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
  return task.advancedNegativePrompt || [
    task.promptModules.negativePrompt,
    ...strategyPlan.negativeModules
  ].filter(Boolean).join("\n");
}
const finalPrompt = computed(() => buildPositivePrompt());
const finalNegativePrompt = computed(() => buildNegativePrompt());
const displayResults = computed(() => results.value.filter((item) => item.status !== "deleted"));
const imageResults = computed(() => displayResults.value.filter((item) => item.imageUrl || item.assetKind === "image"));
const titleResults = computed(() => displayResults.value.filter((item) => item.generatedTitles?.length));
const tagResults = computed(() => displayResults.value.filter((item) => item.generatedTags?.length));
const descriptionResults = computed(() => displayResults.value.filter((item) => item.generatedDescription));
const writebackResults = computed(() => displayResults.value.filter((item) => item.writeBackStatus === "已回写" || item.assetId));
const selectionTemplateReady = computed(() => task.sourceType === "selection" && Boolean(task.sourceSelectionId));
const writeBackGateText = computed(() => selectionTemplateReady.value
  ? "将以选品估价表原记录为模板，创建新的选品记录"
  : "请先从选品估价表导入商品，才能创建新选品记录");
const copyResultSectionVisible = computed(() => (
  ["标题", "标签", "描述"].some((item) => task.outputs.includes(item))
  || titleResults.value.length
  || tagResults.value.length
  || descriptionResults.value.length
));
const writebackResultSectionVisible = computed(() => writebackResults.value.length > 0);
const selectedWriteBackAssets = computed(() => {
  const assets = [];
  if (task.outputs.includes("主图")) assets.push("主图");
  if (task.outputs.includes("详情图")) assets.push(`详情图：${task.detailImageTypes.join(" / ") || "类目推荐模块"}`);
  ["标题", "标签", "描述"].forEach((item) => {
    if (task.outputs.includes(item)) assets.push(item);
  });
  return assets;
});
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
  return rule?.goals?.[task.optimizationTarget] || null;
});
const selectedGoalStrategyConfig = computed(() => {
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
    group: "可选增强"
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
const strategySummary = computed(() => ({
  platform: task.platform,
  category: categoryStrategyRule.value.category,
  target: selectedOptimizationTarget.value?.title || "提升点击率",
  recommendation: selectedStrategyTitles.value.join(isVariantWorkflow.value ? "" : " / "),
  outputs: selectedWriteBackAssets.value.slice(0, 4).join(" / ")
}));
const selectedStrategyTitles = computed(() => {
  const fallback = selectedGoalStrategies.value.slice(0, 1);
  return task.selectedStrategies.length ? task.selectedStrategies : fallback;
});
const selectedStrategyCountText = computed(() => {
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
  { key: "logistics", label: "物流规则", hint: "选品估价表物流规则", value: task.logisticsRuleName, model: "logisticsRuleName", placeholder: "例如：标准小包 / 空陆" },
  { key: "sellingPoints", label: "产品卖点", hint: "给 AI 生成主图和详情图的核心利益点", value: task.sellingPoints, model: "sellingPoints", type: "textarea", placeholder: "防刮耐磨、安装便捷、贴合车门门槛区域", span: 2 },
  { key: "tags", label: "产品标签", hint: "编辑上架标签，可用于标题标签生成", value: task.productTags, model: "productTags", placeholder: "多个标签用逗号分隔", span: 2 },
  { key: "summary", label: "简介", hint: "编辑上架简介 / 运营描述", value: task.summary, model: "summary", type: "textarea", placeholder: "用于详情图文案和描述生成", span: 2 },
  { key: "richContent", label: "富内容 / 附内容", hint: "Ozon 富内容 JSON 或尾图内容摘要", value: task.richContent, model: "richContent", type: "textarea", placeholder: "可放尾图、富内容、补充说明", span: 2 },
  { key: "sourcePlatform", label: "来源平台", hint: "1688、供应商、手工录入等", value: task.sourcePlatform, model: "sourcePlatform", placeholder: "例如：1688" },
  { key: "supplier", label: "供应商 / 采购链接", hint: "后续回写和追溯采购来源", custom: "supplier", span: 2 },
  { key: "cost", label: "采购成本 / 运费 / 打包费", hint: "用于回写选品表和利润计算", custom: "cost", span: 2 },
  { key: "price", label: "售价 / 标价 / 汇率", hint: "选品估价表价格信息", custom: "price", span: 2 },
  { key: "supplierNote", label: "供应商备注", hint: "采购侧补充说明", value: task.supplierNote, model: "supplierNote", type: "textarea", placeholder: "供应商备注、注意事项", span: 2 },
  { key: "sourceImageUrl", label: "主图 / 参考图 URL", hint: "后续可接上传，当前用于 image2 图生图参考", value: task.sourceImageUrl, model: "sourceImageUrl", placeholder: "粘贴主图或参考图 URL", span: 2 }
]);
const visibleSourceFields = computed(() => sourceFieldOptions.value.filter((item) => visibleSourceFieldKeys.value.includes(item.key)));

onMounted(() => {
  loadSourceFieldPreferences();
  loadTemplates();
  refreshRemoteStrategyPlan();
  importSelectionFromRoute();
});

watch(() => route.query.baseSelectionId, () => {
  importSelectionFromRoute();
});

watch(sourceTab, (tab) => {
  if (!sourceDialogVisible.value) return;
  if (tab === "assets") loadSourceAssets();
  else loadSourceSelections();
});

watch([
  () => task.optimizationTarget,
  () => task.selectedStrategies.join("|"),
  () => selectedGoalStrategies.value.join("|"),
  () => strategyCategoryText.value,
  () => strategyBusinessMode.value
], () => {
  refreshRemoteStrategyPlan();
});

async function loadTemplates() {
  loading.value = true;
  try {
    templates.value = await listAiPromptTemplates();
    const defaultTemplate = templates.value.find((item) => item.scene === "main_image_variant" && item.is_default && item.enabled)
      || templates.value.find((item) => item.scene === "main_image_variant" && item.enabled);
    if (defaultTemplate) applyTemplate(defaultTemplate);
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
      goalKey: task.optimizationTarget,
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
  sourceTab.value = "assets";
  if (sourceTab.value === "assets") loadSourceAssets();
  else loadSourceSelections();
}

async function loadSourceSelections() {
  if (sourceSelectionsLoaded.value && sourceSelections.value.length) return;
  sourceLoading.value = true;
  try {
    const selections = await apiClient.get("/api/products/selection?paged=1&page=1&pageSize=15", { noCache: true });
    sourceSelections.value = Array.isArray(selections?.rows) ? selections.rows : (Array.isArray(selections) ? selections : []);
    sourceSelectionsLoaded.value = true;
  } catch (error) {
    ElMessage.error(error.message || "选品商品加载失败");
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

function normalizeTextValue(value, fallback = "") {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function previewImageUrl(url = "") {
  const value = String(url || "");
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return value;
  return withImageToken(value);
}

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
  task.brand = row.vehicle_brand || task.brand;
  task.vehicleModel = row.vehicle_model || task.vehicleModel;
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
  task.sourceType = "selection";
  task.sourceId = String(row.id || "");
  task.sourceSelectionId = row.id || null;
  task.sourcePackageId = "";
  task.sourceLabel = `选品估价表 #${row.selection_id || row.id || ""}`;
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
  task.sourceImageUrl = normalizeInternalImageUrl(asset.url || asset.thumbnail_url || task.sourceImageUrl);
  task.sourceType = "material_asset";
  task.sourceId = String(asset.id || "");
  task.sourceSelectionId = asset.source_selection_id || null;
  task.sourcePackageId = asset.source_package_id || asset.source_id || "";
  task.sourceLabel = `统一素材资产 #${asset.id || ""}`;
  refreshRecommendedStrategiesFromCategory();
  sourceDialogVisible.value = false;
  ElMessage.success("已导入统一素材资产");
}

function refreshRecommendedStrategiesFromCategory() {
  task.selectedStrategies = selectedGoalStrategies.value.slice(0, 1);
  applyCategoryStrategyDefaults();
}

function applyTemplate(template) {
  selectedTemplateId.value = template.id;
  task.ratio = template.default_ratio || "3:4";
  task.imageCount = Number(template.default_count || 1);
  task.promptModules.styleRule = template.positive_prompt || "";
  if (template.negative_prompt) task.promptModules.negativePrompt = template.negative_prompt;
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
    task.sourceType = "local_reference_image";
    task.sourceId = file.name;
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
  syncImageStyleFromStrategy();
  task.selectedStrategies = selectedGoalStrategies.value.slice(0, 1);
  applyCategoryStrategyDefaults();
}

function selectStrategy(item) {
  task.strategyKey = item.key;
  syncImageStyleFromStrategy();
}

function toggleRecommendedStrategy(title) {
  if (isVariantWorkflow.value) {
    task.selectedStrategies = [title];
    return;
  }
  const index = task.selectedStrategies.indexOf(title);
  if (index >= 0) task.selectedStrategies.splice(index, 1);
  else task.selectedStrategies.push(title);
}

function syncImageStyleFromStrategy() {
  if (styleOptions.some((item) => item.key === task.strategyKey)) {
    task.style = task.strategyKey;
  }
}

function applyCategoryStrategyDefaults() {
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
    variables: buildVariables(targetModel)
  });
}

async function previewPrompt() {
  strategyDrawer.value = true;
  try {
    const firstJob = buildGenerationJobs()[0];
    const result = await renderPromptForTarget(firstJob?.targetModel || "", firstJob?.strategyTitles || selectedStrategyTitles.value.slice(0, 1));
    previewPositivePrompt.value = result.finalPositivePrompt;
    previewNegativePrompt.value = result.finalNegativePrompt;
    task.variablesJson = JSON.stringify(buildVariables(firstJob?.targetModel || task.targets[0] || ""), null, 2);
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
    ElMessage.warning("请先选择要生成的图片或文案资产");
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
    else ElMessage.success("图片生成完成");
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
    const sourceImageUrl = shouldUseReferenceImage() ? task.sourceImageUrl : "";
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
    job.status = "失败";
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

function hasRussianCopy(value) {
  const items = Array.isArray(value) ? value : [value];
  return items.some((item) => /[А-Яа-яЁё]/.test(ruCopy(item) || String(item || "")));
}

function buildLocalRussianCopy(job) {
  const modelText = job.targetModel || task.vehicleModel || task.brand || "универсальная модель";
  const brandText = task.brand || String(modelText).split(/\s+/)[0] || "";
  const materialRu = productMaterialRu(task.material);
  const typeRu = productTypeRu(task.productType || task.productName);
  const featureRu = "защита от царапин";
  return {
    titles: [
      {
        ru: `${typeRu} для ${modelText}, ${materialRu}, ${featureRu}`,
        zh: `${modelText} 适用的${task.material || ""}${task.productType || task.productName || "汽车配件"}，突出防刮保护`
      },
      {
        ru: `${typeRu} ${brandText} ${modelText}, комплект для авто`,
        zh: `${brandText} ${modelText} 专车适配套装`
      },
      {
        ru: `Автоаксессуар для ${modelText}, прочный материал, легкая установка`,
        zh: `${modelText} 汽车配件，突出耐用材质和易安装`
      },
      {
        ru: `${typeRu} для автомобиля ${modelText}, защита и стиль`,
        zh: `${modelText} 汽车用${task.productType || "配件"}，强调保护和外观`
      }
    ],
    tags: [
      { ru: brandText, zh: "品牌词" },
      { ru: modelText, zh: "车型词" },
      { ru: typeRu, zh: "产品类型" },
      { ru: materialRu, zh: "材质词" },
      { ru: "автоаксессуары", zh: "汽车配件" },
      { ru: "защита автомобиля", zh: "汽车保护" },
      { ru: "легкая установка", zh: "易安装" },
      { ru: "Ozon", zh: "平台词" }
    ].filter((item) => item.ru),
    description: {
      ru: `${typeRu} для ${modelText}. Подходит для ежедневного использования, помогает защитить поверхность автомобиля от царапин и износа. ${task.sellingPoints || "Аккуратный внешний вид, надежный материал и простая установка."}`,
      zh: `${modelText} 适用的${task.productType || "汽车配件"}，用于日常保护，突出耐磨、防刮、安装方便等卖点。`
    }
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
      optimizationTarget: selectedOptimizationTarget.value?.title,
      strategies: (job.strategyPlan || aiStrategyPlan.value).strategyTitles
    });
    job.generatedTitles = Array.isArray(result.titles) ? result.titles.slice(0, 4) : [];
    job.generatedTags = Array.isArray(result.tags) ? result.tags.slice(0, 14) : [];
    job.generatedDescription = result.description || "";
    if (!hasRussianCopy(job.generatedTitles) && !hasRussianCopy(job.generatedTags) && !hasRussianCopy(job.generatedDescription)) {
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
  task.advancedPositivePrompt = item.finalPositivePrompt || finalPrompt.value;
  task.advancedNegativePrompt = item.finalNegativePrompt || finalNegativePrompt.value;
  strategyDrawer.value = true;
}

function setAsMain(item) {
  results.value.forEach((row) => {
    row.isMain = row.id === item.id;
  });
  ElMessage.success("已设为主图");
}

async function writeBack(item) {
  if (!selectionTemplateReady.value) {
    ElMessage.warning("请先从选品估价表导入商品，再创建新的选品记录");
    return;
  }
  if (item.writeBackStatus === "已回写") {
    ElMessage.warning("该结果已创建过选品记录");
    return;
  }
  item.writeBackStatus = "回写中";
  try {
    const bundle = buildWriteBackBundle(item);
    const created = await createDerivedSelectionRecord(bundle);
    item.createdSelectionId = created?.id || created?.product?.id || null;
    item.createdSelectionCode = created?.product?.selection_id || created?.selection_id || "";
    if (item.assetId) {
      await updateMaterialAsset(item.assetId, {
        status: "used",
        usage_count: Number(item.usageCount || 0) + 1,
        metadata: {
          writeBackTarget: "selection",
          sourceSelectionId: task.sourceSelectionId,
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
    ElMessage.success(`已创建新选品记录 ${item.createdSelectionCode || item.createdSelectionId || ""}`);
    markWriteBackGroupDone(item, created || {});
  } catch (error) {
    item.writeBackStatus = "待回写";
    ElMessage.error(error.message || "创建选品记录失败");
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
    row.writeBackStatus = "已回写";
    row.createdSelectionId = created.id || created.product?.id || null;
    row.createdSelectionCode = created.product?.selection_id || created.selection_id || "";
  });
}

async function batchWriteBack() {
  if (!selectionTemplateReady.value) {
    ElMessage.warning("批量创建已封锁：请先从选品估价表导入商品作为模板");
    return;
  }
  const writable = Array.from(
    new Map(displayResults.value
      .filter((item) => item.status === "已完成" && item.writeBackStatus !== "已回写" && resultHasWritableContent(item))
      .map((item) => [item.writeBackGroupKey || item.id, item])).values()
  );
  if (!writable.length) {
    ElMessage.warning("没有可回写的新结果");
    return;
  }
  await ElMessageBox.confirm(
    `将以「${task.sourceLabel}」为模板创建 ${writable.length} 条新的选品计价表记录。未生成或未勾选的字段会保留模板原值，不会覆盖原记录。`,
    "创建新选品记录",
    { type: "warning", confirmButtonText: "创建新记录", cancelButtonText: "取消" }
  );
  for (const item of writable) {
    await writeBack(item);
  }
  ElMessage.success(`已创建 ${writable.length} 条新选品记录`);
}

function saveDraft() {
  localStorage.setItem("aiVisualWorkbenchDraft", JSON.stringify({ task, savedAt: new Date().toISOString() }));
  ElMessage.success("草稿已保存");
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
    writeBackStatus: "待回写",
    createdAt: new Date().toLocaleString(),
    isMain: false,
    errorMessage: "",
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
  await loadStrategyLibrary();
  if (!strategyForm.id && strategyLibraryRows.value[0]) selectStrategyForEdit(strategyLibraryRows.value[0]);
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
    positive_prompt: finalPrompt.value,
    negative_prompt: finalNegativePrompt.value,
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
        <el-button class="erp-btn erp-btn-secondary" @click="openDiagnosis">数据诊断</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="Setting" @click="strategyDrawer = true">AI策略</el-button>
        <el-button class="erp-btn erp-btn-secondary" @click="openStrategyLibrary">策略库</el-button>
        <el-button class="erp-btn erp-btn-secondary" @click="openTemplateCenter">模板中心</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="View" @click="openMaterialCenter">查看素材</el-button>
        <el-button class="erp-btn erp-btn-secondary" @click="saveDraft">保存草稿</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" :icon="MagicStick" :loading="generating" @click="startGenerate">开始AI优化</el-button>
        <el-tooltip :content="writeBackGateText" placement="top">
          <span>
            <el-button class="erp-btn erp-btn-secondary" type="success" plain :disabled="!displayResults.length || !selectionTemplateReady" @click="batchWriteBack">创建选品记录</el-button>
          </span>
        </el-tooltip>
      </div>
    </header>

    <section class="workbench-flow">
      <div class="workbench-columns">
        <section class="config-card product-card">
          <section class="product-context-card">
            <div class="context-thumb">
              <el-image v-if="task.sourceImageUrl" :src="previewImageUrl(task.sourceImageUrl)" fit="cover" :preview-src-list="[previewImageUrl(task.sourceImageUrl)]" />
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
                <p><span>品牌 / 型号</span><em>{{ task.brand || "-" }} {{ task.vehicleModel || "" }}</em></p>
                <p><span>材质 / 颜色</span><em>{{ task.material || "-" }} / {{ task.color || "-" }}</em></p>
                <p><span>核心卖点</span><em>{{ task.sellingPoints || "待补充" }}</em></p>
              </div>
            </div>
            <div class="context-actions">
              <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="openSourceDialog">导入素材</el-button>
              <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="triggerReferenceUpload">上传参考图</el-button>
              <el-button class="erp-btn-link" size="small" text type="primary" @click="productInfoDrawer = true">查看完整商品信息</el-button>
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
              <el-button class="erp-btn-link" link type="primary" @click="productInfoDrawer = true">查看完整商品信息</el-button>
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
                <el-image v-if="task.sourceImageUrl" :src="previewImageUrl(task.sourceImageUrl)" fit="cover" :preview-src-list="[previewImageUrl(task.sourceImageUrl)]" />
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

        <aside class="generation-panel">
          <section class="assistant-identity-card">
            <span>AI Commerce Optimization Engine</span>
            <strong>AI正在分析这个商品</strong>
            <p>系统会根据当前素材、类目、车型和目标，推荐优化策略，而不是让运营从 Prompt 开始配置。</p>
          </section>

          <section class="ai-flow-card ai-analysis-card">
            <div class="flow-step-head">
              <span>AI</span>
              <div>
                <strong>AI商品分析</strong>
                <em>基于当前商品信息和类目策略树生成。</em>
              </div>
            </div>
            <div class="analysis-list">
              <p v-for="item in aiIssueHints" :key="item">✓ {{ item }}</p>
            </div>
            <div class="category-rule-card">
              <strong>{{ categoryStrategyRule.category }} · 类目策略树</strong>
              <span>{{ categoryStrategyRule.summary }}</span>
              <span>CTR：{{ categoryStrategyRule.ctr.join(" / ") }}</span>
              <span>CVR：{{ categoryStrategyRule.cvr.join(" / ") }}</span>
              <span>SEO：{{ categoryStrategyRule.seo.join(" / ") }}</span>
              <span v-if="categoryStrategyRule.promptModules.length">Prompt模块：{{ categoryStrategyRule.promptModules.join(" / ") }}</span>
            </div>
          </section>

          <section class="ai-flow-card">
            <div class="flow-step-head">
              <span>GOAL</span>
              <div>
                <strong>你想让 AI 做什么？</strong>
                <em>先选择策略方向：优化已有链接，或裂变成更多商品。</em>
              </div>
            </div>
            <el-tabs v-model="activeCommerceMode" class="assistant-tabs">
              <el-tab-pane label="商品优化 AI" name="optimization" />
              <el-tab-pane label="商品裂变 AI" name="variant" />
            </el-tabs>
            <div class="commerce-mode-stack">
              <div
                v-for="mode in commerceAiModes.filter((_, index) => activeCommerceMode === 'optimization' ? index === 0 : index === 1)"
                :key="mode.title"
                class="commerce-mode-card"
              >
                <div>
                  <strong>{{ mode.title }}</strong>
                  <span>{{ mode.subtitle }}</span>
                </div>
                <div class="hero-objective-grid">
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
              <span>{{ isVariantWorkflow ? "VAR" : "PLAN" }}</span>
              <div>
                <strong>{{ isVariantWorkflow ? "选择一个裂变策略" : "选择独立生成策略" }}</strong>
                <em>{{ isVariantWorkflow ? "裂变模式下策略互斥，按车型等变量批量展开。" : "每个策略生成一张独立方案，多选会拆成多张图。" }}</em>
              </div>
            </div>
            <div class="recommendation-list">
              <button
                v-for="item in goalStrategyCards"
                :key="item.title"
                :class="{ active: task.selectedStrategies.includes(item.title), recommended: item.recommended }"
                @click="toggleRecommendedStrategy(item.title)"
              >
                <strong>{{ task.selectedStrategies.includes(item.title) ? "✓" : "+" }} {{ item.title }}</strong>
                <span>{{ isVariantWorkflow ? "单一裂变策略" : (item.recommended ? "独立方案" : "可选方案") }}</span>
              </button>
            </div>
            <div class="strategy-summary-card">
              <p><span>平台</span><strong>{{ strategySummary.platform }}</strong></p>
              <p><span>类目</span><strong>{{ strategySummary.category }}</strong></p>
              <p><span>目标</span><strong>{{ strategySummary.target }}</strong></p>
              <p><span>策略</span><strong>{{ strategySummary.recommendation }}</strong></p>
              <p><span>输出</span><strong>{{ strategySummary.outputs }}</strong></p>
            </div>
          </section>

        </aside>

      <main class="canvas-area">
        <section class="canvas-status">
          <div>
            <span class="status-dot" :class="{ running: taskStatus === '生成中', done: taskStatus === '已完成', failed: taskStatus === '失败' }"></span>
            <span class="result-area-title">AI生成结果区</span>
            <strong>{{ taskStatus }}</strong>
            <em>{{ displayResults.length }} 个结果</em>
          </div>
          <div class="canvas-status-actions">
            <el-button class="erp-btn erp-btn-secondary" size="small" :disabled="!displayResults.length" @click="saveDraft">保存草稿</el-button>
            <el-button class="erp-btn erp-btn-primary" size="small" type="primary" :loading="generating" @click="startGenerate">重新生成</el-button>
            <el-tooltip :content="writeBackGateText" placement="top">
              <span>
                <el-button
                  class="erp-btn erp-btn-secondary"
                  size="small"
                  type="success"
                  plain
                  :disabled="!displayResults.length || !selectionTemplateReady"
                  @click="batchWriteBack"
                >
                  创建选品记录
                </el-button>
              </span>
            </el-tooltip>
          </div>
        </section>

        <section class="generation-config-workbench">
          <div class="generation-config-head">
            <div>
              <span>CONFIG</span>
              <strong>生成配置工作台</strong>
              <em>车型变量、输出资产和回写范围在这里统一配置。</em>
            </div>
            <div class="canvas-tools">
              <el-segmented v-model="task.ratio" :options="ratioOptions" />
              <el-select v-model="task.style" placeholder="图片风格" style="width: 180px">
                <el-option v-for="item in styleOptions" :key="item.key" :label="item.title" :value="item.key" @click="selectStrategy(item)" />
              </el-select>
              <el-button class="erp-btn erp-btn-secondary" :icon="View" @click="previewPrompt">预览Prompt</el-button>
            </div>
          </div>
          <el-tabs v-model="activeConfigTab" class="config-tabs inline-config-tabs">
            <el-tab-pane label="车型与输出" name="output">
              <div class="inline-output-layout">
                <div class="inline-targets">
                  <div class="target-tab-head">
                    <strong>{{ isVariantWorkflow ? "裂变变量" : "车型变量（可选）" }}</strong>
                     <el-button class="erp-btn-link-danger" link type="danger" :disabled="!task.targets.length" @click="clearTargets">清空</el-button>
                  </div>
                  <div class="target-tags">
                    <el-tag v-for="(item, index) in task.targets" :key="item" closable @close="removeTarget(index)">{{ item }}</el-tag>
                    <span v-if="!task.targets.length" class="target-empty">还没有车型</span>
                  </div>
                  <div class="target-input-row">
                    <el-input
                      v-model="task.targetInput"
                      type="textarea"
                      :rows="1"
                      resize="none"
                      :placeholder="isVariantWorkflow ? '输入或粘贴车型，每个车型生成一张独立主图' : '可选：输入参考车型，用于优化文案或主图'"
                      @keyup.enter.exact.prevent="addTargetFromInput"
                      @keyup.ctrl.enter="addTargetFromInput"
                    />
                    <el-button class="erp-btn erp-btn-primary" type="primary" @click="addTargetFromInput">添加</el-button>
                  </div>
                  <div class="quick-row">
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['TENET T4', 'TENET T7', 'TENET T8'])">TENET</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['BELGEE X50', 'BELGEE X70'])">BELGEE</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['HAVAL Jolion', 'HAVAL F7', 'HAVAL Dargo'])">HAVAL</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['CHERY TIGGO 4', 'CHERY TIGGO 7', 'CHERY TIGGO 8'])">CHERY</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="quickTargets(['JAECOO J7', 'JAECOO J8'])">JAECOO</el-button>
                  </div>
                </div>
                <div class="asset-check-groups inline-asset-groups">
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
                  <div class="asset-check-group">
                    <span>文案资产</span>
                    <el-checkbox-group v-model="task.outputs">
                      <el-checkbox value="标题">标题</el-checkbox>
                      <el-checkbox value="标签">标签</el-checkbox>
                      <el-checkbox value="描述">描述</el-checkbox>
                    </el-checkbox-group>
                  </div>
                  <div class="asset-check-group writeback-auto-group">
                    <span>回写资产</span>
                    <p>回写范围自动跟随已选择的图片资产和文案资产。</p>
                    <div class="writeback-tags">
                      <el-tag v-for="item in selectedWriteBackAssets" :key="item" size="small" type="success" effect="light">{{ item }}</el-tag>
                      <span v-if="!selectedWriteBackAssets.length">未选择回写内容</span>
                    </div>
                  </div>
                </div>
              </div>
            </el-tab-pane>
          </el-tabs>
        </section>

        <section class="canvas-frame result-workspace" :class="`ratio-${task.ratio.replace(':', '-')}`">
          <div v-if="!displayResults.length && !generating" class="ai-suggestion-panel">
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
            v-if="displayResults.length && !generating"
            class="asset-result-sections"
            :class="{ 'image-only-results': !copyResultSectionVisible && !writebackResultSectionVisible }"
          >
            <section class="result-section image-result-section">
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
                  <div v-if="item.status === '失败'" class="asset-error">{{ item.errorMessage }}</div>
                  <div class="asset-actions">
                    <el-button class="erp-btn erp-btn-secondary" size="small" :icon="Refresh" @click="regenerateResult(item)">重新生成</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="editPromptForItem(item)">编辑Prompt</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" :icon="Download" tag="a" :href="item.downloadUrl ? downloadUrl(item.downloadUrl) : undefined" :disabled="!item.downloadUrl">下载</el-button>
                    <el-button class="erp-btn erp-btn-secondary" size="small" @click="setAsMain(item)">设为主图</el-button>
                    <el-tooltip :content="writeBackGateText" placement="top">
                      <span>
                        <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain :disabled="!selectionTemplateReady" @click="writeBack(item)">创建选品</el-button>
                      </span>
                    </el-tooltip>
                  </div>
                </article>
              </div>
              <el-empty v-else class="compact-result-empty" description="本次还没有生成图片素材" />
            </section>

            <section v-if="copyResultSectionVisible" class="result-section copy-result-section">
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
                    <span>{{ ["高点击版本", "高搜索版本", "精准车型版本", "通用款版本"][index] || "标题方案" }}</span>
                    <p>{{ ruCopy(title) }}</p>
                    <em v-if="zhCopy(title)" class="copy-translation">{{ zhCopy(title) }}</em>
                     <el-button class="erp-btn-link" size="small" text @click="task.title = normalizeCopyForWrite(title)">设为最终标题</el-button>
                  </div>
                </article>
                <article v-for="item in tagResults" :key="`tag-${item.id}`" class="copy-result-card">
                  <strong>{{ item.targetModel }} 标签方案</strong>
                  <div class="generated-tags">
                    <el-tooltip v-for="tag in item.generatedTags" :key="ruCopy(tag)" :content="zhCopy(tag) || ruCopy(tag)" placement="top">
                      <el-check-tag checked>{{ ruCopy(tag) }}</el-check-tag>
                    </el-tooltip>
                  </div>
                  <p class="tag-tip">共 {{ item.generatedTags.length }} 个标签，已自动去重。建议单个标签不超过 30 个字符。</p>
                  <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="task.productTags = item.generatedTags.map(normalizeCopyForWrite).filter(Boolean).join(', ')">一键回写标签</el-button>
                </article>
                <article v-for="item in descriptionResults" :key="`desc-${item.id}`" class="copy-result-card">
                  <strong>{{ item.targetModel }} 描述方案</strong>
                  <p>{{ ruCopy(item.generatedDescription) }}</p>
                  <em v-if="zhCopy(item.generatedDescription)" class="copy-translation">{{ zhCopy(item.generatedDescription) }}</em>
                  <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="task.summary = normalizeCopyForWrite(item.generatedDescription)">回写简介</el-button>
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
                    <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain :disabled="!displayResults.length || !selectionTemplateReady" @click="batchWriteBack">创建选品记录</el-button>
                  </span>
                </el-tooltip>
              </div>
              <div v-if="writebackResults.length" class="writeback-list">
                <article v-for="item in writebackResults" :key="`wb-${item.id}`">
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

    <el-drawer v-model="productInfoDrawer" title="完整商品信息" size="620px">
      <div class="product-info-drawer">
        <section class="source-field-grid drawer-source-fields">
          <label
            v-for="field in sourceFieldOptions"
            :key="`drawer-${field.key}`"
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
            <el-input
              v-else
              v-model="task[field.model]"
              :type="field.type || 'text'"
              :rows="field.type === 'textarea' ? 3 : undefined"
              :placeholder="field.placeholder"
            />
          </label>
        </section>
      </div>
    </el-drawer>

    <el-dialog v-model="sourceDialogVisible" title="导入母商品 / 素材来源" width="980px" align-center>
      <div v-loading="sourceLoading" class="source-import-dialog">
        <el-tabs v-model="sourceTab">
          <el-tab-pane label="选品估价表" name="selection">
            <el-table :data="sourceSelections" height="460" stripe>
              <el-table-column label="商品" min-width="260">
                <template #default="{ row }">
                  <div class="source-product-cell">
                    <ProductImagePreview
                      :src="selectionThumbUrl(row)"
                      :preview-list="selectionPreviewList(row)"
                      size="large"
                      fit="cover"
                      lazy
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

    <el-drawer v-model="strategyDrawer" title="AI策略面板" size="520px" class="strategy-drawer">
      <section class="strategy-overview-card">
        <span>当前目标</span>
        <strong>{{ strategySummary.target }}</strong>
        <p>{{ selectedOptimizationTarget.text }}</p>
      </section>

      <section class="strategy-summary compact">
        <p><span>平台</span><strong>{{ task.platform }}</strong></p>
        <p><span>类目</span><strong>{{ strategySummary.category }}</strong></p>
        <p><span>比例</span><strong>{{ task.ratio }}</strong></p>
        <p><span>风格偏向</span><strong>{{ selectedStyle.title }}</strong></p>
        <p><span>高级模板</span><strong>{{ activeTemplate?.name || "自动匹配" }}</strong></p>
        <p><span>输出</span><strong>{{ strategySummary.outputs }}</strong></p>
      </section>

      <section class="drawer-strategy-list">
        <div class="drawer-section-head">
          <h3>本次采用的AI策略</h3>
          <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain @click="strategyDrawer = false">返回工作台调整</el-button>
        </div>
        <div class="drawer-strategy-grid">
          <article
            v-for="item in goalStrategyCards"
            :key="`drawer-${item.title}`"
            :class="{ active: task.selectedStrategies.includes(item.title), recommended: item.recommended }"
            @click="toggleRecommendedStrategy(item.title)"
          >
            <span>{{ item.group }}</span>
            <strong>{{ item.title }}</strong>
          </article>
        </div>
      </section>

      <el-collapse class="strategy-advanced-collapse">
        <el-collapse-item title="Prompt预览（高级）" name="prompt">
          <section class="prompt-readonly">
            <div class="advanced-template-picker">
              <span>高级策略模板</span>
              <el-select v-model="selectedTemplateId" placeholder="自动匹配模板" clearable>
                <el-option v-for="item in enabledTemplates" :key="item.id" :label="item.name" :value="item.id" @click="applyTemplate(item)" />
              </el-select>
            </div>
            <div class="drawer-section-head">
              <h3>最终拼接Prompt（队列首个任务）</h3>
              <el-button class="erp-btn erp-btn-secondary" size="small" @click="previewPrompt">重新拼接</el-button>
            </div>
            <pre>{{ previewPositivePrompt || finalPrompt }}</pre>
            <h4>负向规则</h4>
            <pre>{{ previewNegativePrompt || finalNegativePrompt }}</pre>
          </section>
        </el-collapse-item>
        <el-collapse-item title="高级编辑" name="advanced">
          <el-input v-model="task.advancedPositivePrompt" type="textarea" :rows="7" placeholder="正向Prompt，留空则使用模块化拼接" />
          <el-input v-model="task.advancedNegativePrompt" class="mt-10" type="textarea" :rows="5" placeholder="负向Prompt，留空则使用负向规则" />
          <el-input v-model="task.variablesJson" class="mt-10" type="textarea" :rows="5" placeholder="变量JSON" />
          <div class="advanced-actions">
            <el-button class="erp-btn erp-btn-secondary" @click="task.advancedPositivePrompt = ''; task.advancedNegativePrompt = ''">恢复模块化Prompt</el-button>
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

    <el-drawer v-model="strategyLibraryVisible" title="AI策略库" size="980px">
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
    </el-drawer>

    <el-drawer v-model="templateCenterVisible" title="模板中心" size="860px">
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
  grid-template-columns: minmax(0, 1.9fr) minmax(380px, 0.9fr);
  gap: 16px;
  align-items: stretch;
  grid-template-rows: 210px minmax(520px, 1fr);
  min-height: 760px;
  height: calc(100vh - 132px);
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
  min-height: 0;
  overflow: hidden;
  align-content: start;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

.product-context-card {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr) 136px;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 12px;
  height: 100%;
  padding: 14px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.07);
}

.context-thumb {
  grid-row: 1;
  display: grid;
  place-items: center;
  min-height: 120px;
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
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
  font-size: 12px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-actions {
  display: grid;
  gap: 8px;
  align-content: start;
}

.context-status-bar {
  grid-column: 1 / -1;
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  padding: 8px 10px;
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

.generation-panel {
  grid-column: 2;
  grid-row: 1 / span 2;
  display: grid;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  grid-template-rows: auto auto minmax(250px, 1fr);
  align-content: stretch;
  overflow: auto;
  padding-right: 2px;
}

.canvas-area {
  grid-column: 1;
  grid-row: 2;
}

.assistant-identity-card {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 20px;
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.18), rgba(18, 183, 106, 0.10)),
    #fff;
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.08);
}

.assistant-identity-card span {
  color: #175cd3;
  font-size: 12px;
  font-weight: 800;
}

.assistant-identity-card strong {
  font-size: 16px;
}

.assistant-identity-card p {
  margin: 0;
  color: #475467;
  font-size: 12px;
  line-height: 1.45;
}

.ai-flow-card {
  display: grid;
  gap: 9px;
  padding: 12px;
  border: 0;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06);
}

.flow-step-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
}

.flow-step-head > span {
  padding: 4px 8px;
  border-radius: 999px;
  background: #eaf4ff;
  color: #175cd3;
  font-size: 11px;
  font-weight: 800;
}

.flow-step-head strong {
  display: block;
  color: #101828;
}

.flow-step-head em {
  display: block;
  margin-top: 2px;
  color: #667085;
  font-size: 11px;
  font-style: normal;
}

.hero-objective-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}

.commerce-mode-stack,
.commerce-mode-card {
  display: grid;
  gap: 10px;
}

.commerce-mode-card {
  padding: 8px;
  border-radius: 16px;
  background: #f8fbff;
}

.commerce-mode-card > div:first-child strong,
.category-rule-card strong {
  display: block;
}

.commerce-mode-card > div:first-child span,
.category-rule-card span {
  display: block;
  margin-top: 3px;
  color: #667085;
  font-size: 12px;
}

.hero-objective-grid button {
  display: grid;
  gap: 2px;
  min-height: 54px;
  padding: 8px;
  border: 1px solid #e4eaf2;
  border-radius: 16px;
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

.recommendation-card {
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.12), rgba(18, 183, 106, 0.08)),
    #fff;
}

.recommendation-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.recommendation-list button {
  display: grid;
  gap: 2px;
  padding: 7px 8px;
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

.analysis-list {
  display: grid;
  gap: 5px;
}

.analysis-list p {
  margin: 0;
  color: #344054;
  font-size: 12px;
}

.ai-analysis-card .category-rule-card {
  display: grid;
}

.category-rule-card,
.strategy-summary-card {
  display: grid;
  gap: 6px;
  padding: 10px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.82);
}

.strategy-summary-card p {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 6px;
  margin: 0;
  font-size: 11px;
}

.strategy-summary-card span {
  color: #667085;
}

.strategy-summary-card strong {
  color: #344054;
  font-weight: 600;
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

.drawer-source-fields {
  display: grid;
  overflow: visible;
  padding-right: 0;
}

.product-card > .card-title,
.product-card > .el-alert,
.product-card > .product-summary-strip,
.product-card > .source-field-grid,
.product-card > .current-assets-card,
.product-card > .ai-plan-card {
  display: none;
}

.product-card > .more-fields-collapse {
  display: none;
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

.featured-assets {
  order: -1;
  padding: 10px;
  border: 0;
  background:
    linear-gradient(180deg, rgba(64, 158, 255, 0.08), rgba(255, 255, 255, 0.96)),
    #fff;
  box-shadow: 0 18px 42px rgba(15, 23, 42, 0.08);
}

.product-card {
  grid-template-rows: auto auto auto auto auto;
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

.writeback-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
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
  grid-template-rows: auto auto minmax(0, 1fr);
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
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(64, 158, 255, 0.08), rgba(18, 183, 106, 0.05)),
    rgba(255, 255, 255, 0.96);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06);
}

.generation-config-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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

.generation-config-head em {
  color: #667085;
  font-size: 12px;
  font-style: normal;
}

.inline-config-tabs :deep(.el-tabs__header) {
  margin-bottom: 8px;
}

.inline-style-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

.inline-output-layout {
  display: grid;
  grid-template-columns: minmax(360px, 0.78fr) minmax(0, 1.22fr);
  gap: 12px;
  align-items: start;
}

.inline-targets {
  display: grid;
  gap: 8px;
}

.inline-asset-groups {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.inline-asset-groups .asset-check-group {
  align-content: start;
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
  grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.85fr);
  grid-template-areas:
    "images copy"
    "images writeback";
  gap: 12px;
  min-height: 100%;
}

.asset-result-sections.image-only-results {
  grid-template-columns: 1fr;
  grid-template-areas: "images";
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
  gap: 10px;
  max-height: 360px;
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
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
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

.source-product-cell {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
}

.source-product-cell :deep(.erp-image-preview) {
  width: 72px;
  min-width: 72px;
  max-width: 72px;
  height: 72px;
  min-height: 72px;
  max-height: 72px;
  flex-basis: 72px;
  border-radius: 10px;
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
  aspect-ratio: 1;
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
  aspect-ratio: 1;
  flex-basis: auto;
  border-radius: 12px;
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
  .workbench-columns,
  .template-center {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .canvas-area {
    grid-column: 1 / -1;
    position: static;
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
  .workbench-columns,
  .template-center {
    grid-template-columns: 1fr;
  }

  .source-field-grid,
  .inline-fields,
  .inline-fields.package-fields {
    grid-template-columns: 1fr;
  }
}
</style>
