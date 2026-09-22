import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url),'utf8');
test('inventory deletion hides a SKU-bound product without erasing its history', async () => {
  const product = {id:1,active:1,product_type:'main',selection_status:'listed',bound_skus:2};
  let invalidations=0;
  const context=vm.createContext({
    ensureMysqlCutoverEnabled(){},
    mysqlQueryOne:async()=>product.active ? {id:1}:null,
    mysqlExecute:async(sql,params)=>{
      assert.match(sql,/UPDATE products SET active = 0/);
      assert.equal(params[0],1);product.active=0;
    },
    invalidateMasterDataCache(){invalidations++;}
  });
  vm.runInContext(source.slice(source.indexOf('export async function deleteProductMysql('),source.indexOf('export async function restoreProductMysql(')).replaceAll('export ',''),context);
  await context.removeProductFromInventoryMysql(1);
  assert.equal(product.active,0);
  assert.equal(product.product_type,'main');
  assert.equal(product.bound_skus,2);
  assert.equal(invalidations,1);
  await assert.rejects(context.removeProductFromInventoryMysql(1),/不存在或已隐藏/);
});
