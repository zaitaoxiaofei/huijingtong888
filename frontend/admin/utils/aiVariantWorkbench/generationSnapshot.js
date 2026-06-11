export function buildGenerationSnapshot({
  row = null,
  field = "",
  promptVariables = {},
  renderedPrompt = "",
  templateSource = "legacy-inline-prompt",
  templateId = "",
  templateVersion = "",
  globalNegativeTemplateId = "",
  globalNegativeTemplateVersion = "",
  fallbackReason = "",
  generatedAt = new Date().toISOString()
} = {}) {
  const storablePromptVariables = {
    ...promptVariables,
    currentRow: currentRowSummary(row)
  };
  return {
    productDNA: promptVariables.productDNA,
    variantStrategy: promptVariables.variantStrategy,
    field,
    target: promptVariables.target,
    promptVariables: storablePromptVariables,
    renderedPrompt,
    templateSource,
    templateId,
    templateVersion,
    globalNegativeTemplateId,
    globalNegativeTemplateVersion,
    fallbackReason,
    generatedAt
  };
}

function currentRowSummary(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.productId,
    sourceProductId: row.sourceProductId,
    variantTarget: row.variantTarget,
    variantType: row.variantType,
    title: row.title,
    tags: row.tags,
    description: row.description
  };
}
