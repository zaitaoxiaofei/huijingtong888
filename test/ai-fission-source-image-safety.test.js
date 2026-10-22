import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { requestPublicImage, resolvePublicImageTarget } from '../src/http/public-image-request.js';

const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const workflow = source('src/server/services/ai/aiWorkflowService.js');
const lab = source('src/services/ai-variant-lab.js');
function imageReader(request = requestPublicImage) {
  const context = vm.createContext({ requestPublicImage: request, Response, AbortSignal, URL,
    AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS: 20000 });
  vm.runInContext(workflow.slice(workflow.indexOf('async function fetchSourceImageResponse('),
    workflow.indexOf('function normalizeFetchableSourceUrl(')), context);
  return context.fetchSourceImageResponse;
}

test('fission source images reject loopback and metadata URLs before any network request', async () => {
  for (const url of ['http://127.0.0.1/private', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/private', 'http://user:pass@8.8.8.8/a.png', 'http://8.8.8.8:3000/a.png']) {
    await assert.rejects(imageReader()(url));
  }
});

test('public draft image retry preserves browser headers and limits decoded download size', async () => {
  const calls = [];
  const read = imageReader(async (url, options) => {
    calls.push({ url, ...options });
    return calls.length === 1 ? null : { buffer: Buffer.from('image'), contentType: 'image/png' };
  });
  const response = await read('https://cdn.ozon.ru/product.png');
  assert.equal(await response.text(), 'image');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.maxBytes === 20 * 1024 * 1024 && call.signal instanceof AbortSignal));
  assert.ok(calls.every(call => call.headers['User-Agent'].startsWith('Mozilla/')));
  assert.equal(calls[0].headers.Referer, undefined);
  assert.equal(calls[1].headers.Referer, 'https://www.ozon.ru/');
  await assert.rejects(imageReader(async () => null)('https://example.com/not-an-image'), { status: 400 });
});

test('fission recognition rejects private URLs and preserves uploaded data images', async () => {
  const context = vm.createContext({ resolvePublicImageTarget,
    resolveLocalPublicImageFile: () => '', statusError: (message, status) => Object.assign(new Error(message), { status }) });
  vm.runInContext(lab.slice(lab.indexOf('async function resolveImageUrl('),
    lab.indexOf('async function resolveOptimizerImageInputs(')), context);
  await assert.rejects(context.resolveImageUrl({ imageUrl: 'http://169.254.169.254/latest/meta-data/' }), { status: 400 });
  const data = 'data:image/png;base64,AA==';
  assert.equal(await context.resolveImageUrl({ imageDataUrl: data }), data);
});
