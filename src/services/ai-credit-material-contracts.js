import { buildCopyFactsContract } from "../server/services/ai/copyFactsContract.js";
import { validateCopyBundle } from "../server/services/ai/copyQualityValidator.js";

// Validate original provider replies before any legacy normalizer can fill
// missing fields. These are pure preparation contracts, not charging hooks:
// analysis, plan and review do not independently bill the customer. Final
// workflow delivery needs its own acceptance gate. These checks are not proof
// that every visual fact or translation is correct. Unknown facts may stay
// empty; this module must not invent compatibility, material or quantity.
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;
const CYRILLIC = /[А-Яа-яЁё]/u;
const BROKEN = /[\uFFFD\u952F\u9416\u920B\u93C3]|\u6D60\?|\?{4,}/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const SHOT_ROLES = new Set(["main", "material", "installation", "structure", "benefit", "closeup", "size"]);
const COPY_SUBJECTS = new Set(["wiper_base_pad", "sill_plate", "key_case", "bumper_guard"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 && !BROKEN.test(value) && !CONTROL.test(value);
}

function chinese(value) { return text(value) && CJK.test(value); }
function russian(value) { return text(value) && CYRILLIC.test(value) && !CJK.test(value); }
function english(value) { return text(value) && /[A-Za-z]/u.test(value) && !CJK.test(value); }
function optionalText(value) { return typeof value === "string" && (!value.trim() || text(value)); }
function optionalRussian(value) { return typeof value === "string" && (!value.trim() || russian(value)); }
function list(value, check = text, min = 0, max = Infinity) {
  return Array.isArray(value) && value.length >= min && value.length <= max && value.every(check);
}
function fields(value, keys, check = text) { return object(value) && keys.every(key => check(value[key])); }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }

function reply(content) {
  if (typeof content !== "string" || content.length > 2 * 1024 * 1024) return null;
  try {
    const value = JSON.parse(content);
    return object(value) && value.parse_error !== true && value.fallback !== true && !BROKEN.test(JSON.stringify(value)) ? value : null;
  } catch { return null; }
}

export function validateMaterialAnalysis(content) {
  const value = reply(content);
  if (!value || !chinese(value.product_type) || !Number.isFinite(value.confidence)) return false;
  if (!list(value.visible_texts)) return false;
  if (!["keep_facts", "current_problems", "improvement_opportunities", "forbidden_changes", "optimization_goals", "quality_risks"].every(key => list(value[key], chinese))) return false;
  const decision = value.decision_context;
  if (!fields(decision, ["exact_product_subtype"], chinese)
    || !optionalText(decision.target_buyer_or_compatibility)
    || !list(decision.purchase_decision_order, chinese, 3, 5)
    || !list(decision.verified_differentiators, chinese)
    || !fields(decision, ["visual_category", "price_positioning", "communication_tone"])) return false;
  return fields(value.display_zh, ["recognition_summary", "product_type", "main_image_observation", "detail_image_observation", "recommended_action"], chinese)
    && list(value.display_zh.fixed_facts, chinese);
}

function validShot(shot) {
  if (!fields(shot, ["role", "typography_role"]) || !SHOT_ROLES.has(shot.role)) return false;
  if (!fields(shot, ["title_zh", "objective_zh"], chinese)
    || !fields(shot, ["composition_en", "must_show_en", "typography_direction_en"], english)
    || !russian(shot.overlay_text_ru) || /ozon|озон/iu.test(shot.overlay_text_ru)) return false;
  const words = shot.overlay_text_ru.trim().split(/\s+/u).length;
  return words >= 2 && words <= 5;
}

export function validateMaterialPlan(content) {
  const value = reply(content);
  if (!value || !text(value.optimization_type)) return false;
  if (!["keep_facts", "current_problems", "optimization_goals", "forbidden_changes", "quality_checks"].every(key => list(value[key], chinese))) return false;
  if (!fields(value, ["image_optimization_prompt_en", "negative_prompt_en"], english)
    || !fields(value, ["title_improvement_prompt_ru", "tags_improvement_prompt_ru", "description_improvement_prompt_ru"], russian)
    || !object(value.cost_policy)) return false;
  const strategy = value.copy_strategy;
  if (!fields(strategy, ["exact_subject_ru"], russian)
    || !list(strategy.title_information_order)
    || !list(strategy.verified_benefits_ru, russian)
    || !list(strategy.forbidden_generic_phrases_ru, russian)
    || !list(strategy.per_shot_message_rules)) return false;
  const visual = value.visual_language;
  if (!fields(visual, ["tone", "headline_style", "accent_style", "alignment"])
    || !list(visual.hierarchy) || !list(visual.avoid)
    || !["font_weights", "max_headline_lines", "max_benefit_words"].every(key => positiveInteger(visual[key]))) return false;
  const overlay = value.main_overlay_ru;
  if (!fields(overlay, ["title_ru"], russian) || !optionalRussian(overlay.compatibility_ru) || !list(overlay.benefits_ru, russian, 2, 3)) return false;
  if (!list(value.main_visual_directions, direction => fields(direction, ["title_zh"], chinese) && fields(direction, ["direction_en"], english), 2, 2)
    || !list(value.suite_storyboard, validShot, 4, 5) || value.suite_storyboard[0].role !== "main") return false;
  const display = value.display_zh;
  return fields(display, ["main_image_plan", "detail_image_plan", "title_plan", "tags_plan", "description_plan"], chinese)
    && list(display.forbidden_changes, chinese) && list(display.quality_checks, chinese)
    && list(display.suite_storyboard, shot => chinese(shot) || fields(shot, ["title_zh", "objective_zh"], chinese), 1);
}

export function validateMaterialReview(content) {
  const value = reply(content);
  if (!value || typeof value.pass !== "boolean" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100
    || !list(value.issues_zh, chinese) || !optionalText(value.corrections_en) || !object(value.checks)) return false;
  // A negative verdict is a completed review, not a failed provider call. This
  // validator neither accepts the final image nor settles a customer charge.
  return value.pass ? (!value.corrections_en.trim() || english(value.corrections_en))
    : value.issues_zh.length > 0 && english(value.corrections_en);
}

function factKey(value) { return String(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }

export function createMaterialCopyValidator({ draft = {}, operatorFacts = {} } = {}) {
  const compatibility = Array.isArray(operatorFacts.compatibility_zh) ? [...operatorFacts.compatibility_zh] : [];
  const ready = operatorFacts.confirmed_by_operator === true && chinese(operatorFacts.product_title_zh)
    && list(operatorFacts.selling_points_zh, chinese, 2) && compatibility.every(text);
  const contract = buildCopyFactsContract({ draft, targetModel: compatibility[0] });
  // The legacy subject dictionary has four reviewed product families. Its
  // generic fallback merely copies words from an old title; that is not a
  // trusted cross-language product identity for charging external customers.
  const subject = contract.productSubject;
  const supported = COPY_SUBJECTS.has(subject?.key) && list(subject?.requiredAny, text, 1);
  if (!supported) {
    throw Object.assign(new Error("当前商品缺少可验证的产品主体规则，暂不支持付费素材优化；请先配置经核对的商品品类契约"), {
      code: "AI_CREDIT_CAPABILITY_DISABLED", status: 409
    });
  }
  const latinFacts = [contract.targetModel, ...compatibility, ...(contract.material?.match(/[A-Za-z][A-Za-z0-9-]*/gu) || [])].filter(Boolean).map(factKey);
  return content => {
    const value = reply(content);
    if (!ready || !supported || !value) return false;
    if (!list(value.titles, russian, 2, 2) || !russian(value.description)
      || !list(value.tags, tag => text(tag) && /^#[^\s#]+$/u.test(tag) && tag.length < 30 && !CJK.test(tag)
        && (CYRILLIC.test(tag) || latinFacts.includes(factKey(tag))), 15, 20)) return false;
    if (new Set(value.tags.map(factKey)).size !== value.tags.length) return false;
    const words = value.description.match(/[A-Za-zА-Яа-яЁё0-9-]+/gu) || [];
    if (words.length < 150 || words.length > 250) return false;
    if (!chinese(value.titleZh) || CYRILLIC.test(value.titleZh)
      || !chinese(value.descriptionZh) || CYRILLIC.test(value.descriptionZh)
      || !list(value.tagsZh, translation => chinese(translation) && !CYRILLIC.test(translation), value.tags.length, value.tags.length)) return false;
    return value.titles.every(title => {
      // Reuse the dictionary's complete subject rule: a generic shared word
      // such as "накладка" must not disguise a wrong product in one title.
      if (!subject.match.every(pattern => pattern.test(title))) return false;
      return [contract.targetModel, ...compatibility].filter(Boolean).every(model => factKey(title).includes(factKey(model)))
        && validateCopyBundle({ title, tags: value.tags, description: value.description }, contract).passed;
    });
  };
}
