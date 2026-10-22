import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import { isPublicImageAddress, resolvePublicImageTarget, requestPublicImage } from '../src/http/public-image-request.js';

test('remote image connections reject private, mapped and metadata network addresses', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2002:7f00:1::']) {
    assert.equal(isPublicImageAddress(address), false, address);
    await assert.rejects(resolvePublicImageTarget(`http://${address.includes(':') ? `[${address}]` : address}/private.png`));
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicImageAddress(address), true);
});

test('proxied and product images cannot execute an SVG script on the ERP origin',()=>{
  const source=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const product=source.slice(source.indexOf('async function sendProductImage('),source.indexOf('async function resolveAiImageFile('));
  const proxy=source.slice(source.indexOf('function sendRemoteImageBuffer('),source.indexOf('async function fetchRemoteImagePayload('));
  for(const handler of [product,proxy]) {
    assert.match(handler,/Content-Security-Policy/);
    assert.match(handler,/sandbox; default-src 'none'/);
    assert.match(handler,/nosniff/);
  }
});

test('DNS is fully checked and the selected public address is returned for connection pinning', async () => {
  const publicAddress = { address: '8.8.8.8', family: 4 };
  const resolved = await resolvePublicImageTarget('https://image.example/file.png', async () => [publicAddress]);
  assert.deepEqual(resolved.address, publicAddress);
  await assert.rejects(resolvePublicImageTarget('https://image.example/file.png', async () => [publicAddress, { address: '127.0.0.1', family: 4 }]));
  for (const url of ['file:///private.png', 'https://user:password@image.example/file.png', 'http://image.example:3000/file.png']) await assert.rejects(resolvePublicImageTarget(url));
  // No local listener or production socket is probed when DNS resolves privately.
  await assert.rejects(requestPublicImage('https://image.example/private.png', { maxBytes: 100, resolve: async () => [{ address: '127.0.0.1', family: 4 }] }));
});

test('fresh authorization rejects before DNS and again before the validated connection', async () => {
  let lookups = 0;
  const resolve = async () => { lookups += 1; return [{ address: '8.8.8.8', family: 4 }]; };
  await assert.rejects(requestPublicImage('https://image.example/file.png', {
    maxBytes: 100, resolve, beforeRequest: async () => { throw new Error('revoked before DNS'); }
  }), /revoked before DNS/);
  assert.equal(lookups, 0);
  let checks = 0;
  await assert.rejects(requestPublicImage('https://image.example/file.png', {
    maxBytes: 100, resolve, beforeRequest: async () => { if (++checks === 2) throw new Error('revoked during DNS'); }
  }), /revoked during DNS/);
  assert.equal(checks, 2);
  assert.equal(lookups, 1);
});
