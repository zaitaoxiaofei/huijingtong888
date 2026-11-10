import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const functionSource = source.slice(source.indexOf('export function normalizeShopPayoutRate('), source.indexOf('export async function createShopMysql(')).replace('export ', '');
const normalize = vm.runInNewContext(`${functionSource};normalizeShopPayoutRate`);
test('new shop commission defaults to zero and preserves explicit zero and existing ratios', () => {
  for (const value of [undefined, null, '', 0, '0']) assert.equal(normalize(value), 0);
  assert.equal(normalize('0.33'), 0.33);
  assert.equal(normalize(1), 1);
  for (const value of [-0.01, 1.01, 'no', Infinity]) assert.throws(() => normalize(value), /0% 至 100%/);
});
test('shop updates preserve omitted commission and new notes never become credentials', () => {
  const create = source.slice(source.indexOf('export async function createShopMysql('), source.indexOf('export async function updateShopMysql('));
  const update = source.slice(source.indexOf('export async function updateShopMysql('), source.indexOf('export async function updateShopMysql(') + 5500);
  assert.match(create, /normalizeShopPayoutRate\(body.payout_rate\)/);
  assert.match(update, /normalizeShopPayoutRate\(body.payout_rate \?\? existing.payout_rate\)/);
  assert.doesNotMatch(create, /body.ozon_api_key \|\| body.api_key_hint/);
  assert.doesNotMatch(update, /body.ozon_api_key[^\n]*\|\| body.api_key_hint/);
});
