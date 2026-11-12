// Identity fields may contain an operator's note after a comma. Notes are not
// part of a vehicle model and must not participate in exact replacement.
export function variantVehicleIdentity(value = '') {
  return String(value || '').split(/[,，;；\n]/u)[0].replace(/\s*[（(]([^()（）]*)[)）]\s*$/u, (note, text) => /\p{Script=Han}|buttons?|key|кноп/iu.test(text) ? '' : note).replace(/\s+/g, ' ').trim();
}

export function variantCopyContainsIdentity(text = '', identity = '') {
  const parts = variantVehicleIdentity(identity).split(/[\s_-]+/u).filter(Boolean);
  if (!parts.length) return false;
  const escaped = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]*');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(String(text));
}

export function assertVariantCopyIdentity(copy, {source = '', target = ''} = {}) {
  const sourceIdentity = variantVehicleIdentity(source);
  const targetIdentity = variantVehicleIdentity(target);
  if (!targetIdentity) return;
  const distinct = sourceIdentity.toLowerCase() !== targetIdentity.toLowerCase();
  const escapeTarget = text => String(text || '').replace(new RegExp(targetIdentity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_]+/g, '[\\s_]*'), 'giu'), '');
  for (const [name, value] of [['标题', copy.title], ['描述', copy.description], ['标签', (copy.tags || []).join(' ')]]) {
    if (distinct && sourceIdentity && variantCopyContainsIdentity(escapeTarget(value), sourceIdentity)) {
      throw Object.assign(new Error(`${name}残留母商品型号 ${sourceIdentity}，请重新生成该行文案后保存。`), {status:422});
    }
    const targetPresent = name === '标签'
      ? targetIdentity.split(/\s+/u).every(part => variantCopyContainsIdentity(value, part))
      : variantCopyContainsIdentity(value, targetIdentity);
    if (!targetPresent) {
      throw Object.assign(new Error(`${name}缺少目标品牌型号 ${targetIdentity}，请重新生成该行文案后保存。`), {status:422});
    }
  }
}
