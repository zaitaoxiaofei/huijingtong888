export const AI_SKILLS_DISABLED_MESSAGE = "请先选择有效企业空间后使用 AI 技能库";
const pages = [
  "/ai-variant-lab", "/ai-variant-cases", "/ai-product-material-optimizer",
  "/ai-ecommerce-suite", "/workflow-materials", "/product-workflows", "/ai-material-optimization-records",
  "/ai-materials", "/ai-prompts", "/settings/prompts", "/settings/materials"
];
const resources = new Set(["ai", "ai-generation", "ai-variant-lab", "ai-material-optimization", "ai-variant-draft-save", "asset-variant-engine", "product-workflows"]);

export function aiSkillsAvailable(subject) {
  return Number.isSafeInteger(Number(subject?.tenant?.id)) && Number(subject.tenant.id) > 0 && Boolean(String(subject.tenant.slug || "").trim());
}
export function isAiSkillsPage(path = "") {
  const pathname = String(path).split(/[?#]/)[0];
  return pages.some(page => pathname === page || pathname.startsWith(page + "/"));
}
export function aiSkillsApiDecision(session, parts, method = "GET") {
  if (parts[1] === 'asset-variant-engine' && parts.length === 3 && ['rules','tail-templates'].includes(parts[2]) && String(method).toUpperCase() === 'POST') return { allowed: true };
  if (!session?.tenant?.id || !resources.has(parts[1]) || ["GET", "HEAD"].includes(String(method).toUpperCase()) || parts.at(-1) === "cancel" || aiSkillsAvailable(session)) return { allowed: true };
  return { allowed: false, code: "AI_SKILLS_DISABLED", error: AI_SKILLS_DISABLED_MESSAGE };
}
export function assertAiSkillsAvailable(session) {
  if (!aiSkillsAvailable(session)) throw Object.assign(new Error(AI_SKILLS_DISABLED_MESSAGE), { status: 403, statusCode: 403, code: "AI_SKILLS_DISABLED" });
}
