import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync('ozon-erp-collector-plugin/content.js', 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const render = vm.runInNewContext(
  section('  function escapeHtml(', '  function prettyJson(')
  + section('  function renderProductDataPanel(', '  function renderCardPanel(')
  + '\nrenderProductDataPanel', {
    buildCardMetricRows: () => [], renderDetailScreeningPanel: () => '', pageSku: () => '',
    state: { watchedSkus: new Set() }, chrome: { runtime: {} }, bindProductPanelActions() {}
  });
function panelFor(route) {
  const panel = { dataset: {}, innerHTML: '' };
  render(panel, { sku: 'sku', erpLookup: { collectionRoute: route } });
  return panel.innerHTML;
}

test('the real card renderer distinguishes ECS browser dispatch, legacy pool and browser fallback', () => {
  const dispatched = panelFor({ mode: 'browser_pool', shopName: '来源店铺', companyId: '1001', durationMs: 2500 });
  assert.match(dispatched, /class="ozon-erp-collection-route is-pool"/);
  assert.match(dispatched, />ECS 调度 · 来源店铺 · 2\.5秒</);
  assert.doesNotMatch(dispatched, /浏览器回退|ECS 直连/);
  assert.match(panelFor({ mode: 'browser_pool', companyId: '1001' }), />ECS 调度 · 1001</);
  const legacy = panelFor({ mode: 'pool', workerCount: 3, shopName: '旧号池', durationMs: 1000 });
  assert.match(legacy, /class="ozon-erp-collection-route is-pool"/);
  assert.match(legacy, />号池 3 · 旧号池 · 1\.0秒</);
  const fallback = panelFor({ mode: 'browser_fallback', workerCount: 2, status: 403, durationMs: 500 });
  assert.match(fallback, /class="ozon-erp-collection-route is-fallback"/);
  assert.match(fallback, />浏览器回退 · 号池 2 · HTTP 403 · 0\.5秒</);
  assert.doesNotMatch(panelFor(null), /ozon-erp-collection-route/);
});

test('source names and diagnostic titles remain escaped in every route mode', () => {
  for (const mode of ['browser_pool', 'pool', 'browser_fallback']) {
    const html = panelFor({ mode, shopName: '<img src=x onerror="bad">', companyId: '1001', warning: '" onclick="bad<&' });
    assert.doesNotMatch(html, /<img src=x|title="" onclick=/);
    assert.match(html, /title="&quot; onclick=&quot;bad&lt;&amp;"/);
    if (mode !== 'browser_fallback') assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
  }
});
