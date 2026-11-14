import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const context = vm.createContext({
  customerMessageRuDeliveryWindow: () => '', customerMessageDeliveryWindow: () => '',
  customerUniqueIdFromPosting: () => '', orderCustomerStatusLabelRu: () => '',
  orderCustomerStatusLabel: () => '', customerMessageRuDate: () => '', customerMessageDateIso: () => ''
});
vm.runInContext(source.slice(source.indexOf('function customerMessageProductNames('), source.indexOf('\nasync function customerMessageTemplatesByScenarioMysql(')), context);
vm.runInContext(source.slice(source.indexOf('function defaultCustomerMessageTemplatesMysql('), source.indexOf('\nexport async function customerMessageSettingsMysql(')), context);
const title = 'Комплект накладок на пороги TENET T7/T8, черный, нержавеющая сталь, 8 шт.';

test('single product preserves every comma in both languages and never invents extra products', () => {
  for (const row of [{ product_names: title }, { product_names_json: JSON.stringify([title]), item_quantity: 1 }, { product_names_json: [title], item_quantity: 4 }]) {
    assert.equal(context.customerMessageProductSummary(row), title);
    assert.equal(context.customerMessageRuProduct(row), title);
  }
});

test('structured products define boundaries; duplicates, nulls and broken legacy data are safe', () => {
  const row = { product_names_json: [title, 'Чехол, черный', title, null] };
  assert.equal(context.customerMessageRuProduct(row), `${title}, а также ещё один товар`);
  assert.equal(context.customerMessageProductSummary(row), `${title}等 2 件商品`);
  assert.equal(context.customerMessageRuProduct({ product_names_json: [title, 'B', 'C', 'D'] }), `${title}, а также ещё 3 товара`);
  assert.equal(context.customerMessageRuProduct({ product_names_json: 'broken', product_names: title }), title);
  assert.equal(context.customerMessageRuProduct({ product_names_json: [null] }), 'ваш товар');
});

test('all default templates render a comma-containing single product correctly in both languages', () => {
  for (const template of context.defaultCustomerMessageTemplatesMysql()) {
    for (const [locale, field] of [['ru', 'template_text'], ['zh', 'template_translation']]) {
      const rendered = context.renderCustomerMessageTemplate(template[field], { posting_number: '83981107-0185-1', product_names_json: [title], item_quantity: 1 }, locale);
      if (template[field].includes('{{product_summary}}')) assert.ok(rendered.includes(title), `${template.scenario} ${locale}`);
      assert.doesNotMatch(rendered, /а также ещё|等 \d+ 件商品/);
    }
  }
});

test('saved promotion templates upgrade only the old window and keep custom copy and settings', () => {
  const templates = context.mergeCustomerMessageTemplatesMysql([
    { scenario: 'order_promo', enabled: 1, delay_hours: 3, template_text: 'Особый текст: доставка может занять на 2–4 недели больше.', template_translation: '自定义：可能额外延迟 2–4 周。' },
    { scenario: 'order_update', template_text: '2–4 недели', template_translation: '2–4 周' }
  ]);
  const promo = templates.get('order_promo');
  assert.equal(promo.template_text, 'Особый текст: доставка может занять на 1–2 недели больше.');
  assert.equal(promo.template_translation, '自定义：可能额外延迟 1–2 周。');
  assert.equal(promo.enabled, true);
  assert.equal(promo.delay_hours, 3);
  assert.equal(templates.get('order_update').template_text, '2–4 недели');
});

test('all customer-message aggregate queries provide structured product names', () => {
  const queries = source.split('\n').filter(line => line.includes('AS product_names,') && line.includes('NULLIF(oi.ozon_name'));
  assert.equal(queries.length, 4);
  assert.equal((source.match(/JSON_ARRAYAGG\(COALESCE\(NULLIF\(oi\.ozon_name/g) || []).length, 4);
  assert.ok(source.includes('item_summary.product_names_json'));
});
