export const AI_SKILLS_DISABLED_MESSAGE = "当前企业暂未开放 AI 技能库，开放时间请联系平台管理员";
const pages = [
  "/ai-variant-lab", "/ai-variant-cases", "/ai-product-material-optimizer", "/asset-variant-center",
  "/ai-ecommerce-suite", "/workflow-materials", "/product-workflows", "/ai-material-optimization-records",
  "/ai-materials", "/ai-prompts", "/settings/prompts", "/settings/materials"
];
const resources = new Set(["ai", "ai-generation", "ai-variant-lab", "ai-material-optimization", "ai-variant-draft-save", "asset-variant-engine", "product-workflows"]);

export function aiSkillsAvailable(subject) {
  return Number.isSafeInteger(Number(subject?.tenant?.id)) && Number(subject.tenant.id) > 0 && subject.tenant.slug === "default";
}
export function isAiSkillsPage(path = "") {
  const pathname = String(path).split(/[?#]/)[0];
  return pages.some(page => pathname === page || pathname.startsWith(page + "/"));
}
export function aiSkillsApiDecision(session, parts, method = "GET") {
  if (!session?.tenant?.id || !resources.has(parts[1]) || ["GET", "HEAD"].includes(String(method).toUpperCase()) || parts.at(-1) === "cancel" || aiSkillsAvailable(session)) return { allowed: true };
  return { allowed: false, code: "AI_SKILLS_DISABLED", error: AI_SKILLS_DISABLED_MESSAGE };
}
export function assertAiSkillsAvailable(session) {
  if (!aiSkillsAvailable(session)) throw Object.assign(new Error(AI_SKILLS_DISABLED_MESSAGE), { status: 403, statusCode: 403, code: "AI_SKILLS_DISABLED" });
}
