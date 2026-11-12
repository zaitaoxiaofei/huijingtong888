import {VEHICLE_BRAND_CHINESE} from './vehicle-brand.js';
const vehicleBrands={...VEHICLE_BRAND_CHINESE,...Object.fromEntries(['JELAND','VOLGA','ESTEO','EXLANTIX','JETTA','ICAR','ICAUR'].map(brand=>[brand,brand]))};
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

export function variantSharedSourceBrand(source, target) {
  const identity=variantVehicleIdentity(source).toLowerCase();
  return Object.entries(vehicleBrands).some(([brand,chinese]) =>
    [brand,chinese].some(alias=>alias.toLowerCase()===identity) && variantCopyContainsIdentity(target,brand));
}

export function variantForeignBrands(text, target) {
  return Object.entries(vehicleBrands)
    .filter(([brand,chinese])=>!variantCopyContainsIdentity(target,brand)&&!variantCopyContainsIdentity(target,chinese))
    .filter(([brand,chinese])=>variantCopyContainsIdentity(text,brand)||variantCopyContainsIdentity(text,chinese))
    .map(([brand])=>brand);
}

export function assertVariantCopyIdentity(copy, {source = '', target = '', sourceTitle = '', productTitle = sourceTitle} = {}) {
  const sourceIdentity = variantVehicleIdentity(source);
  const targetIdentity = variantVehicleIdentity(target);
  if (!targetIdentity) return;
  const distinct = sourceIdentity.toLowerCase() !== targetIdentity.toLowerCase() && !variantSharedSourceBrand(sourceIdentity,targetIdentity);
  const escapeTarget = text => String(text || '').replace(new RegExp(targetIdentity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_]+/g, '[\\s_]*'), 'giu'), '');
  for (const [name, value] of [['标题', copy.title], ['描述', copy.description], ['标签', (copy.tags || []).join(' ')]]) {
    if(variantUnrelatedCopy(value,productTitle))throw Object.assign(new Error(`${name}混入其他产品类目的内容，请重新生成该行文案后保存。`),{status:422});
    const sourceRefs=variantVehicleReferences(sourceTitle).filter(ref=>ref.toLowerCase()!==targetIdentity.toLowerCase());
    if(sourceRefs.some(ref=>variantCopyContainsIdentity(escapeTarget(value),ref)))throw Object.assign(new Error(`${name}残留母商品中的其他型号，请重新生成该行文案后保存。`),{status:422});
    const foreignBrands=variantForeignBrands(value,targetIdentity);
    if(foreignBrands.length)throw Object.assign(new Error(`${name}混入其他汽车品牌 ${foreignBrands.join('、')}，请重新生成该行文案后保存。`),{status:422});
    if (distinct && sourceIdentity && variantCopyContainsIdentity(escapeTarget(value), sourceIdentity)) {
      throw Object.assign(new Error(`${name}残留母商品型号 ${sourceIdentity}，请重新生成该行文案后保存。`), {status:422});
    }
    const targetPresent = name === '标签'
      ? (targetIdentity.match(/[\p{L}\p{N}-]+/gu)||[]).every(part => variantCopyContainsIdentity(value, part))
      : variantCopyContainsIdentity(value, targetIdentity);
    if (!targetPresent) {
      throw Object.assign(new Error(`${name}缺少目标品牌型号 ${targetIdentity}，请重新生成该行文案后保存。`), {status:422});
    }
  }
}

export function variantVehicleReferences(text = '') {
  const refs=[];
  for(const brand of Object.keys(vehicleBrands)) {
    const escaped=brand.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/[-\s]+/g,'[-\\s]+');
    const re=new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})\\s+([A-Za-z0-9][A-Za-z0-9_-]*(?:\\s+(?:[A-Z]\\d{2,4}|\\d{1,4}|Plus|Pro|Max|Sport|Coupe|Class|Series)){0,3})(?=$|[^\\p{L}\\p{N}])`,'giu');
    for(const match of String(text).matchAll(re))refs.push(`${match[2]} ${match[3]}`);
  }
  return [...new Set(refs)];
}

export function variantUnrelatedCopy(text, productTitle = '') {
  const value=String(text||'').replace(/_/g,' '),product=String(productTitle||'');
  const automotive=/ключ|брелок|порог|дворник|стеклоочист|key.?case|sill|threshold|wiper|钥匙|门槛/iu.test(product);
  if(automotive&&/mi\s*band|фитнес\s*трек|браслет\s*(?:для\s*)?час|ремешок\s*(?:для\s*)?час/iu.test(value))return true;
  const keyCase=/ключ|брелок|key.?case|钥匙/iu.test(product);
  const wiper=/дворник|стеклоочист|wiper/iu.test(product);
  const sill=/порог|sill|threshold|门槛/iu.test(product);
  if(keyCase&&!sill&&/порог|накладк.{0,12}двер/iu.test(value))return true;
  if(wiper&&!sill&&/порог/iu.test(value))return true;
  if((sill||wiper)&&!keyCase&&/чехол.{0,15}ключ|чехол.{0,15}брелок/iu.test(value))return true;
  return false;
}
