import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {parse} from 'acorn';import vm from 'node:vm';
const s=readFileSync(new URL('../frontend/admin/views/listing/ListingAutomationView.vue',import.meta.url),'utf8').split('<script setup>')[1].split('</script>')[0];
const tree=parse(s,{ecmaVersion:'latest',sourceType:'module'});
function fn(name){const n=tree.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert.ok(n);return s.slice(n.start,n.end)}
test('collector preview route skips local draft restoration and unrelated workbench collection requests',async()=>{
 const requests=[],applied=[],preview={preview_only:true,id:null,images:[{url:'https://fixture.invalid/a.jpg'}]};
 const context=vm.createContext({Boolean,String,Number,Array,Promise,encodeURIComponent,
 route:{query:{collectorPreview:'1',collectorSku:'fixture'}},collectorSourceSku:{value:'fixture'},routeDraftIds:{value:[]},
 loading:{value:false},state:{templates:[],drafts:[],shops:[]},copyForm:{},hasListingBootstrapParams:()=>true,hasSavedListingWorkbenchDraft:()=>true,
 restoreListingWorkbenchDraft:()=>{throw Error('stale local draft restored')},loadShopDictionary:async()=>[],
 apiClient:{post:async(path,body)=>{requests.push({path,body});return{template:preview}},get:async()=>{throw Error('unrelated list request')}},
 handleListingApiMissing:e=>{throw e},handlePublishRecordRouteMissing:e=>{throw e},
 applyTemplateFromRoute:async(template,options)=>applied.push({template,options}),applyListingDraftFromRoute:async()=>{},applyRecordDraftFromRoute:async()=>{},applyPublishRecordFromRoute:async()=>{},
 loadListingWorkbenchCollections:()=>{throw Error('unrelated workbench collections')}
 });vm.runInContext(fn('loadAll'),context);await context.loadAll();
 assert.equal(requests.length,1);assert.equal(requests[0].body.previewOnly,true);assert.equal(applied[0].template,preview);assert.equal(applied[0].options.safeOpen,true);assert.equal(context.loading.value,false);
});
test('preview hydrates the editor without inventing a persistent template ID',async()=>{
 let filled;const c=vm.createContext({Boolean,Number,route:{query:{collectorPreview:'1'}},collectorTemplateApplied:{value:false},templateEditor:{id:null},draftForm:{},state:{templates:[]},fillTemplateEditor:(p,o)=>filled={p,o},hydrateLoadedCategorySchema:async()=>{},ElMessage:{success:()=>{}}});
 vm.runInContext(fn('applyTemplateFromRoute'),c);const preview={id:null,preview_only:true};await c.applyTemplateFromRoute(preview,{safeOpen:true});assert.equal(filled.p,preview);assert.equal(c.draftForm.template_id,null);assert.equal(c.collectorTemplateApplied.value,true);
});

test('a preview request that reuses an existing template still fills the editor',async()=>{
 let filled;const c=vm.createContext({Boolean,Number,route:{query:{collectorPreview:'1'}},collectorTemplateApplied:{value:false},templateEditor:{id:null},draftForm:{},state:{templates:[]},fillTemplateEditor:p=>filled=p,hydrateLoadedCategorySchema:async()=>{},ElMessage:{success:()=>{}}});
 vm.runInContext(fn('applyTemplateFromRoute'),c);await c.applyTemplateFromRoute({id:42});assert.equal(filled.id,42);assert.equal(c.draftForm.template_id,42);
});
