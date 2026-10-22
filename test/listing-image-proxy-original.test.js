import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { json, writeHead } from '../src/http/response.js';
import { resolvePublicImageTarget } from '../src/http/public-image-request.js';
import { isPrivateImageRead } from '../src/server/tenant-isolation.js';
import { businessTaskTenantKey } from '../src/services/business-task-tenant.js';

// Exercise the real server handlers without importing the HTTP listener or DB.
const serverSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source boundary: ${start}`);
  return source.slice(from, to).replace(/^export /, '');
}
const proxySource = [
  sourceBetween(serverSource, 'function sendImagePlaceholder(', 'function imageProxyCacheKey('),
  sourceBetween(serverSource, 'function sendRemoteImageBuffer(', 'async function fetchRemoteImagePayload('),
  sourceBetween(serverSource, 'async function sendRemoteImage(', 'const server = http.createServer(')
].join('\n');
const original = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x42]), contentType: 'image/jpeg' };
const target = 'https://images.example/product.jpg';

function harness({ fresh = null, stale = null, failure = false, result = null, error = null,
  addresses = [{ address: '8.8.8.8', family: 4 }] } = {}) {
  const calls = { reads: [], fetches: [], writes: [] };
  const failureCache = new Map(failure ? [[target, Date.now() + 60000]] : []);
  const inflight = new Map();
  const context = vm.createContext({
    Buffer, Date, console, json, writeHead,
    IMAGE_PROXY_BROWSER_CACHE_SECONDS: 3600,
    IMAGE_PROXY_FAILURE_TTL_MS: 60000,
    imageProxyFailureCache: failureCache,
    imageProxyInflight: inflight,
    resolvePublicImageTarget: value => resolvePublicImageTarget(value, async () => addresses),
    readCachedRemoteImage: async (value, options) => {
      calls.reads.push({ value, allowStale: options?.allowStale === true });
      return options?.allowStale ? stale : fresh;
    },
    fetchRemoteImagePayload: async value => {
      calls.fetches.push(value);
      if (error) throw error;
      return result;
    },
    writeCachedRemoteImage: async (value, payload) => { calls.writes.push({ value, payload }); }
  });
  vm.runInContext(proxySource, context, { filename: 'server-image-proxy-handlers.js' });
  return {
    calls, failureCache, inflight,
    async run({ strict = false, imageUrl = target } = {}) {
      const req = new EventEmitter();
      const res = Object.assign(new EventEmitter(), {
        writableEnded: false, destroyed: false, statusCode: 0, headers: {}, body: null,
        writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
        end(body) { this.body = Buffer.from(body); this.writableEnded = true; }
      });
      const url = new URL('http://unit.invalid/api/image-proxy');
      url.searchParams.set('url', imageUrl);
      if (strict) url.searchParams.set('require_original', '1');
      await context.sendRemoteImage(req, res, url);
      assert.equal(req.listenerCount('aborted'), 0);
      assert.equal(res.listenerCount('close'), 0);
      return res;
    }
  };
}

for (const [branch, options] of [
  ['failure cache', { failure: true }],
  ['empty upstream payload', { result: null }],
  ['upstream rejection', { error: new Error('fixture upstream failure') }]
]) {
  test(`ordinary image display preserves the 200 placeholder after ${branch}`, async () => {
    const h = harness(options);
    const res = await h.run();
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /^image\/svg\+xml/);
    assert.equal(res.headers['X-Image-Proxy-Cache'], 'PLACEHOLDER');
    assert.match(res.body.toString(), /<svg[^>]*>[\s\S]*NO IMG/);
    assert.equal(h.inflight.size, 0);
  });

  test(`strict originals reject ${branch} even when a stale image exists`, async () => {
    const h = harness({ ...options, stale: original });
    const res = await h.run({ strict: true });
    assert.equal(res.statusCode, 502);
    assert.match(res.headers['Content-Type'], /^application\/json/);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Image-Proxy-Cache'], undefined);
    assert.equal(typeof JSON.parse(res.body).error, 'string');
    assert.doesNotMatch(res.body.toString(), /<svg|NO IMG/);
    assert.notDeepEqual(res.body, original.buffer);
    assert.equal(h.calls.reads.some(read => read.allowStale), false);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.inflight.size, 0);
    if (branch === 'failure cache') assert.equal(h.calls.fetches.length, 0);
  });
}

test('strict mode accepts fresh original cache hits without fetching or rewriting', async () => {
  const h = harness({ fresh: original, failure: true });
  const res = await h.run({ strict: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-Image-Proxy-Cache'], 'HIT');
  assert.equal(res.headers['Content-Type'], 'image/jpeg');
  assert.deepEqual(res.body, original.buffer);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.calls.writes.length, 0);
});

test('strict mode accepts upstream originals and caches only the original payload', async () => {
  const h = harness({ result: original });
  const res = await h.run({ strict: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-Image-Proxy-Cache'], 'MISS');
  assert.deepEqual(res.body, original.buffer);
  assert.deepEqual(h.calls.fetches, [target]);
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].payload, original);
  assert.equal(h.failureCache.size, 0);
  assert.equal(h.inflight.size, 0);
  assert.match(res.headers['Content-Security-Policy'], /sandbox; default-src 'none'/);
});

for (const strict of [false, true]) {
  test(`public target validation precedes cache/network in ${strict ? 'strict' : 'display'} mode`, async () => {
    for (const addresses of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]
    ]) {
      const h = harness({ fresh: original, result: original, addresses });
      const res = await h.run({ strict });
      assert.equal(res.statusCode, 400);
      assert.match(res.headers['Content-Type'], /^application\/json/);
      assert.equal(h.calls.reads.length, 0);
      assert.equal(h.calls.fetches.length, 0);
    }
    for (const imageUrl of ['http://127.0.0.1/api/ai/file/task/generated/private.jpg', '/api/ai/file/task/generated/private.jpg']) {
      const h = harness({ fresh: original, result: original });
      const res = await h.run({ strict, imageUrl });
      assert.equal(res.statusCode, 400);
      assert.equal(h.calls.reads.length, 0);
      assert.equal(h.calls.fetches.length, 0);
    }
  });
}

test('strict query flag preserves private route classification and real AI task owner checks', async () => {
  const ownershipSource = readFileSync(new URL('../src/services/ai-image-task-ownership.js', import.meta.url), 'utf8');
  const privateSource = sourceBetween(serverSource, 'async function resolveAiImageFile(', 'function sendImagePlaceholder(');
  let ownerReads = 0;
  const context = vm.createContext({
    businessTaskTenantKey,
    // Authorization/DB are fixtures; the actual owner predicate and resolver run unchanged.
    authorizeBusinessTaskSession: async session => session,
    ensureSchema: async () => {},
    mysqlQuery: async () => { ownerReads += 1; return [{ tenant_id: '21' }]; }
  });
  vm.runInContext(ownershipSource.slice(ownershipSource.indexOf('export async function assertAiImageTaskOwner(')).replace(/^export /, ''), context);
  context.getAiTaskFile = async (taskId, scope, filename, session) => {
    await context.assertAiImageTaskOwner(taskId, session);
    return { taskId, scope, filename, session };
  };
  vm.runInContext(privateSource, context);
  const owner = { personId: 1, tenant: { id: 21, slug: 'customer-a' } };
  const foreign = { personId: 2, tenant: { id: 22, slug: 'customer-b' } };
  for (const suffix of ['', '?require_original=1']) {
    const url = new URL(`/api/ai/file/task/generated/private.jpg${suffix}`, 'http://unit.invalid');
    assert.equal(isPrivateImageRead({ method: 'GET', url: url.href }, url.pathname.split('/').filter(Boolean)), true);
    const file = await context.resolveAiImageFile(url.pathname, owner);
    assert.equal(file.session, owner);
    await assert.rejects(context.resolveAiImageFile(url.pathname, foreign), error => error.status === 404);
  }
  assert.equal(ownerReads, 4);
});
