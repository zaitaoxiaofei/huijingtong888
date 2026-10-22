import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { requestPublicMediaStream } from '../src/http/public-image-request.js';
const address = { address: '8.8.8.8', family: 4 };
const resolve = async () => [address];
const response = (statusCode = 200, headers = {}) => Object.assign(Readable.from([Buffer.from('image'), Buffer.from('-bytes')]), { statusCode, headers });

test('streaming media pins a public DNS result and preserves the bounded caller stream', async t => {
  let calls = 0;
  t.mock.method(https, 'get', (url, options, callback) => {
    calls++; assert.equal(url.hostname, 'cdn.example'); assert.equal(options.agent, false);
    options.lookup(url.hostname, {}, (error, ip, family) => { assert.equal(error, null); assert.equal(ip, address.address); assert.equal(family, 4); });
    queueMicrotask(() => callback(response(200, { 'content-type': 'image/jpeg', 'content-length': '11' })));
    return new EventEmitter();
  });
  const result = await requestPublicMediaStream('https://cdn.example/a.jpg', { resolve });
  assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(result.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(await new Response(result.body).text(), 'image-bytes');
});

test('streaming media rejects private targets and redirect rebinding before the unsafe connection', async t => {
  let calls = 0;
  t.mock.method(https, 'get', (_url, _options, callback) => {
    calls++; queueMicrotask(() => callback(response(302, { location: 'https://127.0.0.1/private' })));
    return new EventEmitter();
  });
  await assert.rejects(requestPublicMediaStream('https://127.0.0.1/private'), /private network/);
  assert.equal(calls, 0);
  await assert.rejects(requestPublicMediaStream('https://cdn.example/a.jpg', { resolve }), /private network/);
  assert.equal(calls, 1);
});

test('streaming media checks fresh authorization before DNS, connection and returned headers', async t => {
  let lookups = 0, calls = 0, checks = 0;
  const dns = async () => { lookups++; return [address]; };
  t.mock.method(https, 'get', (_url, _options, callback) => {
    calls++; queueMicrotask(() => callback(response())); return new EventEmitter();
  });
  for (const rejectedCheck of [1, 2, 3]) {
    checks = 0;
    await assert.rejects(requestPublicMediaStream('https://cdn.example/a.jpg', { resolve: dns,
      beforeRequest: async () => { if (++checks === rejectedCheck) throw new Error('revoked'); } }), /revoked/);
  }
  assert.equal(lookups, 2); assert.equal(calls, 1);
});

test('cancelled streaming requests stop before DNS', async () => {
  let lookups = 0;
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(requestPublicMediaStream('https://cdn.example/a.jpg', { signal: controller.signal,
    resolve: async () => { lookups++; return [address]; } }), /cancelled/);
  assert.equal(lookups, 0);
});
