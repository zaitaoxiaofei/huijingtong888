import { buildProductDNA } from "./productDna.js";
import { buildVariantStrategy, parseVariantTarget } from "./variantStrategy.js";

export function fieldInstructionFromStrategy(variantStrategy = {}, field = "") {
  const rules = variantStrategy.fieldRules || {};
  if (field === "mainImage") return rules.mainImage || "";
  if (field === "detailImages") return rules.detailImages || "";
  return rules[field] || "";
}

export function buildPromptVariables(row, field, options = {}) {
  const product = row?.product || {};
  const productDNA = options.productDNA || buildProductDNA(product, row);
  const variantStrategy = options.variantStrategy || buildVariantStrategy();
  const target = options.target || row?.variantTargetInfo || parseVariantTarget(row?.variantTarget || product.model || product.brand || "");
  return {
    productDNA,
    variantStrategy,
    field,
    target,
    sourceProduct: options.sourceProduct || product,
    currentRow: row,
    globalPrompt: options.globalPrompt ?? variantStrategy.globalPrompt ?? "",
    fieldPrompt: options.fieldPrompt || "",
    fieldInstruction: options.fieldInstruction ?? fieldInstructionFromStrategy(variantStrategy, field),
    riskRules: options.riskRules || variantStrategy.riskRules || {}
  };
}

export function templateVariablesForRender(promptVariables = {}) {
  const dna = promptVariables.productDNA || {};
  const target = promptVariables.target || {};
  const sourceProduct = promptVariables.sourceProduct || {};
  const variantStrategy = promptVariables.variantStrategy || {};
  const riskRules = promptVariables.riskRules || {};
  const fieldPrompt = promptVariables.fieldPrompt || "";
  const globalPrompt = promptVariables.globalPrompt || "";
  return {
    productDNA: JSON.stringify(dna),
    variantStrategy: JSON.stringify(variantStrategy),
    field: promptVariables.field || "",
    target: JSON.stringify(target),
    sourceProduct: JSON.stringify(sourceProduct),
    globalPrompt,
    fieldPrompt,
    fieldInstruction: promptVariables.fieldInstruction || "",
    riskRules: JSON.stringify(riskRules),
    product_name: dna.base?.title || sourceProduct.name || sourceProduct.title || "",
    brand: dna.base?.brand || sourceProduct.brand || "",
    variant_value: target.label || "",
    variant_type: variantStrategy.variantType || "",
    vehicle_model: target.label || dna.base?.model || sourceProduct.model || "",
    target_brand: target.brand || dna.base?.brand || sourceProduct.brand || "",
    target_model: target.model || target.label || dna.base?.model || sourceProduct.model || "",
    audience: (variantStrategy.variantType === "audience" ? target.label : "") || "",
    scene: (variantStrategy.variantType === "scene" ? target.label : "") || "",
    material: dna.base?.material || "",
    color: dna.base?.color || "",
    selling_points: Array.isArray(dna.sellingPoints) ? dna.sellingPoints.join("\n") : "",
    ozon_category: dna.base?.category || dna.ozon?.categoryId || "",
    user_prompt: [fieldPrompt, globalPrompt].filter(Boolean).join("\n"),
    field_prompt: fieldPrompt,
    ratio: "3:4",
    known_facts: dna.constraints?.knownFacts?.join("\n") || "",
    unknown_facts: dna.constraints?.unknownFacts?.join("\n") || "",
    no_fabrication_rules: dna.constraints?.noFabricationRules?.join("\n") || "",
    negative_prompt: riskRules.negativePrompt || ""
  };
}

export function appendSafetyRules(renderedPrompt = "", promptVariables = {}) {
  const dnaRules = promptVariables.productDNA?.constraints?.noFabricationRules || [];
  const unknownFacts = promptVariables.productDNA?.constraints?.unknownFacts || [];
  const riskNegative = promptVariables.riskRules?.negativePrompt || "";
  return [
    renderedPrompt,
    dnaRules.length ? `No fabrication rules:\n${dnaRules.join("\n")}` : "",
    unknownFacts.length ? `Unknown facts must not be invented:\n${unknownFacts.join("\n")}` : "",
    riskNegative ? `Negative rules:\n${riskNegative}` : ""
  ].filter(Boolean).join("\n");
}

export function normalizeRenderedPromptResult(rendered = {}, template = null) {
  return {
    renderedPrompt: [
      String(rendered?.finalPositivePrompt || "").trim(),
      String(rendered?.finalNegativePrompt || "").trim()
    ].filter(Boolean).join("\n"),
    template: rendered?.template || template
  };
}
