import { createSession, destroySession } from "../src/server/session.js";
import { mysqlQuery } from "../src/mysql-pool.js";

const baseUrl = "http://127.0.0.1:8788";
const draftId = 2425;
const title = "Органайзер за центральным экраном для Geely EX5 EM-i, лоток из ABS с силиконовой вставкой, черный";
const tags = [
  "#органайзер_для_авто", "#органайзер_за_экраном", "#Geely_EX5", "#Geely_EM_i",
  "#хранение_в_авто", "#лоток_для_авто", "#полка_для_авто", "#аксессуары_Geely",
  "#органайзер_в_салон", "#место_для_телефона", "#место_для_ключей", "#ABS_пластик",
  "#силиконовая_вставка", "#порядок_в_салоне", "#автоаксессуары"
];
const description = [
  "Органайзер разработан для установки за центральным экраном автомобиля Geely EX5 EM-i. Он помогает использовать свободное пространство панели и держать необходимые мелочи под рукой, не загромождая салон.",
  "Корпус изготовлен из ABS-пластика, а контактная поверхность выполнена из силикона. В лотке удобно хранить смартфон, ключи и другие небольшие предметы, которыми водитель и пассажиры пользуются каждый день.",
  "Форма органайзера соответствует зоне за экраном Geely EX5 EM-i. Черный цвет аккуратно сочетается с интерьером автомобиля, а бортики помогают предметам оставаться внутри лотка во время поездки.",
  "Перед покупкой проверьте модель автомобиля и форму центрального экрана. В комплект входит один органайзер. Товар предназначен для хранения небольших предметов в салоне автомобиля."
].join(" ");

let token = "";
async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    body: options.body == null || typeof options.body === "string" ? options.body : JSON.stringify(options.body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} (${response.status}): ${data?.error || text}`);
  return data;
}

try {
  const [draftOwner] = await mysqlQuery(`
    SELECT p.id, p.name, p.role, p.username
    FROM listing_drafts d
    JOIN people p ON p.id = d.created_by_person_id
    WHERE d.id = ?
    LIMIT 1
  `, [draftId]);
  if (!draftOwner) throw new Error("找不到草稿创建人");
  token = await createSession(draftOwner.id, draftOwner.name, draftOwner.role, draftOwner.username);
  const draft = await api(`/api/listing/drafts/${draftId}`);
  const payload = draft.template_payload || {};
  const editable = payload.editable_payload || {};
  const images = draft.effective_images || draft.source_images || editable.images || [];
  const synchronizeCopyAttributes = (attributes = []) => (Array.isArray(attributes) ? attributes : []).map((attribute) => {
    const attributeId = Number(attribute.attribute_id || attribute.attributeId || attribute.id || 0);
    const attributeName = String(attribute.name_zh || attribute.nameZh || attribute.name || "").toLowerCase();
    if (attributeId === 4191 || /(简介|description|аннотация|описание)/i.test(attributeName)) return { ...attribute, value: description, label: description, display_value_zh: description, values: [{ value: description, label: description }], selected_values: [{ value: description, label: description }] };
    if (attributeId === 23171 || /(产品标签|主题标签|关键词|ключевые слова|тег)/i.test(attributeName)) return { ...attribute, value: tags, label: tags.join(" "), display_value_zh: tags.join(" "), values: tags.map((tag) => ({ value: tag, label: tag })), selected_values: tags.map((tag) => ({ value: tag, label: tag })) };
    return attribute;
  });
  const synchronizedAttributes = synchronizeCopyAttributes(editable.attributes?.length ? editable.attributes : payload.attributes);
  const synchronizedCategoryAttributes = synchronizeCopyAttributes(editable.category_attributes?.length ? editable.category_attributes : payload.category_attributes);
  const synchronizeDynamicAttributes = (attributes = {}) => Object.fromEntries(Object.entries(attributes || {}).map(([key, attribute]) => {
    if (Number(key) === 4191) return [key, synchronizeCopyAttributes([{ ...attribute, attribute_id: 4191 }])[0]];
    if (Number(key) === 23171) return [key, synchronizeCopyAttributes([{ ...attribute, attribute_id: 23171 }])[0]];
    return [key, synchronizeCopyAttributes([attribute])[0] || attribute];
  }));
  const variants = (Array.isArray(editable.variants) && editable.variants.length ? editable.variants : [{}]).map((variant) => ({
    ...variant,
    title,
    name: title,
    description,
    tags,
    hashtags: tags,
    main_tags: tags,
    dynamic_attributes: synchronizeDynamicAttributes(variant.dynamic_attributes)
  }));
  const saved = await api(`/api/listing/drafts/${draftId}`, {
    method: "PUT",
    body: {
      ...draft,
      product_name: title,
      template_payload: {
        ...payload,
        title,
        description,
        attributes: synchronizedAttributes,
        category_attributes: synchronizedCategoryAttributes,
        images: editable.images || payload.images,
        editable_payload: { ...editable, title, name: title, description, tags, hashtags: tags, logistics: { ...(editable.logistics || {}), tags }, attributes: synchronizedAttributes, category_attributes: synchronizedCategoryAttributes, variants }
      },
      manual_facts: {
        ...(draft.manual_facts || {}),
        title,
        description,
        tags,
        chinese_review: {
          title: "适用于吉利 EX5 EM-i 的中控屏幕后方收纳盒，ABS 主体配硅胶接触面，黑色",
          description: "安装在中控屏幕后方，可收纳手机、钥匙等车内小物；ABS 塑料主体，接触面为硅胶。"
        }
      },
      source_images: images
    }
  });
  const savedEditable = saved.template_payload?.editable_payload || {};
  console.log(JSON.stringify({
    ok: true,
    draftId: saved.id,
    productName: saved.product_name,
    templateId: saved.template_id,
    categoryId: saved.ozon_category_id,
    categoryName: saved.category_name,
    imageCount: (saved.effective_images || saved.source_images || []).length,
    title: savedEditable.title,
    tags: savedEditable.tags,
    descriptionLength: String(savedEditable.description || "").length
  }, null, 2));
} finally {
  if (token) await destroySession(token).catch(() => {});
  process.exit(0);
}
