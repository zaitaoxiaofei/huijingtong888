import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
const exec = promisify(execFile);
const root = 'ozon-erp-collector-plugin/';

test('the unified manifest packages the invoice workspace and preserves existing entry points', async () => {
  const manifest = JSON.parse(await fs.readFile(root + 'manifest.json', 'utf8'));
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.background.type, undefined);
  assert.ok(manifest.host_permissions.includes('https://mobile.pinduoduo.com/*'));
  assert.ok(manifest.content_scripts.some(s => s.js?.includes('pdd-invoice/content.js')));
  assert.ok(manifest.content_scripts.some(s => s.js?.includes('seller-bridge-content.js')));
  assert.ok(manifest.content_scripts.some(s => s.js?.includes('content.js')));
  const scripts = ['background.js', 'popup.html', 'pdd-invoice/dashboard.html', 'finance-archive.html', ...manifest.content_scripts.flatMap(s => s.js || [])];
  for (const file of scripts) assert.ok((await fs.stat(root + file)).isFile(), file);
});

test('generated invoice assets are deterministic and contain the compact layout and both pagers', async () => {
  const files = ['background.js', 'content.js', 'core.js', 'dashboard.html', 'dashboard.js', 'dashboard.css', 'README.md'];
  const before = await Promise.all(files.map(f => fs.readFile(root + 'pdd-invoice/' + f)));
  await exec(process.execPath, ['scripts/sync-unified-pdd-invoice.mjs']);
  for (const [i, file] of files.entries()) assert.deepEqual(await fs.readFile(root + 'pdd-invoice/' + file), before[i], file);
  const html = before[3].toString();
  const js = before[4].toString();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of [...js.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1])) assert.ok(ids.includes(id), id);
  for (const id of ['pageSize', 'pageSizeTop', 'pageJump', 'pageJumpTop', 'previousPage', 'previousPageTop', 'nextPage', 'nextPageTop']) assert.ok(ids.includes(id), id);
});
