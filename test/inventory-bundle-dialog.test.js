import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import {ElDialog} from 'element-plus';
import {renderToString} from '@vue/server-renderer';

// Match production: no global Element Plus component registration. Inspect the
// rendered component boundary before mounting children or running inventory IO.
function dialog(file){
 const {descriptor}=parse(fs.readFileSync(new URL(`../frontend/admin/components/inventory/${file}`,import.meta.url),'utf8'));
 const script=compileScript(descriptor,{id:'bundle-dialog-regression',inlineTemplate:true});
 const code=script.content.replace(/import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2;?/g,(_,bindings,_quote,id)=>`const ${bindings.trim().startsWith('{')?bindings.replace(/\bas\b/g,':'):bindings.trim()}=require(${JSON.stringify(id)});`).replace(/export\s+default/,'module.exports.default =');
 const MobileDialog={name:'MobileDialog'},Child={name:'InventoryChild'},module={exports:{}};
 vm.runInNewContext(code,{module,require(id){if(id==='vue')return vue;if(id==='element-plus')return{ElDialog};if(id.endsWith('MobileDialog.vue'))return MobileDialog;if(id.endsWith('.vue'))return Child;throw Error(id);}});
 return{definition:module.exports.default,MobileDialog};
}
for(const file of ['InventoryBundleDialog.vue','InventoryBundleConversionDialog.vue']){
 test(`${file} resolves the desktop modal without global registration and preserves mobile routing`,async()=>{
  const {definition,MobileDialog}=dialog(file);
  for(const mobile of [false,true]){
   let boundary;
   const app=vue.createSSRApp({setup(){const render=definition.setup({modelValue:true,productId:200,mobile},{emit(){},expose(){}});return()=>{boundary=render({},[]);return null;};}});
   app.component('el-button',{render:()=>null});
   await renderToString(app);
   assert.equal(boundary.type,mobile?MobileDialog:ElDialog,'must bind the component object, never emit an unresolved el-dialog HTML tag');
   assert.equal(boundary.props['append-to-body'],'');
   assert.equal(boundary.props['close-on-click-modal'],false);
   assert.equal(boundary.props['model-value'],true);
  }
 });
}
