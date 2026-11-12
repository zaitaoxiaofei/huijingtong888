export function workflowProductImageInput(definition) {
  const editable = (definition.nodes || []).filter(node => node.type === 'images'
    && node.scope !== 'shared' && node.inputGroup !== 'listing-final'
    && !['engineer', 'generated'].includes(node.valueSource)
    && (node.referenceRole === 'product' || node.id === 'product' && !node.referenceRole));
  return editable.find(node => node.id === 'product') || editable[0];
}

// Resolve every destination before uploading, so capacity errors cannot leave a
// partially imported selection. Existing cards and their facts remain in place.
export function planWorkflowProductImport({ definition, variants, files, rowId, slot = 0 }) {
  const images = Array.from(files || []).filter(file => /\.(png|jpe?g|webp)$/i.test(file.name));
  if (!images.length) throw new Error('请选择 JPG、PNG 或 WEBP 产品图片');
  const node = workflowProductImageInput(definition);
  if (!node) throw new Error('模板尚未配置可编辑的逐件产品图，请在流程编辑器添加产品参考图片');
  if (!Number.isInteger(node.count) || node.count < 1 || !Array.isArray(node.slots) || node.slots.length !== node.count) throw new Error('产品图槽位配置无效，请在流程编辑器核对图片数量与用途');
  if (!Number.isInteger(slot) || slot < 0 || slot >= node.count) throw new Error('产品图片槽位无效，请重新选择上传位置');
  if (slot > 0 && images.length > 1) throw new Error('补充角度一次上传一张图片；批量添加产品请使用主图位置');
  const frozen = row => row.submissionStarted || row.submittedId;
  const target = rowId == null ? null : variants.find(row => row.id === rowId);
  if (rowId != null && !target) throw new Error('产品卡片已移除，请重新选择上传位置');
  if (target && frozen(target)) throw new Error('这件产品已提交，不能替换生产材料');
  const available = variants.filter(row => row !== target && !frozen(row) && !row.values?.[node.id]?.[0]);
  const placements = images.map((file, index) => ({
    file,
    rowId: index === 0 && target ? target.id : available.shift()?.id ?? null,
    slot: index === 0 && target ? slot : 0
  }));
  if (variants.length + placements.filter(item => item.rowId == null).length > 20) throw new Error('本批最多 20 件产品，请减少图片或移除多余卡片后重试');
  return { node, placements };
}
