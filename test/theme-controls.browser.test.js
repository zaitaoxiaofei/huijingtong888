import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { parse, compileStyle } from '@vue/compiler-sfc';
import { chromium } from 'playwright-core';
import { getThemePreset } from '../frontend/admin/utils/theme-presets.js';

const enabled = process.env.RUN_THEME_BROWSER_TESTS === '1';
const types = ['', 'primary', 'success', 'warning', 'danger', 'info'];
const variants = ['default', 'plain', 'link', 'text', 'disabled', 'disabled-plain', 'disabled-link'];
const schemes = ['light', 'dark'].flatMap(mode => ['blue', 'teal', 'violet'].map(palette => ({ mode, palette })));
const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(', ')})`;
const contrast = (a, b) => {
  const luminance = color => {
    const [r, g, blue] = color.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return r * 0.2126 + g * 0.7152 + blue * 0.0722;
  };
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

// Render the real Element Plus controls against the application's source styles.
// All modules are fulfilled from an in-memory Vite bundle: no listener, business API or DB.
test('shared controls keep readable paired colors and selected states in all six appearance presets', { skip: !enabled, timeout: 180000 }, async () => {
  const appDescriptor = parse(await fs.readFile(new URL('../frontend/admin/App.vue', import.meta.url), 'utf8')).descriptor;
  const appCss = appDescriptor.styles.map(style => {
    const result = compileStyle({ source: style.content, filename: 'App.vue', id: 'data-v-theme-toast-fixture', scoped: style.scoped });
    assert.deepEqual(result.errors, []);
    return result.code;
  }).join('\n');
  const fixture = `<script setup>
    import { ref } from 'vue';
    const types = ${JSON.stringify(types)}, variants = ${JSON.stringify(variants)};
    const statuses = ['wait', 'process', 'finish', 'success', 'error'];
    const radio = ref('one'), single = ref('one'), checked = ref(true), segment = ref('one'), choice = ref('one');
    const date = ref('2026-10-22'), month = ref('2026-10');
  </script><template>
    <main class="theme-controls-fixture">
      <section class="fixture-panel"><h1>Shared theme controls</h1>
        <div v-for="type in types" :key="type" class="button-row">
          <el-button v-for="variant in variants" :key="variant" :type="type || undefined" :plain="variant==='plain'||variant==='disabled-plain'" :link="variant==='link'||variant==='disabled-link'" :text="variant==='text'" :disabled="variant.startsWith('disabled')" :data-qa="(type||'default')+'-'+variant">{{ type||'default' }} {{ variant }}</el-button>
        </div>
      <div class="button-row"><el-button class="erp-btn erp-btn-primary" data-qa="erp-primary">ERP primary</el-button><el-button type="success" class="erp-btn erp-btn-secondary" data-qa="erp-success-secondary">ERP success secondary</el-button><el-button class="erp-btn erp-btn-danger" data-qa="erp-danger">ERP danger</el-button><el-button class="erp-btn erp-btn-link-danger" link data-qa="erp-danger-link">ERP danger link</el-button></div>
      </section>
      <section class="fixture-panel"><div class="page-card-header"><span>Panel metadata</span><el-button type="primary" data-qa="header-primary">Header primary action</el-button></div><div class="erp-update-toast__body">Update details <button class="erp-update-toast__link" data-qa="toast-link">View update</button><button class="erp-update-toast__primary" data-qa="toast-primary">Install update</button></div>
        <div class="erp-tab-context-menu" style="position:static"><button class="erp-tab-context-menu__item" data-qa="tab-menu">Close tab</button><button class="erp-tab-context-menu__item is-danger" data-qa="tab-menu-danger">Close others</button></div>
      </section>
      <section class="fixture-panel selections"><h2>Selection and date controls</h2>
        <el-radio-group v-model="radio" data-qa="radio-buttons"><el-radio-button value="one">First</el-radio-button><el-radio-button value="two">Second</el-radio-button></el-radio-group>
        <el-radio-group v-model="single" data-qa="radios"><el-radio value="one">First radio</el-radio><el-radio value="two">Second radio</el-radio></el-radio-group>
        <el-checkbox v-model="checked" data-qa="checkbox">Selected checkbox</el-checkbox>
        <el-segmented v-model="segment" :options="[{label:'First segment',value:'one'},{label:'Second segment',value:'two'}]" data-qa="segments" />
        <el-select v-model="choice" data-qa="select" style="width:180px"><el-option label="First option" value="one"/><el-option label="Second option" value="two"/></el-select>
        <div data-qa="date"><el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" /></div>
        <div data-qa="month"><el-date-picker v-model="month" type="month" value-format="YYYY-MM" /></div>
      </section>
      <section class="fixture-panel"><h2>Semantic state text</h2>
        <el-steps :space="260"><el-step v-for="status in statuses" :key="status" :status="status" :title="status+' step'" :description="status+' description'"/></el-steps>
        <div class="alert-grid"><template v-for="effect in ['light','dark']" :key="effect"><el-alert v-for="type in ['success','warning','error','info']" :key="type" :type="type" :effect="effect" :title="type+' '+effect+' alert'" description="Readable status description" :closable="false" show-icon :data-qa="'alert-'+type+'-'+effect"/></template></div>
        <div class="tags"><template v-for="effect in ['light','dark','plain']" :key="effect"><el-tag v-for="type in ['primary','success','warning','danger','info']" :key="type" :type="type" :effect="effect" :data-qa="'tag-'+type+'-'+effect">{{type}} {{effect}}</el-tag></template></div>
        <el-empty description="No records yet" :image-size="60" />
      </section>
    </main>
  </template><style scoped>
    .theme-controls-fixture { padding:20px; color:var(--erp-text-main); background:var(--erp-bg); }
    .fixture-panel { margin-bottom:16px; padding:18px; border:1px solid var(--erp-border); border-radius:8px; background:var(--erp-surface); }
    h1,h2 { margin:0 0 14px; font-size:18px; }
    .button-row,.selections,.tags { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin:10px 0; }
    .selections h2 { width:100%; }.alert-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:18px 0; }
  </style>`;
  const entry = `import{createApp}from'vue';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import'/FixtureAppStyles.css';import Fixture from'/ThemeControlsFixture.vue';import{applyAppearancePreferences}from'/frontend/admin/utils/theme-presets.js';window.setFixtureTheme=({mode,palette})=>applyAppearancePreferences({version:1,mode,palettes:{light:palette,dark:palette}},document);createApp(Fixture).use(ElementPlus).mount('#app');`;
  const bundle = await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: 'error', plugins: [vue(), {
    name: 'shared-theme-controls-fixture',
    resolveId(id) { if (['virtual:theme-controls', '/ThemeControlsFixture.vue', '/FixtureAppStyles.css'].includes(id)) return id === 'virtual:theme-controls' ? '\0theme-controls' : id; },
    load(id) { if (id === '\0theme-controls') return entry; if (id === '/ThemeControlsFixture.vue') return fixture; if (id === '/FixtureAppStyles.css') return appCss; }
  }], build: { write: false, cssCodeSplit: false, rollupOptions: { input: 'virtual:theme-controls', output: { entryFileNames: 'entry.js' } } } });
  const assets = new Map(bundle.output.map(item => [item.fileName, item.type === 'asset' ? item.source : item.code]));
  const css = [...assets.keys()].find(name => name.endsWith('.css'));
  const artifactDirectory = process.env.THEME_BROWSER_ARTIFACT_DIR ? path.resolve(process.env.THEME_BROWSER_ARTIFACT_DIR) : null;
  if (artifactDirectory) await fs.mkdir(artifactDirectory, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium'), headless: true });
  const failures = [], results = [], pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1560, height: 1180 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, 'http://localhost:8788', 'theme fixture loads no external resources');
      assert.ok(!url.pathname.startsWith('/api/'), 'theme fixture calls no business APIs');
      if (url.pathname === '/admin.html') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      const body = assets.get(url.pathname.slice(1));
      assert.notEqual(body, undefined, `source asset ${url.pathname}`);
      return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
    });
    await page.goto('http://localhost:8788/admin.html');
    await page.locator('[data-qa="primary-default"]').waitFor();
    const sample = async (locator, pseudo) => locator.evaluate((element, pseudo) => {
      const rgba = value => value.match(/[\d.]+/g).map(Number);
      const over = (foreground, background) => foreground.slice(0, 3).map((value, index) => value * (foreground[3] ?? 1) + background[index] * (1 - (foreground[3] ?? 1)));
      const background = element => {
        const color = rgba(getComputedStyle(element).backgroundColor);
        return color[3] === 1 || color.length === 3 ? color.slice(0, 3) : over(color, element.parentElement ? background(element.parentElement) : [255, 255, 255]);
      };
      const style = getComputedStyle(element, pseudo || null), bg = pseudo ? over(rgba(style.backgroundColor), background(element)) : background(element);
      const foreground = over(rgba(style.color), bg);
      return { color: foreground, background: bg, rawColor: style.color, rawBackground: style.backgroundColor, border: style.borderColor, disabled: element.disabled === true };
    }, pseudo);
    const buttonTextSample = async locator => { const label = locator.locator(':scope > span').first(); return sample(await label.count() ? label : locator); };
    const readable = (label, value, scheme) => {
      const ratio = contrast(value.color, value.background);
      if (ratio < 4.5) failures.push({ ...scheme, label, ratio: Number(ratio.toFixed(3)), color: value.rawColor, background: `rgb(${value.background.join(', ')})` });
      return { label, ratio, ...value };
    };
    for (const scheme of schemes) {
      await page.evaluate(scheme => window.setFixtureTheme(scheme), scheme);
      const result = { ...scheme, measurements: [] }, preset = getThemePreset(scheme.mode, scheme.palette);
      await page.mouse.move(0, 0);
      for (const type of types) for (const variant of variants) {
        const label = `${type || 'default'}-${variant}`, locator = page.locator(`[data-qa="${label}"]`);
        const idle = await sample(locator);
        if (variant.startsWith('disabled')) { assert.equal(idle.disabled, true, 'disabled variants remain native disabled controls'); result.measurements.push({ label, ...idle }); continue; }
        result.measurements.push(readable(label, await buttonTextSample(locator), scheme));
        await locator.hover();
        result.measurements.push(readable(label + ':hover', await buttonTextSample(locator), scheme));
      }
      for (const label of ['erp-primary','erp-success-secondary','erp-danger','erp-danger-link','header-primary']) {
        const locator = page.locator('[data-qa="' + label + '"]');
        result.measurements.push(readable(label, await buttonTextSample(locator), scheme));
        await locator.hover();
        result.measurements.push(readable(label + ':hover', await buttonTextSample(locator), scheme));
      }
      for (const label of ['toast-link','toast-primary','tab-menu','tab-menu-danger']) {
        const locator = page.locator('[data-qa="' + label + '"]'), idle = await sample(locator);
        result.measurements.push(readable(label, idle, scheme));
        await locator.hover();
        const hovered = await sample(locator);
        result.measurements.push(readable(label + ':hover', hovered, scheme));
        if (label.startsWith('tab-menu')) assert.notDeepEqual(hovered.background, idle.background, 'tab menu hover remains visible');
      }
      const primary = await sample(page.locator('[data-qa="primary-default"]'));
      assert.equal(primary.rawColor, rgb(preset.tokens['primary-contrast']), `${scheme.mode}/${scheme.palette}: primary button contrast follows palette`);
      for (const selector of ['.el-radio-button.is-active .el-radio-button__inner', '[data-qa="radios"] .el-radio__label', '[data-qa="checkbox"] .el-checkbox__label']) {
        result.measurements.push(readable(selector, await sample(page.locator(selector).first()), scheme));
      }
      const segment = await sample(page.locator('.el-segmented__item.is-selected .el-segmented__item-label'));
      segment.background = (await sample(page.locator('.el-segmented__item-selected'))).background;
      result.measurements.push(readable('selected segment', segment, scheme));
      const selectedRadio = await sample(page.locator('.el-radio-button.is-active .el-radio-button__inner'));
      assert.equal(selectedRadio.rawBackground, rgb(preset.tokens['primary-fill']));
      assert.equal(selectedRadio.rawColor, rgb(preset.tokens['primary-contrast']));
      const checkbox = await sample(page.locator('[data-qa="checkbox"] .el-checkbox__inner'), '::after');
      const radioDot = await sample(page.locator('[data-qa="radios"] .el-radio__input.is-checked .el-radio__inner'), '::after');
      assert.equal(radioDot.rawBackground, rgb(preset.tokens['primary-contrast']), 'selected radio dot uses paired contrast color');
      assert.equal(checkbox.border, rgb(preset.tokens['primary-contrast']), 'selected checkbox check uses paired contrast color');
      const statusText = page.locator('.el-alert__title,.el-alert__description,.el-step__title,.el-step__description,.el-empty__description p,.el-tag');
      for (let index = 0; index < await statusText.count(); index++) {
        const locator = statusText.nth(index);
        const label = await locator.evaluate(element => { const qa = element.closest('[data-qa]')?.getAttribute('data-qa'); return qa ? `${qa} ${element.className}` : element.textContent.trim(); });
        result.measurements.push(readable(label, await sample(locator), scheme));
      }
      await page.locator('[data-qa="select"]').click();
      const option = page.getByRole('option', { name: 'First option', exact: true });
      await option.waitFor();
      result.measurements.push(readable('selected dropdown option', await sample(option), scheme));
      await page.keyboard.press('Escape');
      for (const picker of ['date', 'month']) {
        await page.locator(`[data-qa="${picker}"] input`).click();
        const selected = page.locator(picker === 'date' ? '.el-date-table td.current .el-date-table-cell__text' : '.el-month-table td.current .el-date-table-cell__text').filter({ visible: true });
        await selected.waitFor();
        result.measurements.push(readable('selected ' + picker, await sample(selected), scheme));
        if (artifactDirectory) await page.screenshot({ path: path.join(artifactDirectory, `${scheme.mode}-${scheme.palette}-${picker}.png`) });
        await page.keyboard.press('Escape');
      }
      if (artifactDirectory) await page.screenshot({ path: path.join(artifactDirectory, `${scheme.mode}-${scheme.palette}-controls.png`), fullPage: true });
      results.push(result);
    }
    if (artifactDirectory) await fs.writeFile(path.join(artifactDirectory, 'results.json'), JSON.stringify({ schemes: results, failures, pageErrors }, null, 2));
    assert.deepEqual(pageErrors, [], 'real shared controls produce no runtime errors');
    assert.equal(failures.length, 0, 'Enabled shared controls and status text must reach 4.5:1 text contrast:\n' + failures.map(({mode,palette,label,ratio}) => `${mode}/${palette} ${label}: ${ratio}`).join('\n'));
  } finally { await browser.close(); }
});
