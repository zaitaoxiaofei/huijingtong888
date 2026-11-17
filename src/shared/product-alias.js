export function normalizeProductAlias(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('商品别名必须是文字，清空时请填写空字符串'), { statusCode: 400 });
  const text = value.trim();
  if (Array.from(text).length > 500) throw Object.assign(new Error('商品别名最多500个字'), { statusCode: 400 });
  return text;
}
