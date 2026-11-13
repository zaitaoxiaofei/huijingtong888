const missingText = '商品／上架模板缺少完整的 Ozon 描述类目（description_category_id）和商品类型（type_id），不能读取必填属性。请在「商品上架／模板编辑」重新选择 Ozon 类目与商品类型；单独的旧 category_id 不能替代这两个字段。';
export const ozonCategoryIdentityError = (detail = '') => Object.assign(new Error(detail ? `${detail}。${missingText}` : missingText), { statusCode: 409 });

function id(value) {
  if (value == null || value === '' || value === 0 || value === '0') return 0;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value).trim())) throw ozonCategoryIdentityError('类目或商品编号格式无效');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw ozonCategoryIdentityError('类目或商品编号超出有效范围');
  return number;
}

export function readOzonCategoryIdentity(value = {}) {
  const descriptionCategoryId = id(value.descriptionCategoryId || value.description_category_id || value.ozon_description_category_id);
  const typeId = id(value.typeId || value.type_id || value.ozon_type_id || value.description_type_dict_value);
  // A complete current/manual choice takes precedence over a stale legacy key.
  if (descriptionCategoryId && typeId) return { descriptionCategoryId, typeId };
  const key = value.ozon_category_id || value.categoryId || value.category_id;
  if (typeof key === 'string' && key.includes(':')) {
    const pair = key.trim().match(/^(\d+):(\d+)$/);
    if (!pair) throw ozonCategoryIdentityError('旧类目组合编号格式无效');
    const description = id(pair[1]), type = id(pair[2]);
    if (!description || !type || (descriptionCategoryId && descriptionCategoryId !== description) || (typeId && typeId !== type)) {
      throw ozonCategoryIdentityError('旧类目组合编号与当前类目字段不一致');
    }
    return { descriptionCategoryId: description, typeId: type };
  }
  return { descriptionCategoryId, typeId };
}

export function ozonCategoryProductRefs(value = {}) {
  const productId = id(value.productId || value.product_id || value.ozon_product_id);
  const offerId = String(value.offerId || value.offer_id || '').trim();
  const sku = String(value.sku || value.ozon_sku || '').trim();
  if (sku && (!/^\d+$/.test(sku) || BigInt(sku) <= 0n || BigInt(sku) > 18446744073709551615n)) throw ozonCategoryIdentityError('原商品 SKU 无效');
  return { productId, offerId, sku };
}

export function findOzonCategoryProduct(rows, refs) {
  const matches = rows.filter(row => (!refs.productId || String(row.id ?? row.product_id) === String(refs.productId))
    && (!refs.offerId || String(row.offer_id) === refs.offerId)
    && (!refs.sku || String(row.sku ?? row.ozon_sku) === refs.sku));
  if (matches.length !== 1) throw ozonCategoryIdentityError('未取得唯一且编号一致的同店铺原商品，请核对商品编号或货号');
  return matches[0];
}
