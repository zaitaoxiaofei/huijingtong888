import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/auth-password.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA, AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA } from '../src/services/ai-material-optimization-schema.js';

test('complete HTTP service keeps enterprise isolation through login, switching and restart', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL and dedicated port 8788', timeout: 240000
}, async t => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(8788, '127.0.0.1', resolve));
  await new Promise(resolve => probe.close(resolve));
  const fixture = await createTenantMysqlFixture('http_pilot');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ozon-http-pilot-'));
  const base = 'http://127.0.0.1:8788', password = `Pilot-${randomUUID()}!`;
  let child, output = '', attachmentUrl;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    child = null;
  };
  const start = async () => {
    output = '';
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
      cwd: directory, windowsHide: true,
      env: { ...process.env, ...fixture.env, HOST: '127.0.0.1', APP_BASE_URL: base,
        SCHEDULED_JOBS_ENABLED: '0', DEPLOYMENT_CANDIDATE: '1', BACKGROUND_OZON_STOCK_SYNC_ENABLED: 'false',
        BACKGROUND_OZON_CATEGORY_SYNC_ENABLED: 'false', UPLOADS_ROOT: path.join(directory, 'uploads'), SITE_ACCESS_PASSWORD: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-16000); });
    child.once('exit', (code, signal) => {
      if (code !== null && code !== 0) t.diagnostic(`Isolated HTTP child exited (${code}, ${signal || 'no signal'}): ${output}`);
    });
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`Isolated HTTP startup failed: ${output}`);
      try {
        const response = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(1500) });
        if (response.ok && (await response.json()).ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Isolated HTTP readiness timeout: ${output}`);
  };
  const request = async (url, token, method = 'GET', body) => {
    const response = await fetch(base + url, { method, signal: AbortSignal.timeout(20000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  };
  const login = async id => {
    const result = await request('/api/auth/login', '', 'POST', { username: `pilot${id}`, password });
    assert.equal(result.status, 200);
    assert.ok(result.data.token, `Fixture account ${id} should log in: ${result.data.error || ''}`);
    return result.data;
  };
  try {
    await fixture.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    for (const id of [1, 2, 3, 4, 5]) {
      await fixture.query('INSERT INTO people(id,name,username,password_hash,role) VALUES(?,?,?,?,?)', [id, `Pilot ${id}`, `pilot${id}`, hashPassword(password), id === 4 ? 'packing' : 'admin']);
      if (id !== 5) await fixture.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'member',JSON_ARRAY(?))", [id === 4 ? 1 : id, id, id === 4 ? 'packing' : 'admin']);
    }
    await fixture.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(3,2,'member',JSON_ARRAY('admin'))");
    // Explicitly deny paid requests even for the historical default enterprise.
    // The HTTP checks below exercise validation/ownership, never a provider.
    await fixture.query("INSERT INTO tenant_ai_limits(tenant_id,monthly_request_limit) VALUES(1,0),(2,0),(3,0)");
    await fixture.query(AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA);
    await fixture.query(AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA);
    for (const [person, tenant] of [[6, 1], [7, 2], [8, 3]]) {
      await fixture.query('INSERT INTO people(id,name,username,password_hash,role) VALUES(?,?,?,?,?)', [person, `Pilot ${person}`, `pilot${person}`, hashPassword(password), 'operations']);
      await fixture.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'member',JSON_ARRAY('operations'))", [tenant, person]);
    }
    for (const id of [1, 2, 3]) {
      await fixture.query('INSERT INTO shops(id,tenant_id,name) VALUES(?,?,?)', [id * 10, id === 1 ? null : id, `HTTP own shop ${id}`]);
      await fixture.query('INSERT INTO products(id,tenant_id,name,code) VALUES(?,?,?,?)', [id * 10, id === 1 ? null : id, `HTTP own product ${id}`, `HTTP-${id}`]);
      await fixture.query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,'awaiting_packaging','2026-10-01')", [id * 10, id * 10, `HTTP-order-${id}`]);
      await fixture.query('INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES(?,?,?,?,?)', [id * 10, id * 10, `HTTP-sku-${id}`, 1, id * 100]);
    }
    await start();
    const sessions = new Map();
    await t.test('default staff and both customers still log in; an unjoined account cannot auto-enrol', async () => {
      for (const id of [1, 2, 3, 4]) sessions.set(id, await login(id));
      assert.equal(sessions.get(4).user.tenant.slug, 'default');
      const unjoined = await request('/api/auth/login', '', 'POST', { username: 'pilot5', password });
      assert.ok(!unjoined.data.token);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM tenant_members WHERE person_id=5'))[0].n), 0);
    });
    await t.test('ordinary default and customer operations pass fission route gates through real login without paid calls', async () => {
      for (const id of [6, 7]) {
        const operator = await login(id);
        assert.notEqual(operator.user.platform_role, 'super_admin');
        for (const action of ['analyze-image', 'batch-plan', 'batch-run-images', 'batch-resume-images']) {
          const result = await request(`/api/ai-variant-lab/${action}`, operator.token, 'POST', {});
          assert.equal(result.status, 400, `${id} ${action}: ${JSON.stringify(result.data)}`);
          assert.notEqual(result.data.code, 'TENANT_ISOLATION_PENDING');
        }
        const offer = await request('/api/listing/generate-offer-id', operator.token, 'POST', {});
        assert.equal(offer.status, 200);
        assert.ok(offer.data.offerId);
      }
      const blocked = await request('/api/ai-variant-lab/analyze-image', sessions.get(4).token, 'POST', {});
      assert.equal(blocked.status, 403);
      assert.notEqual(blocked.data.code, 'TENANT_ISOLATION_PENDING');
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM ai_variant_lab_batch_jobs'))[0].n), 0);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM tenant_ai_usage'))[0].n), 0);
    });
    await t.test('ordinary default and A/B operations reach scoped batch publication and media validation without creating external tasks', async () => {
      for (const [person, tenant] of [[6, 1], [7, 2], [8, 3]]) {
        const operator = await login(person);
        assert.notEqual(operator.user.platform_role, 'super_admin');
        const bootstrap = await request('/api/asset-variant-engine/bootstrap?tenant_id=999', operator.token);
        assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.data));
        assert.deepEqual(bootstrap.data.shops.map(shop => Number(shop.id)), [tenant * 10]);
        const configWrite = await request('/api/asset-variant-engine/rules', operator.token, 'POST', { shopId: tenant * 10 });
        assert.equal(configWrite.status, 403);
        for (const endpoint of ['/api/listing/drafts/batch-publish', '/api/listing/media/watermark']) {
          const result = await request(endpoint, operator.token, 'POST', { tenant_id: 999, created_by_person_id: 1 });
          assert.ok([400, 404].includes(result.status), `${person} ${endpoint}: ${JSON.stringify(result.data)}`);
          assert.notEqual(result.data.code, 'TENANT_ISOLATION_PENDING');
        }
        const retry = await request('/api/listing/publish-tasks/12/retry', operator.token, 'POST', {});
        assert.equal(retry.status, 403);
        assert.equal(retry.data.code, 'TENANT_ISOLATION_PENDING');
      }
      for (const endpoint of ['/api/listing/drafts/batch-publish', '/api/listing/media/watermark']) {
        const denied = await request(endpoint, sessions.get(4).token, 'POST', {});
        assert.equal(denied.status, 403);
        assert.notEqual(denied.data.code, 'TENANT_ISOLATION_PENDING');
      }
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_publish_tasks'))[0].n), 0);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_publish_records'))[0].n), 0);
    });
    await t.test('online-product sync admits ordinary operations while rejecting foreign shops before external work', async () => {
      const before = Number((await fixture.query('SELECT COUNT(*) n FROM online_products'))[0].n);
      for (const [person, tenant] of [[6, 1], [7, 2], [8, 3]]) {
        const operator = await login(person);
        const snapshot = await request('/api/sync/online-products/status?tenant_id=999', operator.token);
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data));
        assert.notEqual(snapshot.data.code, 'TENANT_ISOLATION_PENDING');
        const started = await request('/api/sync/online-products', operator.token, 'POST', {
          shop_id: tenant === 2 ? 30 : 20, tenant_id: 999, pending_listing: true
        });
        assert.equal(started.status, 200, JSON.stringify(started.data));
        assert.equal(started.data.started, true);
        let completed;
        for (let attempt = 0; attempt < 100; attempt++) {
          completed = await request('/api/sync/online-products/status', operator.token);
          assert.equal(completed.status, 200, JSON.stringify(completed.data));
          if (!completed.data.running) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(completed.data.running, false);
        assert.match(completed.data.error, /不属于当前企业|不存在/);
      }
      for (const method of ['GET', 'POST']) {
        const result = await request(`/api/sync/online-products${method === 'GET' ? '/status' : ''}`, sessions.get(4).token, method, method === 'POST' ? {} : undefined);
        assert.equal(result.status, 403);
        assert.notEqual(result.data.code, 'TENANT_ISOLATION_PENDING');
      }
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM online_products'))[0].n), before);
    });
    await t.test('HTTP lists/details/mutations use session enterprise and ignore body/query tenant selectors', async () => {
      for (const id of [1, 2, 3, 4]) {
        const expected = id === 4 ? 1 : id, token = sessions.get(id).token;
        const list = await request('/api/orders?paged=1&includeRows=1&tenant_id=3', token);
        assert.equal(list.status, 200, JSON.stringify(list.data));
        assert.equal(Number(list.data.total), 1);
        assert.ok(!JSON.stringify(list.data).includes(`HTTP-order-${expected === 2 ? 3 : 2}`));
        const foreign = await request(`/api/orders/${expected === 2 ? 30 : 20}`, token);
        assert.equal(foreign.status, 404);
        const mark = await request('/api/orders/30/mark', token, 'PUT', { tenant_id: 3, mark_type: 'quality', note: 'must not write' });
        if (expected !== 3) assert.ok([403, 404].includes(mark.status), `Account ${id}, HTTP ${mark.status}: ${JSON.stringify(mark.data)}`);
      }
      const customers = await request('/api/people', sessions.get(2).token);
      assert.equal(customers.status, 200);
      assert.ok(!JSON.stringify(customers.data).includes('Pilot 4'));
      const privateAnonymous = await request('/uploads/team-attachments/unknown.pdf');
      assert.ok([401, 403, 404].includes(privateAnonymous.status));
    });
    await t.test('same login switches A to B and back without reusing a list or task cache', async () => {
      const token = sessions.get(2).token;
      for (const id of [3, 2]) {
        const switched = await request('/api/auth/switch-tenant', token, 'POST', { tenant_id: id });
        assert.equal(switched.status, 200, JSON.stringify(switched.data));
        const list = await request('/api/orders?paged=1&includeRows=1', token);
        assert.equal(list.status, 200);
        assert.ok(JSON.stringify(list.data).includes(`HTTP-order-${id}`));
        assert.ok(!JSON.stringify(list.data).includes(`HTTP-order-${id === 2 ? 3 : 2}`));
      }
      const noMembership = await request('/api/auth/switch-tenant', sessions.get(3).token, 'POST', { tenant_id: 2 });
      assert.ok(noMembership.status >= 400);
    });
    await t.test('daily purchase, direct receipt and manual outbound aliases work for default and customers', async () => {
      for (const id of [1, 2, 3]) {
        const token = sessions.get(id).token, productId = id * 10;
        const bought = await request('/api/procurement/purchases', token, 'POST', {
          tenant_id: id === 2 ? 3 : 2,
          items: [{ product_id: productId, quantity: 2, amount: 12, shipping_amount: 0 }]
        });
        assert.equal(bought.status, 200, JSON.stringify(bought.data));
        const before = await fixture.query('SELECT COUNT(*) n FROM procurement_requests');
        const foreign = await request('/api/procurement/purchases', token, 'POST', {
          items: [{ product_id: id === 2 ? 30 : 20, quantity: 3, amount: 12 }]
        });
        assert.ok([400, 403, 404].includes(foreign.status), JSON.stringify(foreign.data));
        assert.deepEqual(await fixture.query('SELECT COUNT(*) n FROM procurement_requests'), before);
        const created = await request('/api/procurement/requests', token, 'POST', { product_id: productId, quantity: 1, amount: 4 });
        assert.equal(created.status, 200, JSON.stringify(created.data));
        const received = await request('/api/procurement/requests/direct-inbound', token, 'POST', { request_ids: [created.data.id] });
        assert.equal(received.status, 200, JSON.stringify(received.data));
        const moved = await request('/api/inventory/movements', token, 'POST', { product_id: productId, source_type: 'manual_outbound', quantity: 1 });
        assert.equal(moved.status, 200, JSON.stringify(moved.data));
        const updated = await request(`/api/inventory/movements/${moved.data.id}`, token, 'PUT', { product_id: productId, quantity: 2 });
        assert.equal(updated.status, 200, JSON.stringify(updated.data));
        const removed = await request(`/api/inventory/movements/${updated.data.id}`, token, 'DELETE');
        assert.equal(removed.status, 200, JSON.stringify(removed.data));
      }
    });
    await t.test('listing category selection and basic validation remain available to ordinary enterprise operators', async () => {
      for (const id of [1, 2, 3]) {
        const token = sessions.get(id).token;
        const categories = await request('/api/listing/ozon-categories?keyword=pilot-fixture-only', token);
        assert.equal(categories.status, 200, JSON.stringify(categories.data));
        const validation = await request('/api/listing/templates/validate-publish', token, 'POST', { include_category_health: true });
        assert.equal(validation.status, 200, JSON.stringify(validation.data));
        assert.equal(validation.data.ok, false);
        assert.ok(validation.data.errors.length);
      }
    });
    await t.test('ordinary default and customer FBP applications, transfers and barcode PDFs use their own shop', async () => {
      for (const id of [1, 2, 3]) {
        await fixture.query("INSERT INTO online_products(id,shop_id,product_id,ozon_sku,offer_id,ozon_product_id,name,barcodes_json) VALUES(?,?,?,?,?,?,?,JSON_ARRAY('OZN00112233'))",
          [id * 10, id * 10, id * 10, `HTTP-sku-${id}`, `HTTP-offer-${id}`, String(id * 111), `HTTP online ${id}`]);
        await fixture.query('INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,online_product_id,ozon_sku,offer_id) VALUES(?,?,?,?,?,?,?)',
          [id * 10, id === 1 ? null : id, id * 10, id * 10, id * 10, `HTTP-sku-${id}`, `HTTP-offer-${id}`]);
      }
      for (const id of [1, 2, 3]) {
        const token = sessions.get(id).token, ownId = id * 10;
        const opportunities = await request(`/api/fbp-opportunities?manualSku=HTTP-sku-${id}`, token);
        assert.equal(opportunities.status, 200, JSON.stringify(opportunities.data));
        assert.ok(opportunities.data.rows.every(row => Number(row.shop_id) === ownId));
        const created = await request('/api/fbp-replenishment-orders', token, 'POST', { rows: [{ shop_id: ownId, product_id: ownId, mapping_id: ownId, ozon_sku: `HTTP-sku-${id}`, requested_qty: 2 }] });
        assert.equal(created.status, 200, JSON.stringify(created.data));
        const transfer = await request('/api/fbp-transfer-records', token, 'POST', { product_id: ownId, shop_id: ownId, mapping_id: ownId, quantity: 1 });
        assert.equal(transfer.status, 200, JSON.stringify(transfer.data));
        const foreignId = id === 2 ? 3 : 2;
        const foreign = await request('/api/fbp-replenishment-orders', token, 'POST', { rows: [{ shop_id: foreignId * 10, product_id: foreignId * 10,
          mapping_id: foreignId * 10, ozon_sku: `HTTP-sku-${foreignId}`, requested_qty: 2 }] });
        assert.ok([400, 403, 404].includes(foreign.status), `HTTP ${foreign.status}: ${JSON.stringify(foreign.data)}`);
        const label = await fetch(`${base}/api/products/barcode-label`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ online_product_id: ownId, quantity: 1 }), signal: AbortSignal.timeout(20000) });
        assert.equal(label.status, 200);
        assert.match(label.headers.get('content-type'), /application\/pdf/);
        assert.equal(Buffer.from(await label.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
      }
      const shops = await request('/api/shops', sessions.get(2).token);
      assert.equal(shops.status, 200);
      assert.deepEqual(shops.data.map(row => Number(row.id)), [20]);
      assert.ok(shops.data.every(row => !('api_key_hint' in row) && !('ozon_client_id' in row)));
    });
    await t.test('AI optimization exact routes validate ordinary default/A/B requests without paid work or cross-enterprise results', async () => {
      const postCases = [
        ['analysis/lookup', 200], ['analyze', 400], ['analysis/confirm', 400], ['plan', 400],
        ['plan/confirm', 400], ['result', 400], ['review-image', 400], ['compose-text', 400],
        ['test-image', 400], ['prepare-template', 400]
      ];
      for (const [person, tenant] of [[6,1],[7,2],[8,3]]) {
        const key = tenant === 1 ? 'admin' : String(tenant), draft = 9000 + tenant;
        await fixture.query(`INSERT INTO listing_drafts
          (id,tenant_id,product_name,source_urls_json,source_images_json,manual_facts_json,ai_payload_json,created_by_person_id)
          VALUES(?,?,?,'[]','[]','{}','{}',?)`, [draft,key,`Private optimizer draft ${tenant}`,person]);
        await fixture.query(`INSERT INTO ai_image_optimizer_jobs
          (tenant_id,job_no,status,analysis_json,created_by_person_id) VALUES(?,?,'analysis_confirmed',?,?)`,
        [key,`HTTP-OPT-${tenant}`,JSON.stringify({ marker: `Private optimizer ${tenant}` }),person]);
      }
      const countBefore = Number((await fixture.query('SELECT COUNT(*) n FROM ai_image_optimizer_jobs'))[0].n);
      const draftCountBefore = Number((await fixture.query('SELECT COUNT(*) n FROM listing_drafts'))[0].n);
      const templateCountBefore = Number((await fixture.query('SELECT COUNT(*) n FROM listing_category_templates'))[0].n);
      for (const [person, tenant] of [[6,1],[7,2],[8,3]]) {
        const operator = await login(person), foreign = tenant === 2 ? 3 : 2;
        assert.notEqual(operator.user.platform_role, 'super_admin');
        const fissionLookup = await request('/api/ai-variant-lab/analysis/lookup', operator.token, 'POST', {});
        assert.equal(fissionLookup.status, 200, JSON.stringify(fissionLookup.data));
        for (const [action, status] of postCases) {
          const endpoint = `/api/ai-variant-lab/optimize/${action}`;
          const result = await request(endpoint, operator.token, 'POST', { tenant_id: 'forged', created_by_person_id: 1 });
          assert.equal(result.status, status, `${person} ${action}: ${JSON.stringify(result.data)}`);
          assert.notEqual(result.data.code, 'TENANT_ISOLATION_PENDING');
          const refused = await request(endpoint, operator.token, 'POST', {
            sourceDraftId: 9000 + foreign, optimizerJobNo: `HTTP-OPT-${foreign}`, tenant_id: foreign,
            finalImageSlots: [{ url: 'https://must-not-fetch.invalid/private.jpg' }]
          });
          assert.equal(refused.status, 404, `${person} foreign ${action}: ${JSON.stringify(refused.data)}`);
          assert.ok(!JSON.stringify(refused.data).includes(`Private optimizer ${foreign}`));
          const packer = await request(endpoint, sessions.get(4).token, 'POST', {});
          assert.equal(packer.status, 403);
          assert.notEqual(packer.data.code, 'TENANT_ISOLATION_PENDING');
        }
        const own = await request(`/api/ai-variant-lab/optimize/jobs/HTTP-OPT-${tenant}`, operator.token);
        assert.equal(own.status, 200, JSON.stringify(own.data));
        assert.ok(JSON.stringify(own.data).includes(`Private optimizer ${tenant}`));
        const other = await request(`/api/ai-variant-lab/optimize/jobs/HTTP-OPT-${foreign}`, operator.token);
        assert.equal(other.status, 404);
        for (const field of ['sourceDraftId','source_draft_id']) {
          const rejectedSave = await request('/api/listing/drafts/ai-variant-lightweight', operator.token, 'POST', {
            [field]: 9000 + foreign, clone_source_draft: false, tenant_id: foreign, created_by_person_id: 1,
            templatePayload: { title: 'Must not persist foreign save', source_type: 'ai_product_material_optimizer',
              editable_payload: { title: 'Must not persist foreign save', variants: [{ images: [] }] } }
          });
          assert.equal(rejectedSave.status, 404, `${person} ${field}: ${JSON.stringify(rejectedSave.data)}`);
          assert.notEqual(rejectedSave.data.code, 'TENANT_ISOLATION_PENDING');
        }
        for (const [url, method] of [
          ['/api/ai-variant-lab/optimize/plan/extra', 'POST'],
          ['/api/ai-variant-lab/optimize/analysis/confirm', 'PUT'],
          ['/api/ai-variant-lab/optimize/jobs/HTTP-OPT-1', 'POST']
        ]) {
          const blocked = await request(url, operator.token, method, {});
          assert.equal(blocked.status, 403, `${method} ${url}: ${JSON.stringify(blocked.data)}`);
          assert.equal(blocked.data.code, 'TENANT_ISOLATION_PENDING');
        }
      }
      const deniedSave = await request('/api/listing/drafts/ai-variant-lightweight', sessions.get(4).token, 'POST', {});
      assert.equal(deniedSave.status, 403); assert.notEqual(deniedSave.data.code, 'TENANT_ISOLATION_PENDING');
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM ai_image_optimizer_jobs'))[0].n), countBefore);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_drafts'))[0].n), draftCountBefore);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_category_templates'))[0].n), templateCountBefore);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM tenant_ai_usage'))[0].n), 0);
    });
    await t.test('AI optimization final save creates default/A/B drafts and templates under the authenticated enterprise', async () => {
      const beforeDrafts = Number((await fixture.query('SELECT COUNT(*) n FROM listing_drafts'))[0].n);
      const beforeTemplates = Number((await fixture.query('SELECT COUNT(*) n FROM listing_category_templates'))[0].n);
      for (const [person, tenant] of [[6,1],[7,2],[8,3]]) {
        const operator = await login(person), key = tenant === 1 ? 'admin' : String(tenant);
        // Empty image slots are a legitimate incomplete draft. They exercise
        // the deployed save/SQL implementation without any remote media I/O.
        const saved = await request('/api/listing/drafts/ai-variant-lightweight', operator.token, 'POST', {
          source_draft_id: 9000 + tenant, source_product_id: tenant * 10, clone_source_draft: true,
          offer_id: `HTTP-OPT-SAVED-${tenant}`, product_name: `Saved HTTP optimizer ${tenant}`,
          tenant_id: tenant === 2 ? 3 : 2, created_by_person_id: 1,
          source_images: [], patch: { images: [] }, ai_optimization: { source: 'ai_product_material_optimizer' },
          template_payload: { title: `Saved HTTP optimizer ${tenant}`, editable_payload: {
            title: `Saved HTTP optimizer ${tenant}`, images: [], variants: [{ images: [] }]
          } }
        });
        assert.equal(saved.status, 200, `${person}: ${JSON.stringify(saved.data)}`);
        const own = (await fixture.query('SELECT tenant_id,created_by_person_id,parent_draft_id,source_product_id,template_id FROM listing_drafts WHERE id=?', [saved.data.id]))[0];
        assert.equal(own.tenant_id, key); assert.equal(Number(own.created_by_person_id), person);
        assert.equal(Number(own.parent_draft_id), 9000 + tenant); assert.equal(Number(own.source_product_id), tenant * 10);
        const template = (await fixture.query('SELECT tenant_id,created_by_person_id FROM listing_category_templates WHERE id=?', [own.template_id]))[0];
        assert.equal(template.tenant_id, key); assert.equal(Number(template.created_by_person_id), person);
      }
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_drafts'))[0].n), beforeDrafts + 3);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_category_templates'))[0].n), beforeTemplates + 3);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_publish_records'))[0].n), 0);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM tenant_ai_usage'))[0].n), 0);
    });
    await t.test('material batch list/detail/retry remain enterprise scoped and cannot enqueue validation requests', async () => {
      for (const [person, tenant] of [[6,1],[7,2],[8,3]]) {
        const key = tenant === 1 ? 'admin' : String(tenant);
        await fixture.query(`INSERT INTO ai_material_optimization_batches
          (tenant_id,batch_no,status,total_count,success_count,created_by_person_id) VALUES(?,?,'success',1,1,?)`,
        [key,`HTTP-MAT-${tenant}`,person]);
        await fixture.query(`INSERT INTO ai_material_optimization_items
          (tenant_id,item_no,batch_no,source_draft_id,status,source_title,created_by_person_id)
          VALUES(?,?,?,?,'success',?,?)`, [key,`HTTP-MAT-ITEM-${tenant}`,`HTTP-MAT-${tenant}`,9000 + tenant,`Private material ${tenant}`,person]);
      }
      for (const [person, tenant] of [[6,1],[7,2],[8,3]]) {
        const operator = await login(person), foreign = tenant === 2 ? 3 : 2;
        const list = await request('/api/ai-material-optimization/batches?tenant_id=forged', operator.token);
        assert.equal(list.status, 200, JSON.stringify(list.data));
        assert.deepEqual(list.data.map(batch => batch.batch_no), [`HTTP-MAT-${tenant}`]);
        const detail = await request(`/api/ai-material-optimization/batches/HTTP-MAT-${tenant}`, operator.token);
        assert.equal(detail.status, 200, JSON.stringify(detail.data));
        assert.ok(JSON.stringify(detail.data).includes(`Private material ${tenant}`));
        const other = await request(`/api/ai-material-optimization/batches/HTTP-MAT-${foreign}`, operator.token);
        assert.equal(other.status, 404);
        assert.ok(!JSON.stringify(other.data).includes(`Private material ${foreign}`));
        for (const [item, status] of [[tenant,409],[foreign,404]]) {
          const retry = await request(`/api/ai-material-optimization/items/HTTP-MAT-ITEM-${item}/retry`, operator.token, 'POST', { tenant_id: foreign });
          assert.equal(retry.status, status, JSON.stringify(retry.data));
        }
        const empty = await request('/api/ai-material-optimization/batches', operator.token, 'POST', {});
        assert.equal(empty.status, 400);
        const deniedDraft = 9000 + foreign;
        const foreignCreate = await request('/api/ai-material-optimization/batches', operator.token, 'POST', {
          draftIds: [deniedDraft], items: [{ draftId: deniedDraft, operatorFacts: { product_title_zh: '汽车配件',
            selling_points_zh: ['保护外壳','安装方便'], confirmed_by_operator: true } }]
        });
        assert.equal(foreignCreate.status, 404, JSON.stringify(foreignCreate.data));
        for (const [url, method] of [[`/api/ai-material-optimization/batches/HTTP-MAT-${tenant}`, 'POST'],
          [`/api/ai-material-optimization/items/HTTP-MAT-ITEM-${tenant}/retry`, 'PUT']]) {
          const blocked = await request(url, operator.token, method, {});
          assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'TENANT_ISOLATION_PENDING');
        }
      }
      for (const [url, method, body] of [
        ['/api/ai-material-optimization/batches', 'GET'], ['/api/ai-material-optimization/batches', 'POST', {}],
        ['/api/ai-material-optimization/batches/HTTP-MAT-1', 'GET'], ['/api/ai-material-optimization/items/HTTP-MAT-ITEM-1/retry', 'POST', {}]
      ]) {
        assert.equal((await request(url, sessions.get(4).token, method, body)).status, 403);
      }
      assert.equal(Number((await fixture.query("SELECT COUNT(*) n FROM ai_material_optimization_items WHERE status <> 'success'"))[0].n), 0);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM ai_material_optimization_batches'))[0].n), 3);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM tenant_ai_usage'))[0].n), 0);
    });
    await t.test('matrix ordinary operations reject foreign source/shop/variant before saving jobs or publishing', async () => {
      // Read initializes the actual matrix schema; only fixture seeding writes
      // variants, while all HTTP generation/publication attempts are rejected.
      const seeded = await login(6);
      assert.equal((await request('/api/asset-variant-engine/jobs', seeded.token)).status, 200);
      for (const [person, tenant] of [[6,1],[7,2],[8,3]]) {
        await fixture.query('INSERT INTO asset_variants(id,batch_id,shop_id,created_by_person_id) VALUES(?,?,?,?)',
          [9100 + tenant,`HTTP-MATRIX-${tenant}`,tenant * 10,person]);
      }
      const jobsBefore = Number((await fixture.query('SELECT COUNT(*) n FROM asset_variant_jobs'))[0].n);
      const recordsBefore = Number((await fixture.query('SELECT COUNT(*) n FROM listing_publish_records'))[0].n);
      for (const [person, tenant] of [[6,1],[7,2],[8,3]]) {
        const operator = await login(person), foreign = tenant === 2 ? 3 : 2;
        const product = await request(`/api/asset-variant-engine/selection-publish-shops?productId=${foreign * 10}`, operator.token);
        assert.equal(product.status, 404, JSON.stringify(product.data));
        const material = { title: 'Protected fixture', mainImage: 'https://must-not-fetch.invalid/main.jpg', sourceProductId: foreign * 10 };
        for (const action of ['generate','generate-async']) {
          const result = await request(`/api/asset-variant-engine/${action}`, operator.token, 'POST', { material, shopIds: [tenant * 10] });
          assert.equal(result.status, 404, `${action}: ${JSON.stringify(result.data)}`);
        }
        for (const action of ['generate','generate-async','publish-selection']) {
          const result = await request(`/api/asset-variant-engine/${action}`, operator.token, 'POST', {
            productId: tenant * 10, material: { ...material, sourceProductId: tenant * 10 }, shopIds: [foreign * 10]
          });
          assert.equal(result.status, 403, `${action}: ${JSON.stringify(result.data)}`);
          assert.notEqual(result.data.code, 'TENANT_ISOLATION_PENDING');
        }
        for (const action of ['title-preview','generate-video','register-richtext-image']) {
          const result = await request(`/api/asset-variant-engine/${action}`, operator.token, 'POST', {
            material: { ...material, sourceProductId: tenant * 10 }, shopId: foreign * 10,
            imageUrl: 'https://must-not-fetch.invalid/source.jpg', source: 'https://must-not-fetch.invalid/source.jpg'
          });
          assert.equal(result.status, 403, `${action}: ${JSON.stringify(result.data)}`);
          assert.notEqual(result.data.code, 'TENANT_ISOLATION_PENDING');
        }
        for (const action of ['import-listing-automation','publish-to-ozon']) {
          const result = await request(`/api/asset-variant-engine/${action}`, operator.token, 'POST', { variantIds: [9100 + foreign] });
          assert.equal(result.status, 404, JSON.stringify(result.data));
        }
        const nestedFile = await request('/api/asset-variant-engine/files/not-a-batch/shop/images/main.jpg', operator.token);
        assert.equal(nestedFile.status, 404);
        for (const [url, method] of [['/api/asset-variant-engine/generate/extra','POST'],['/api/asset-variant-engine/generate','PUT']]) {
          const blocked = await request(url, operator.token, method, {});
          assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'TENANT_ISOLATION_PENDING');
        }
      }
      for (const action of ['generate','generate-async','publish-selection','title-preview','generate-video','register-richtext-image','import-listing-automation','publish-to-ozon']) {
        const result = await request(`/api/asset-variant-engine/${action}`, sessions.get(4).token, 'POST', {});
        assert.equal(result.status, 403); assert.notEqual(result.data.code, 'TENANT_ISOLATION_PENDING');
      }
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM asset_variant_jobs'))[0].n), jobsBefore);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_publish_records'))[0].n), recordsBefore);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM tenant_ai_usage'))[0].n), 0);
    });
    await t.test('matrix ordinary default/A/B import persists owned drafts and reuses them without provider calls', async () => {
      const beforeDrafts = Number((await fixture.query('SELECT COUNT(*) n FROM listing_drafts'))[0].n);
      const beforeTemplates = Number((await fixture.query('SELECT COUNT(*) n FROM listing_category_templates'))[0].n);
      const beforeCopies = Number((await fixture.query('SELECT COUNT(*) n FROM listing_shop_copies'))[0].n);
      for (const [person, tenant] of [[6,1],[7,2],[8,3]]) {
        const key = tenant === 1 ? 'admin' : String(tenant), variantId = 9100 + tenant;
        // A completed copy description and an intentionally empty image set
        // save an incomplete draft without remote media, video or paid AI work.
        await fixture.query(`UPDATE asset_variants SET source_product_id=?, source_title=?, variant_title=?,
          description_text=?, tags_json='[]', images_json='[]', output_dir='' WHERE id=?`,
        [tenant * 10, `Защитный чехол ${tenant}`, `Защитный чехол ${tenant}`,
          'Защитный чехол для автомобильного ключа из прочного материала для ежедневного использования', variantId]);
        const operator = await login(person);
        const input = { variantIds: [variantId], tenant_id: tenant === 2 ? 3 : 2, created_by_person_id: 1 };
        const imported = await request('/api/asset-variant-engine/import-listing-automation', operator.token, 'POST', input);
        assert.equal(imported.status, 200, `${person}: ${JSON.stringify(imported.data)}`);
        assert.equal(imported.data.imported, 1);
        const saved = imported.data.drafts[0];
        assert.equal(Number(saved.variantId), variantId); assert.equal(Number(saved.shopId), tenant * 10);
        const draft = (await fixture.query('SELECT tenant_id,created_by_person_id,template_id,manual_facts_json FROM listing_drafts WHERE id=?', [saved.draftId]))[0];
        assert.equal(draft.tenant_id, key); assert.equal(Number(draft.created_by_person_id), person);
        assert.equal(Number(JSON.parse(draft.manual_facts_json).asset_variant_id), variantId);
        const template = (await fixture.query('SELECT tenant_id,created_by_person_id FROM listing_category_templates WHERE id=?', [draft.template_id]))[0];
        assert.equal(template.tenant_id, key); assert.equal(Number(template.created_by_person_id), person);
        const copy = (await fixture.query('SELECT tenant_id,created_by_person_id,shop_id,source_product_id FROM listing_shop_copies WHERE draft_id=?', [saved.draftId]))[0];
        assert.equal(copy.tenant_id, key); assert.equal(Number(copy.created_by_person_id), person);
        assert.equal(Number(copy.shop_id), tenant * 10); assert.equal(Number(copy.source_product_id), tenant * 10);
        const repeated = await request('/api/asset-variant-engine/import-listing-automation', operator.token, 'POST', input);
        assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
        assert.equal(Number(repeated.data.drafts[0].draftId), Number(saved.draftId));
        assert.equal(repeated.data.drafts[0].reused, true);
      }
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_drafts'))[0].n), beforeDrafts + 3);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_category_templates'))[0].n), beforeTemplates + 3);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_shop_copies'))[0].n), beforeCopies + 3);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM listing_publish_records'))[0].n), 0);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM tenant_ai_usage'))[0].n), 0);
    });
    await t.test('image proxy refuses private network and metadata URLs before fetching or using cache', async () => {
      for (const target of [`${base}/uploads/team-attachments/private.png`, 'http://169.254.169.254/private.png', 'http://[::1]/private.png']) {
        const response = await request('/api/image-proxy?url=' + encodeURIComponent(target));
        assert.equal(response.status, 400);
      }
    });
    await t.test('real attachment upload and downloads require current enterprise for GET and HEAD', async () => {
      const form = new FormData();
      form.set('file', new Blob(['A enterprise private receipt'], { type: 'text/plain' }), 'receipt.txt');
      const uploaded = await fetch(`${base}/api/team/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${sessions.get(2).token}` }, body: form });
      assert.equal(uploaded.status, 200);
      const body = await uploaded.json();
      assert.equal(body.ok, true, body.error);
      attachmentUrl = body.url;
      const own = await fetch(base + attachmentUrl, { headers: { Authorization: `Bearer ${sessions.get(2).token}` } });
      assert.equal(own.status, 200);
      assert.equal(await own.text(), 'A enterprise private receipt');
      assert.match(own.headers.get('cache-control'), /no-store/);
      for (const method of ['GET','HEAD']) {
        const foreign = await fetch(base + attachmentUrl, { method, headers: { Authorization: `Bearer ${sessions.get(3).token}`, Range: 'bytes=0-12' } });
        assert.equal(foreign.status, 404);
        assert.notEqual(await foreign.text(), 'A enterprise private receipt');
      }
      const head = await fetch(base + attachmentUrl, { method: 'HEAD', headers: { Authorization: `Bearer ${sessions.get(2).token}` } });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      const anonymous = await fetch(base + attachmentUrl);
      assert.ok([401,403].includes(anonymous.status));
    });
    await t.test('restart preserves existing sessions and tenant ownership', async () => {
      await stop(); await start();
      for (const id of [1, 2, 3, 4]) {
        const response = await request('/api/orders?paged=1&includeRows=0', sessions.get(id).token);
        assert.equal(response.status, 200, JSON.stringify(response.data));
        assert.equal(Number(response.data.total), 1);
      }
      const restoredFile = await fetch(base + attachmentUrl, { headers: { Authorization: `Bearer ${sessions.get(2).token}` } });
      assert.equal(restoredFile.status, 200);
      assert.equal(await restoredFile.text(), 'A enterprise private receipt');
      await fixture.query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      const revoked = await request('/api/orders?paged=1', sessions.get(2).token);
      assert.ok([401, 403].includes(revoked.status));
    });
  } finally {
    await stop();
    await fixture.cleanup();
    const absolute = path.resolve(directory), intended = path.resolve(os.tmpdir()) + path.sep;
    if (!absolute.startsWith(intended) || !path.basename(absolute).startsWith('ozon-http-pilot-')) throw new Error('Unexpected fixture cleanup directory');
    await rm(absolute, { recursive: true, force: true });
  }
});
