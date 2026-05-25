import client, { assertOpenAiConfigured, getOpenAiConfigStatus } from "./openaiClient.js";

export const STYLE_TEMPLATES = {
  "Ozon高点击主图": "Russian Ozon e-commerce main image, high click-through rate, premium automotive accessory, clean composition, product centered, clear selling points, realistic product photography, 3:4 vertical layout",
  "高端质感主图": "premium dark automotive style, luxury product photography, soft studio lighting, realistic material texture, sharp product edges, high-end SUV background, clean typography area",
  "白底产品图": "pure white background, product-only photography, centered composition, no scene, no clutter, clear product details, factory reference image",
  "详情页场景图": "e-commerce detail page module, feature explanation, installation scenario, material close-up, Russian market design, clean layout, separated card blocks"
};

export const NEGATIVE_PROMPT = "low quality, blurry, distorted product, wrong logo, wrong vehicle model, unreadable text, messy layout, extra objects, unrealistic material, plastic toy look";

const SYSTEM_PROMPT = [
  "你是俄罗斯 Ozon 汽车配件电商视觉设计专家，擅长生成高点击率主图和详情页图片提示词。",
  "你必须只返回 JSON，不要返回 Markdown、解释或散文。",
  "finalPrompt 必须是英文，适合直接提交给图片生成模型。",
  "detailPagePlan 使用中文短句。"
].join("\n");

export async function optimizeImagePrompt(payload = {}) {
  assertOpenAiConfigured();
  const input = normalizePromptInput(payload);
  const { textModel } = getOpenAiConfigStatus();
  const styleKeywords = STYLE_TEMPLATES[input.style] || input.style || STYLE_TEMPLATES["Ozon高点击主图"];

  const completion = await client.chat.completions.create({
    model: textModel,
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "根据输入生成 Ozon 电商图片提示词 JSON。",
          outputShape: {
            finalPrompt: "string",
            negativePrompt: "string",
            titleSuggestion: "string",
            detailPagePlan: ["主图展示角度", "卖点页1", "卖点页2"]
          },
          rules: [
            "明确产品主体",
            "明确适用车型",
            "明确 Russian Ozon e-commerce style",
            "明确画面比例、背景、光影、构图",
            "明确避免错误车型、错误文字、低质感、变形产品",
            "如果是套图，让每个模块之间有明显 white/light gaps，方便自动裁切"
          ],
          styleKeywords,
          negativePrompt: NEGATIVE_PROMPT,
          input
        })
      }
    ]
  });

  return normalizePromptResult(completion.choices?.[0]?.message?.content, input, styleKeywords);
}

export function buildFallbackPrompt(payload = {}) {
  const input = normalizePromptInput(payload);
  const styleKeywords = STYLE_TEMPLATES[input.style] || input.style || STYLE_TEMPLATES["Ozon高点击主图"];
  const finalPrompt = [
    `Create a professional Russian Ozon e-commerce automotive accessory image set.`,
    `Product subject: ${input.productName || "automotive accessory"}.`,
    input.vehicleModel ? `Compatible vehicle model: ${input.vehicleModel}.` : "",
    input.sellingPoints ? `Key selling points: ${input.sellingPoints}.` : "",
    styleKeywords,
    `Aspect ratio: ${input.ratio}.`,
    "Use clean composition, realistic product photography, premium material texture, clear white or light gaps between modules for automatic cropping.",
    input.userPrompt ? `Additional user direction: ${input.userPrompt}.` : "",
    `Avoid: ${NEGATIVE_PROMPT}.`
  ].filter(Boolean).join(" ");

  return {
    finalPrompt,
    negativePrompt: NEGATIVE_PROMPT,
    titleSuggestion: input.productName ? `${input.productName} Ozon主图方案` : "Ozon汽车配件主图方案",
    detailPagePlan: ["主图展示角度", "卖点页1", "卖点页2"]
  };
}

function normalizePromptResult(rawContent, input, styleKeywords) {
  try {
    const parsed = JSON.parse(String(rawContent || "{}"));
    return {
      finalPrompt: cleanText(parsed.finalPrompt) || buildFallbackPrompt(input).finalPrompt,
      negativePrompt: cleanText(parsed.negativePrompt) || NEGATIVE_PROMPT,
      titleSuggestion: cleanText(parsed.titleSuggestion) || buildFallbackPrompt(input).titleSuggestion,
      detailPagePlan: Array.isArray(parsed.detailPagePlan) && parsed.detailPagePlan.length
        ? parsed.detailPagePlan.map((item) => cleanText(item)).filter(Boolean).slice(0, 8)
        : ["主图展示角度", "卖点页1", "卖点页2"]
    };
  } catch (error) {
    console.error("OpenAI prompt JSON parse failed", { error, rawContent, styleKeywords });
    return buildFallbackPrompt(input);
  }
}

export function normalizePromptInput(payload = {}) {
  return {
    productName: cleanText(payload.productName),
    vehicleModel: cleanText(payload.vehicleModel || payload.carModel),
    sellingPoints: cleanText(payload.sellingPoints),
    style: cleanText(payload.style) || "Ozon高点击主图",
    ratio: ["3:4", "1:1", "4:5"].includes(String(payload.ratio || "").trim()) ? String(payload.ratio).trim() : "3:4",
    imageCount: clampImageCount(payload.imageCount ?? payload.count),
    userPrompt: cleanText(payload.userPrompt || payload.prompt)
  };
}

export function clampImageCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(3, Math.max(1, parsed));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1800);
}
